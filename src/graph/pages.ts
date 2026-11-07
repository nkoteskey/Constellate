import type { Hub } from '../hub/hub.js';
import type { StoredRecord } from '../store/records.js';
import { utf8 } from '../util/bytes.js';
import { bm25 } from '../services/search.js';

/**
 * Memory that gets wiser, not just bigger (docs/MEMORY.md). After Anthropic's study of agent memory
 * ("The components of agent memory", Nov 2026): memory pays off when it is small at the top, written as
 * checked rules with their evidence, and re-checked offline against what actually happened.
 *
 * Layers, bottom to top:
 *   1. Signed records: what agents tried, what failed, what fixed it, and who confirmed or disputed it.
 *   2. Topic pages: one per subject (a cluster of related lessons), written as rules with evidence and a
 *      status (checked by someone else / fixed upstream / unconfirmed), traps that look right but fail,
 *      the fix quoted word for word, and links to related pages. A new version replaces the old one; no
 *      two writers edit the same page.
 *   3. The map: a briefing of about 1,500 characters given to every agent at the start of a session, only
 *      the best-supported rules, each pointing down to its page.
 * Dreaming re-checks pages whose evidence changed, demotes or drops rules whose evidence was disputed,
 * repairs links, merges duplicates and retires empty pages. It checks signed evidence, so it needs no model.
 */
export type Status = 'checked' | 'merged' | 'unconfirmed';
export interface Rule { text: string; evidence: string[]; status: Status; confirmations: number }
export interface Trap { text: string; evidence: string[]; disputed_fix?: boolean }
export interface PageFields { v: 2; rules: Rule[]; traps: Trap[]; fix: { text: string; from: string } | null; links: string[]; source_bytes: number; page_bytes: number }
export interface PageBody extends PageFields { cluster: string; title: string; summary: string; members: string[]; realms: string[]; supersedes: string | null; retired?: boolean; merged_into?: string; dreamed?: string[] }

const clip = (t: string, n: number) => { const x = String(t ?? '').replace(/\s+/g, ' ').trim(); return x.length > n ? `${x.slice(0, n - 1).trimEnd()}…` : x; };
const firstSentence = (t: string) => clip((String(t).match(/^.*?[.!?](\s|$)/)?.[0] ?? t), 220);
const MAX_RULES = 5, MAX_TRAPS = 3;
export const MAP_CHARS = 1500;

export class Pages {
  constructor(private readonly hub: Hub) {}
  private get store() { return this.hub.node.store; }

  /** Confirmations from someone other than the author's operator; disputes from anyone. */
  support(s: StoredRecord) {
    const confirmations = this.store.referencing(s.rec.id, 'confirmation').filter((c) => c.operatorId !== s.operatorId).length;
    const disputes = this.store.referencing(s.rec.id, 'contradiction').filter((c) => c.operatorId !== s.operatorId).length;
    return { confirmations, disputes };
  }

  private status(s: StoredRecord): Status {
    if (this.support(s).confirmations > 0) return 'checked';
    const proof = (s.rec.body as { proof?: { detail?: string } }).proof?.detail ?? '';
    return /merged pull request/i.test(proof) ? 'merged' : 'unconfirmed';
  }

  /** The latest live page per topic (retired and merged pages left out). */
  latest(): StoredRecord[] {
    const by = new Map<string, StoredRecord>();
    for (const s of this.store.ofKind('summary')) { const k = (s.rec.body as { cluster: string }).cluster; const p = by.get(k); if (!p || p.rec.created < s.rec.created) by.set(k, s); }
    return [...by.values()].filter((s) => !(s.rec.body as { retired?: boolean }).retired);
  }

  /** Write a topic's page from its records: rules with evidence and status, traps, the fix quoted verbatim, links. */
  build(members: string[], cluster: string): PageFields {
    const recs = members.map((id) => this.store.get(id)).filter((s): s is StoredRecord => !!s);
    const rank = (s: StoredRecord) => { const st = this.status(s); return (st === 'checked' ? 3 : st === 'merged' ? 2 : 1) * 100 + this.support(s).confirmations * 10 - this.support(s).disputes * 20; };
    const answers = recs.filter((s) => s.rec.kind === 'answer').sort((a, b) => rank(b) - rank(a) || b.rec.created.localeCompare(a.rec.created));
    const held = answers.filter((s) => { const t = this.support(s); return t.disputes <= t.confirmations; });
    const disputed = answers.filter((s) => !held.includes(s));
    let rules: Rule[] = held.slice(0, MAX_RULES).map((s) => {
      const b = s.rec.body as { answer: string; headline?: string };
      return { text: firstSentence(b.headline ?? b.answer), evidence: [s.rec.id, ...s.rec.refs.filter((r) => members.includes(r))].slice(0, 4), status: this.status(s), confirmations: this.support(s).confirmations };
    });
    const failures = recs.filter((s) => s.rec.kind === 'failure').sort((a, b) => this.support(b).confirmations - this.support(a).confirmations || b.rec.created.localeCompare(a.rec.created));
    let traps: Trap[] = [
      ...disputed.slice(0, 1).map((s) => ({ text: `A reported fix that didn't hold: ${firstSentence((s.rec.body as { headline?: string; answer: string }).headline ?? (s.rec.body as { answer: string }).answer)}`, evidence: [s.rec.id], disputed_fix: true })),
      ...failures.slice(0, MAX_TRAPS).map((s) => { const b = s.rec.body as { approach: string; error_summary: string }; return { text: `${clip(b.approach, 120)} → ${clip(b.error_summary, 120)}`, evidence: [s.rec.id] }; }),
    ].slice(0, MAX_TRAPS);
    const best = held[0];
    const fix = best ? { text: clip((best.rec.body as { answer: string }).answer, 700), from: best.rec.id } : null;
    // Links: topics whose lessons are strongly linked to this one's.
    const home = new Map<string, string>();
    for (const p of this.latest()) { const b = p.rec.body as { cluster: string; members: string[] }; if (b.cluster !== cluster) for (const m of b.members) home.set(m, b.cluster); }
    const count = new Map<string, number>();
    for (const id of members) for (const n of this.hub.graph.neighbours(id, 5)) { const k = home.get(n.id); if (k) count.set(k, (count.get(k) ?? 0) + 1); }
    const links = [...count].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k]) => k);
    // A page must say less than what it distils, or it's a copy, not a map. Counted in written text: record
    // ids and links are pointers, not prose.
    const text = (v: unknown): number => typeof v === 'string' ? utf8(v).length : Array.isArray(v) ? v.reduce((n: number, x) => n + text(x), 0) : v && typeof v === 'object' ? Object.values(v).reduce((n: number, x) => n + text(x), 0) : 0;
    const source_bytes = recs.reduce((n, s) => n + text(s.rec.body), 0);
    const size = () => text(rules.map((r) => r.text)) + text(traps.map((t) => t.text)) + (fix ? utf8(fix.text).length : 0);
    while (size() > source_bytes && (traps.length || rules.length > 1)) { if (traps.length) traps = traps.slice(0, -1); else rules = rules.slice(0, -1); }
    return { v: 2, rules, traps, fix: size() <= source_bytes ? fix : null, links, source_bytes, page_bytes: size() };
  }

  /** The best page for a question: the map first, then search fills in the detail. */
  match(query: string, opts: { domain?: string[]; limit?: number } = {}) {
    const docs = this.latest();
    const rel = bm25(query, docs.map((s) => { const b = s.rec.body as unknown as PageBody; return { id: s.rec.id, text: `${b.title} ${b.summary} ${(b.rules ?? []).map((r) => r.text).join(' ')} ${(b.traps ?? []).map((t) => t.text).join(' ')} ${s.rec.context.domain.join(' ')}`, tags: s.rec.context.domain }; }), { tags: opts.domain });
    return docs.filter((s) => rel.has(s.rec.id)).sort((a, b) => rel.get(b.rec.id)! - rel.get(a.rec.id)!).slice(0, opts.limit ?? 1).map((s) => this.view(s));
  }

  /** A page as agents and people see it. */
  view(s: StoredRecord) {
    const b = s.rec.body as unknown as PageBody;
    return { page: s.rec.id, topic: b.cluster, title: b.title, rules: b.rules ?? [], traps: b.traps ?? [], fix: b.fix ?? null, links: (b.links ?? []).map((k) => this.byTopic(k)).filter(Boolean).map((p) => ({ page: p!.rec.id, title: (p!.rec.body as unknown as PageBody).title })), sources: b.members.length, summary: b.v === 2 ? undefined : b.summary, updated: s.rec.created };
  }

  byTopic(cluster: string) { return this.latest().find((s) => (s.rec.body as unknown as PageBody).cluster === cluster); }
  get(idOrPrefix: string) {
    const s = this.store.get(idOrPrefix) ?? (idOrPrefix.length >= 8 ? this.latest().find((p) => p.rec.id.startsWith(idOrPrefix)) : undefined);
    return s?.rec.kind === 'summary' ? this.view(s) : null;
  }

  /**
   * The map: what every agent session starts with. Small on purpose (a wrong or bloated top layer misleads
   * every session): only the best-supported rules, each with the page id that opens the detail.
   */
  brief(opts: { max?: number; domains?: string[] } = {}) {
    const max = opts.max ?? MAP_CHARS;
    const mine = new Set((opts.domains ?? []).map((d) => d.toLowerCase()));
    const W: Record<Status, number> = { checked: 3, merged: 2, unconfirmed: 0 };
    const scored = this.latest().map((s) => {
      const b = s.rec.body as unknown as PageBody;
      const rules = (b.rules ?? []).filter((r) => r.status !== 'unconfirmed');
      const score = rules.reduce((n, r) => n + W[r.status] + r.confirmations, 0) + (s.rec.context.domain.some((d) => mine.has(d.toLowerCase())) ? 5 : 0);
      return { s, b, rules, score };
    }).filter((x) => x.rules.length).sort((a, b) => b.score - a.score || b.s.rec.created.localeCompare(a.s.rec.created));
    const head = 'Map of what other agents learned (checked = confirmed by someone else; upstream = fix merged in the project). For a topic\'s full page (rules, traps, the exact fix), call answers_lookup with page set to its id.';
    let out = head;
    for (const { s, b, rules } of scored) {
      const r = rules[0];
      const trap = (b.traps ?? []).find((t) => !t.disputed_fix);
      const line = `\n• ${clip(b.title, 80)} [${s.rec.id.slice(0, 12)}]: ${clip(r.text, 160)} (${r.status === 'checked' ? `checked by ${r.confirmations}` : 'upstream'})${trap ? ` Trap: ${clip(trap.text, 110)}` : ''}`;
      if (out.length + line.length > max) break;
      out += line;
    }
    return out === head ? '' : out;
  }

  /**
   * Dreaming: re-check pages whose evidence changed since they were written, against the signed records.
   * Rules whose evidence was disputed are demoted or dropped, new confirmations promote, missing evidence
   * and dangling links are repaired, near-duplicate topics are merged, and empty topics are retired.
   * Only changed topics are touched, so the cost follows what changes, not how much is stored.
   */
  async dream(): Promise<{ looked: number; rewritten: number; retired: number; merged: number }> {
    const out = { looked: 0, rewritten: 0, retired: 0, merged: 0 };
    const pages = this.latest();
    const live = new Set(pages.map((p) => (p.rec.body as unknown as PageBody).cluster));
    for (const p of pages) {
      const b = p.rec.body as unknown as PageBody;
      out.looked++;
      const since = p.rec.created;
      const present = b.members.filter((id) => this.store.get(id));
      const evidence = [...new Set([...(b.rules ?? []).flatMap((r) => r.evidence), ...(b.traps ?? []).flatMap((t) => t.evidence)])];
      const reasons: string[] = [];
      if (b.v !== 2) reasons.push('rewritten as rules with evidence');
      if (present.length < b.members.length) reasons.push(`${b.members.length - present.length} source records gone`);
      if (evidence.some((id) => !this.store.get(id))) reasons.push('evidence missing');
      if ((b.links ?? []).some((k) => !live.has(k))) reasons.push('dangling link');
      if (b.members.some((id) => [...this.store.referencing(id, 'confirmation'), ...this.store.referencing(id, 'contradiction')].some((c) => c.rec.created > since))) reasons.push('new confirmations or disputes');
      if (!reasons.length) continue;
      if (present.length < 2) { await this.publish(p, { ...b, retired: true, dreamed: [...reasons, 'retired: too little left'] }); out.retired++; continue; }
      const fields = this.build(present, b.cluster);
      await this.publish(p, { ...b, ...fields, members: present, dreamed: reasons });
      out.rewritten++;
    }
    // Merge near-duplicates: when most of one topic's lessons sit in another, keep the larger.
    const fresh = this.latest();
    for (const a of fresh) for (const c of fresh) {
      if (a === c) continue;
      const A = a.rec.body as unknown as PageBody, C = c.rec.body as unknown as PageBody;
      if (A.retired || C.retired || A.members.length > C.members.length || (A.members.length === C.members.length && a.rec.id > c.rec.id)) continue;
      const inC = new Set(C.members);
      if (A.members.filter((m) => inC.has(m)).length / A.members.length >= 0.6) {
        await this.publish(a, { ...A, retired: true, merged_into: C.cluster, dreamed: [`merged into ${C.title}`] });
        A.retired = true;
        out.merged++;
      }
    }
    return out;
  }

  private async publish(prev: StoredRecord, body: PageBody) {
    const next: PageBody = { ...body, supersedes: prev.rec.id };
    await this.hub.node.submit({ kind: 'summary', context: { ...prev.rec.context, task: `dream: re-check ${body.members.length} related records` }, body: next as unknown as Record<string, unknown>, refs: body.members }, { publish: true });
  }

  /** Dream on a schedule (default every 6 hours); any computer running Constellate can do it, no AI account needed. */
  schedule(everyMs = 6 * 3600_000) { const t = setInterval(() => void this.dream().catch(() => {}), everyMs); t.unref?.(); return () => clearInterval(t); }
}
