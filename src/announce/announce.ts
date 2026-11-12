import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Hub } from '../hub/hub.js';
import type { StoredRecord } from '../store/records.js';
import type { ProblemBody } from '../work/problems.js';
import { scrub } from '../privacy/scrub.js';
import { starterOperators } from '../seed/starter-operators.js';
import { KeyVault } from '../contributor/keyvault.js';
import { Keeper } from '../hub/keeper.js';
import { atomFeed, postBluesky, postMastodon, xIntent, type Fetch, type SinkName } from './sinks.js';

/**
 * The announcer (docs/ANNOUNCE.md): tells people when lent computers make progress that a machine has checked, with
 * a call to lend one. It runs on the owner's computer, reads only what this computer has verified itself
 * (`Problems.state`, which re-runs every machine check before believing a checkpoint), and never says more than
 * that: a machine checked it and no person has reviewed it yet.
 *
 * Two tiers. **Founder**: possible finds on open searches, problems from public catalogues, problems this computer
 * doesn't vouch for, and "a whole problem is done" wait for the owner's `announce approve`. **Auto**: the first
 * checked step on a problem this computer or the starter library proposed, and the weekly digest; these go on their
 * own only when the owner turns automatic posting on. Nothing leaves this computer until
 * `constellate announce send --yes`, and the only destination set up by default is a feed file on this computer.
 */
export interface AnnounceConfig {
  auto: boolean;
  feed: boolean;
  bluesky?: { handle: string; service?: string };
  mastodon?: { instance: string };
  cta?: string;
}
export const DEFAULT_CTA = 'https://github.com/nkoteskey/Constellate';
/** X's limit, the tightest of the three (Bluesky allows 300 graphemes, Mastodon 500 characters). */
export const POST_LIMIT = 280;
const TOY = new Set(['exact', 'sum_squares_mod']);
const DAY = 86_400_000;

export type Tier = 'auto' | 'founder';
export type EventKind = 'first' | 'find' | 'solved' | 'digest';
export interface Item {
  id: string;
  event: string;
  kind: EventKind;
  tier: Tier;
  /** Why it waits for the owner (founder tier). */
  why: string[];
  problem?: string;
  checkpoint?: string;
  /** The post, at most POST_LIMIT graphemes. */
  text: string;
  /** The longer entry for the feed: headline, the post's words, the record ids and how it was checked. */
  feed: string;
  hash: string;
  created: string;
  /** Happened before announcing started: never goes on its own. */
  backlog?: boolean;
  blocked?: string;
  /** The hash of the exact words the owner approved. */
  approved?: string;
  skipped?: boolean;
  sent: Partial<Record<SinkName, { at: string; ref?: string }>>;
}
interface Outbox { started?: string; items: Item[] }
interface Event { key: string; kind: EventKind; at: string; tier: Tier; why: string[]; problem?: StoredRecord; checkpoint?: StoredRecord; done?: number; total?: number; steps?: number; problems?: number }

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
export const itemHash = (i: { text: string; feed: string }) => sha(JSON.stringify({ text: i.text, feed: i.feed }));
const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
export const graphemes = (s: string) => [...segmenter.segment(s)].length;
const day = (t: number) => new Date(t).toISOString().slice(0, 10);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
/** Monday 00:00 UTC of the week holding t. */
const mondayOf = (t: number) => { const d = new Date(t); d.setUTCHours(0, 0, 0, 0); return d.getTime() - ((d.getUTCDay() + 6) % 7) * DAY; };
const denyTerms = () => (process.env.CONSTELLATE_DENY_TERMS ?? '').split(',').map((s) => s.trim()).filter(Boolean);

const LINKY = /https?:\/\/|www\.|\b[\w-]+\.(com|org|net|io|ai|co|xyz|app|dev|me|gg|ly|so|sh|to|tv|info|biz|link|site|online|club|news|social|page|edu|gov|uk|de)\b/i;

/**
 * A problem title is text anyone could have written, so it is held to more than the network's own rule: no @ (it would
 * mention an account), no link or web address, and the strict privacy check. Anything that fails is blocked, not
 * cleaned up: the owner can always write a post by hand.
 */
export function checkTitle(raw: string, deny = denyTerms()): { title: string } | { blocked: string } {
  const title = raw.replace(/\s+/g, ' ').trim();
  if (!title) return { blocked: 'the problem has no title' };
  if (title.includes('@')) return { blocked: 'the title has an @, which would mention an account' };
  if (LINKY.test(title)) return { blocked: 'the title has a link or a web address' };
  const s = scrub(title, { level: 'strict', denyTerms: deny });
  if (!s.ok) return { blocked: `the title may hold personal data or a secret (${[...new Set(s.findings.map((f) => f.type))].join(', ')})` };
  return { title };
}

/** The post with the title shortened at a word boundary until it fits; undefined if under 20 characters of title would be left. */
function fit(make: (title: string) => string, title: string): string | undefined {
  if (graphemes(make(title)) <= POST_LIMIT) return make(title);
  const words = title.split(' ');
  while (words.length > 1) {
    words.pop();
    const t = `${words.join(' ').replace(/[\s,;:.\-–—]+$/, '')}…`;
    if (graphemes(t) < 20) return undefined;
    if (graphemes(make(t)) <= POST_LIMIT) return make(t);
  }
  return undefined;
}

function sentence(e: Event, t: string) {
  switch (e.kind) {
    case 'first': return `"${t}" has a step checked by machine on Constellate (${e.done} of ${e.total} done). No person has reviewed it yet.`;
    case 'solved': return e.total === 1
      ? `"${t}" is checked by machine on Constellate. No person has reviewed it yet.`
      : `All ${e.total} steps of "${t}" are checked by machine on Constellate. No person has reviewed them yet.`;
    case 'find': return `Possible find on "${t}": an answer sent to Constellate passed its machine check. No person has reviewed it yet.`;
    case 'digest': return `Last week on Constellate, ${plural(e.steps!, 'step')} on ${plural(e.problems!, 'problem')} ${e.steps === 1 ? 'was' : 'were'} checked by machine. No person has reviewed ${e.steps === 1 ? 'it' : 'them'} yet.`;
  }
}

export class Announcer {
  private readonly dir: string;
  /** `hub` is needed only to collect; settings, approval and sending read files on this computer. */
  constructor(private readonly hub?: Hub, private readonly home = process.env.CONSTELLATE_HOME ?? join(homedir(), '.constellate')) {
    this.dir = join(home, 'announce');
  }

  // ---- settings and the outbox (plain JSON on this computer) ----

  config(): AnnounceConfig {
    try { return { auto: false, feed: true, ...(JSON.parse(readFileSync(join(this.home, 'announce.json'), 'utf8')) as Partial<AnnounceConfig>) }; } catch { return { auto: false, feed: true }; }
  }
  setConfig(patch: Partial<AnnounceConfig>) {
    const next = { ...this.config(), ...patch };
    const https = (u: string | undefined, what: string) => { if (u !== undefined && !/^https:\/\/[^\s/]+/.test(u)) throw new Error(`${what} must be an https:// address`); };
    https(next.cta, 'The call-to-action link');
    https(next.bluesky?.service, 'The Bluesky server');
    https(next.mastodon?.instance, 'The Mastodon server');
    if (next.bluesky && !next.bluesky.handle.trim()) throw new Error('A Bluesky account needs its handle');
    for (const k of ['bluesky', 'mastodon', 'cta'] as const) if (next[k] === undefined) delete next[k];
    this.write(join(this.home, 'announce.json'), next);
    return next;
  }
  private outbox(): Outbox {
    try { return JSON.parse(readFileSync(join(this.dir, 'outbox.json'), 'utf8')) as Outbox; } catch { return { items: [] }; }
  }
  private save(box: Outbox) { this.write(join(this.dir, 'outbox.json'), box); }
  private write(file: string, value: unknown) {
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(`${file}.tmp`, typeof value === 'string' ? value : JSON.stringify(value, null, 1));
    renameSync(`${file}.tmp`, file);
  }

  /** Identities whose problems this computer vouches for: its own, and the starter library's. */
  private trusted() { return new Set([...starterOperators(this.home), this.need().node.operatorId]); }
  private need() { if (!this.hub) throw new Error('collecting needs the network open'); return this.hub; }

  private tierOf(p: StoredRecord, kind: EventKind, trusted: Set<string>): { tier: Tier; why: string[] } | null {
    const body = p.rec.body as unknown as ProblemBody;
    const v = this.need().problems.verifiers.get(body.definition_of_done.verifier);
    if (p.visibility !== 'public' || !v || TOY.has(v.name)) return null; // warm-up checks are no news
    const why: string[] = [];
    if (v.witness) why.push('a possible find on an open search: a person checks it before anyone hears of it');
    if (body.source) why.push('the problem comes from a public catalogue: a person checks the claim against the source first');
    if (!trusted.has(p.operatorId)) why.push('proposed by someone this computer does not vouch for');
    if (kind === 'solved') why.push('says a whole problem is done');
    return { tier: why.length ? 'founder' : 'auto', why };
  }

  /** What there is to say, from checkpoints this computer re-checked. */
  private async events(now: number): Promise<Event[]> {
    const hub = this.need();
    const trusted = this.trusted();
    const out: Event[] = [];
    const weekStart = mondayOf(now) - 7 * DAY, weekEnd = weekStart + 7 * DAY; // the last complete week, UTC
    let steps = 0;
    const touched = new Set<string>();
    for (const p of hub.problems.list()) {
      const t = this.tierOf(p, 'first', trusted);
      if (!t) continue;
      const st = await hub.problems.state(p.rec.id);
      const cps = st.chunks.flatMap((c) => (c.checkpoint ? [{ key: c.key, cp: c.checkpoint }] : []))
        .sort((a, b) => Date.parse(a.cp.rec.created) - Date.parse(b.cp.rec.created) || a.cp.rec.id.localeCompare(b.cp.rec.id));
      if (!cps.length) continue;
      const base = { problem: p, done: st.done, total: st.total };
      const witness = hub.problems.verifiers.get(st.problem.definition_of_done.verifier)?.witness;
      if (witness) for (const c of cps) out.push({ key: `find:${p.rec.id}:${c.key}`, kind: 'find', at: c.cp.rec.created, checkpoint: c.cp, ...t, ...base });
      else out.push({ key: `first:${p.rec.id}`, kind: 'first', at: cps[0].cp.rec.created, checkpoint: cps[0].cp, ...t, ...base });
      if (st.done === st.total) out.push({ key: `solved:${p.rec.id}`, kind: 'solved', at: cps.at(-1)!.cp.rec.created, checkpoint: cps.at(-1)!.cp, ...this.tierOf(p, 'solved', trusted)!, ...base });
      if (t.tier === 'auto') for (const c of cps) { const at = Date.parse(c.cp.rec.created); if (at >= weekStart && at < weekEnd) { steps++; touched.add(p.rec.id); } }
    }
    if (steps) out.push({ key: `digest:${day(weekStart)}`, kind: 'digest', at: new Date(weekEnd).toISOString(), tier: 'auto', why: [], steps, problems: touched.size });
    return out;
  }

  private compose(e: Event, cfg: AnnounceConfig, deny: string[]): Pick<Item, 'text' | 'feed' | 'blocked'> {
    const cta = cfg.cta ?? DEFAULT_CTA;
    const ctaLine = `\nLend a computer: ${cta}`;
    let title = '', headline: string;
    if (e.kind === 'digest') headline = `Week of ${e.key.slice('digest:'.length)}`;
    else {
      const c = checkTitle((e.problem!.rec.body as unknown as ProblemBody).title, deny);
      if ('blocked' in c) return { text: '', feed: '', blocked: c.blocked };
      title = headline = c.title;
    }
    // "Archived on Autonomi" only when this computer's own signed storage receipt covers the checkpoint's bundle.
    const arch = e.checkpoint ? new Keeper(this.need(), this.home).archivedAt(e.checkpoint.rec.id) : undefined;
    const autonomi = arch?.archive === 'autonomi' ? `\nArchived on Autonomi: ${arch.address}` : '';
    const text = (autonomi ? fit((t) => sentence(e, t) + ctaLine + autonomi, title) : undefined) ?? fit((t) => sentence(e, t) + ctaLine, title);
    if (!text) return { text: '', feed: '', blocked: 'too long to fit in a post' };
    const verifier = e.problem ? (e.problem.rec.body as unknown as ProblemBody).definition_of_done.verifier : '';
    const feed = [
      headline, '', sentence(e, title), '',
      ...(e.kind === 'digest'
        ? [`Counted: steps checked by machine from ${day(Date.parse(e.at) - 7 * DAY)} to ${day(Date.parse(e.at) - DAY)} (UTC), on problems this computer proposed or the starter library holds. Possible finds and problems from public catalogues are left out until a person checks them.`]
        : [`Problem record: ${e.problem!.rec.id}`, `Checkpoint record: ${e.checkpoint!.rec.id}`,
          `How it was checked: the problem's machine check (${verifier}) passed again on this computer, on an answer confirmed by a different identity and a different model family from the one that gave it.`,
          ...(arch?.archive === 'autonomi' ? [`Archived on Autonomi: ${arch.address} (the bundle holding the checkpoint; storage receipt ${arch.receipt})`] : [])]),
      `Lend a computer: ${cta}`,
    ].join('\n');
    const s = scrub({ text, feed }, { level: 'strict', denyTerms: deny });
    if (!s.ok) return { text: '', feed: '', blocked: `may hold personal data or a secret (${[...new Set(s.findings.map((f) => f.type))].join(', ')})` };
    return { text, feed };
  }

  /**
   * Find what's new and write it to the outbox. Items not yet approved, skipped or sent are rewritten each time (the
   * count of done steps, an Autonomi address once the library uploads); approved ones keep the exact approved words.
   */
  async collect(now = Date.now()): Promise<Item[]> {
    const cfg = this.config();
    const box = this.outbox();
    const firstRun = !box.started;
    box.started ??= new Date(now).toISOString();
    const started = Date.parse(box.started);
    const deny = denyTerms();
    for (const e of await this.events(now)) {
      const i = box.items.findIndex((x) => x.event === e.key);
      const was = i >= 0 ? box.items[i] : undefined;
      if (was && (was.approved || was.skipped || Object.keys(was.sent).length)) continue;
      const made = this.compose(e, cfg, deny);
      const item: Item = {
        id: sha(e.key).slice(0, 8), event: e.key, kind: e.kind, tier: e.tier, why: e.why,
        ...(e.problem ? { problem: e.problem.rec.id } : {}), ...(e.checkpoint ? { checkpoint: e.checkpoint.rec.id } : {}),
        text: made.text, feed: made.feed, hash: itemHash(made), created: was?.created ?? new Date(now).toISOString(),
        ...(was?.backlog || firstRun || Date.parse(e.at) < started ? { backlog: true } : {}),
        ...(made.blocked ? { blocked: made.blocked } : {}),
        sent: {},
      };
      if (was) box.items[i] = item; else box.items.push(item);
    }
    this.save(box);
    return box.items;
  }

  /** Why an item can't go yet, or null when it can. */
  private hold(item: Item, cfg: AnnounceConfig): string | null {
    if (item.skipped) return 'skipped';
    if (item.blocked) return `blocked: ${item.blocked}`;
    const now = itemHash(item);
    if (item.approved) return item.approved === now ? null : 'the words changed after approval: approve it again';
    if (item.tier === 'founder') return `waits for your approval (${item.why.join('; ')})`;
    if (item.backlog) return 'from before announcing started: approve it to send it';
    if (!cfg.auto) return 'waits for your approval (automatic posting is off)';
    return item.hash === now ? null : 'the words changed since they were written';
  }

  /** The outbox with what each item is waiting for, and the X compose link for those cleared to go. */
  list() {
    const cfg = this.config();
    return this.outbox().items.map((i) => {
      const hold = this.hold(i, cfg);
      return { ...i, status: hold ?? (Object.keys(i.sent).length ? 'sent' : 'ready'), ...(hold ? {} : { x: xIntent(i.text) }) };
    });
  }

  approve(id: string) {
    const box = this.outbox();
    const item = box.items.find((i) => i.id === id);
    if (!item) throw new Error(`No announcement ${id}. \`constellate announce\` lists them.`);
    if (item.blocked) throw new Error(`Blocked: ${item.blocked}. It can't be approved; write a post by hand if it should be said.`);
    if (!item.text) throw new Error('Nothing to approve.');
    item.approved = itemHash(item);
    delete item.skipped;
    this.save(box);
    return item;
  }

  skip(id: string) {
    const box = this.outbox();
    const item = box.items.find((i) => i.id === id);
    if (!item) throw new Error(`No announcement ${id}.`);
    item.skipped = true;
    this.save(box);
    return item;
  }

  /**
   * Send what is cleared to every destination set up. Without `yes`, only says what it would do. Each post is saved as
   * sent the moment it goes, so a restart never posts it twice.
   */
  async send(o: { yes?: boolean; fetch?: Fetch; secret?: (name: 'bluesky' | 'mastodon') => string | undefined; now?: () => number } = {}) {
    const cfg = this.config();
    const box = this.outbox();
    const deny = denyTerms();
    const fetch = o.fetch ?? globalThis.fetch;
    const secret = o.secret ?? ((n) => new KeyVault(join(this.home, 'keys.json')).get(n));
    const sinks: SinkName[] = [...(cfg.feed ? ['feed' as const] : []), ...(cfg.bluesky ? ['bluesky' as const] : []), ...(cfg.mastodon ? ['mastodon' as const] : [])];
    const report: { id: string; sink?: SinkName; ok: boolean; detail: string }[] = [];
    for (const item of box.items) {
      const hold = this.hold(item, cfg);
      if (hold) { if (item.approved && hold.startsWith('the words changed')) report.push({ id: item.id, ok: false, detail: hold }); continue; }
      const s = scrub({ text: item.text, feed: item.feed }, { level: 'strict', denyTerms: deny }); // the deny list may have grown since
      if (!s.ok) { report.push({ id: item.id, ok: false, detail: `held: may hold personal data or a secret (${[...new Set(s.findings.map((f) => f.type))].join(', ')})` }); continue; }
      for (const sink of sinks) {
        if (item.sent[sink]) continue;
        if (!o.yes) { report.push({ id: item.id, sink, ok: true, detail: 'would send' }); continue; }
        try {
          const at = new Date(o.now?.() ?? Date.now()).toISOString();
          let ref: string | undefined;
          if (sink === 'feed') { item.sent.feed = { at }; this.writeFeed(box, cfg); }
          else if (sink === 'bluesky') {
            const pw = secret('bluesky');
            if (!pw) throw new Error('no app password stored: `constellate keys set bluesky`');
            ref = await postBluesky(cfg.bluesky!, pw, item.text, fetch);
          } else {
            const token = secret('mastodon');
            if (!token) throw new Error('no access token stored: `constellate keys set mastodon`');
            ref = await postMastodon(cfg.mastodon!, token, item.text, item.approved ?? item.hash, fetch);
          }
          item.sent[sink] = { at, ...(ref ? { ref } : {}) };
          this.save(box);
          report.push({ id: item.id, sink, ok: true, detail: ref ?? 'written' });
        } catch (e) {
          if (sink === 'feed') delete item.sent.feed;
          report.push({ id: item.id, sink, ok: false, detail: (e as Error).message });
        }
      }
    }
    return report;
  }

  private writeFeed(box: Outbox, cfg: AnnounceConfig) {
    const entries = box.items.filter((i) => i.sent.feed).map((i) => ({ id: i.hash, at: i.sent.feed!.at, title: i.feed.split('\n')[0], content: i.feed }));
    this.write(join(this.dir, 'feed.xml'), atomFeed(entries, cfg.cta ?? DEFAULT_CTA));
  }

  feedPath() { return join(this.dir, 'feed.xml'); }
}
