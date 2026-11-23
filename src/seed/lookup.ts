import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { Hub } from '../hub/hub.js';
import { redactPersonal } from '../privacy/redact.js';
import { PrivacyBlockedError } from '../privacy/scrub.js';

/**
 * When the shared memory has nothing for an error, look it up once on GitHub (docs/SEED_SOURCES.md, "On a miss").
 *
 * Only closed issues with a fix found by the issue's own timeline count: a merged pull request that referenced it,
 * or the commit that closed it. Each becomes two short signed records: what failed (the issue's title) and what
 * fixed it (the fix's title), both linking to their source on GitHub. Issue and pull-request text is not copied:
 * it is posted under GitHub's terms, so records hold only titles and links.
 *
 * From then on the network answers without GitHub: the records spread to every computer by gossip, and once
 * someone confirms a fix worked (fix_tried), the library keeper archives the failure and its fix on Autonomi with
 * the confirmations that justify them (src/hub/keeper.ts). The next agent with the same error finds them in
 * Constellate first, labelled by how many independent agents confirmed them.
 *
 * Privacy: only a short query built from the error's words leaves the computer: paths, addresses, numbers,
 * hashes and anything the redactor recognises as personal are removed first, and the query is shown to the agent.
 * Never in private read mode (closed projects); off with CONSTELLATE_GITHUB_LOOKUP=off.
 */
export interface LookupFound { issue: string; fix: string; failure: string; answer: string; new: boolean }
export interface LookupResult { query: string; found: LookupFound[]; note: string }

const API = 'https://api.github.com';
const ERRORISH = /error|exception|panic|fail|failed|failure|cannot|can't|unable|denied|refused|timeout|timed|crash|segfault|undefined|not found|invalid|unexpected|missing|E\d{3,4}\b|ERR_/i;
const ERRNO = /\bE[A-Z]{3,}\b|\bERR_[A-Z_]+\b/; // EADDRINUSE, ENOENT, ERR_MODULE_NOT_FOUND (case matters)
const errorish = (t: string) => ERRORISH.test(t) || ERRNO.test(t) || /already in use|no such|not supported|permission/i.test(t);
const DAY = 86_400_000;

/** The words of the most error-like line, with everything identifying removed. Null when nothing usable is left. */
export function lookupQuery(text: string): string | null {
  const lines = String(text).split('\n').map((l) => l.trim()).filter(Boolean);
  const line = lines.find(errorish) ?? lines[0] ?? '';
  const cleaned = redactPersonal(line)
    .replace(/<[a-z_]+>/g, ' ') // the redactor's placeholders
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/(?:[A-Za-z]:)?(?:[\\/][^\s'"`]+)+/g, ' ') // paths
    .replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, ' ')
    .replace(/\b\d+(?:\.\d+){3}\b/g, ' ') // IPv4
    .replace(/\b[0-9a-f]{7,}\b/gi, ' ') // hashes and ids
    .replace(/\b\d{3,}\b/g, ' '); // line numbers, ports, pids
  const words = cleaned.split(/[\s"'`()[\]{},;=<>|]+/).map((w) => w.replace(/^[:.]+|[:.]+$/g, '')).filter((w) => w.length > 1 && w.length < 40 && /^[A-Za-z][\w.:-]*$/.test(w));
  if (words.length < 2 || !errorish(words.join(' '))) return null;
  return words.slice(0, 10).join(' ');
}

interface Cache { [query: string]: { at: number; found: LookupFound[] } }

export class GithubLookup {
  private readonly file: string;
  constructor(private readonly hub: Hub, private readonly opts: { fetch?: typeof fetch; token?: string; now?: () => number; home?: string } = {}) {
    this.file = join(opts.home ?? process.env.CONSTELLATE_HOME ?? join(homedir(), '.constellate'), 'github-lookups.json');
  }

  enabled() { return !this.hub.node.readOnly && process.env.CONSTELLATE_GITHUB_LOOKUP !== 'off'; }
  private now() { return this.opts.now?.() ?? Date.now(); }
  private cache(): Cache { try { return existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) as Cache : {}; } catch { return {}; } }
  private save(c: Cache) { mkdirSync(dirname(this.file), { recursive: true }); writeFileSync(this.file, JSON.stringify(c)); }

  private async get(path: string) {
    const token = this.opts.token ?? process.env.GITHUB_TOKEN;
    const r = await (this.opts.fetch ?? fetch)(`${API}${path}`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'constellate-mcp', ...(token ? { authorization: `Bearer ${token}` } : {}) }, signal: AbortSignal.timeout(8000) });
    if (r.status === 403 || r.status === 429) throw new Error('GitHub’s rate limit for this computer is used up; try again later');
    if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
    return r.json() as Promise<any>;
  }

  /** The fix GitHub's timeline shows for an issue: a merged pull request that referenced it, or the closing commit. */
  private async fixOf(repo: string, number: number): Promise<{ url: string; title: string } | null> {
    const events = (await this.get(`/repos/${repo}/issues/${number}/timeline?per_page=100`)) as any[];
    for (const e of events) {
      const src = e?.event === 'cross-referenced' ? e.source?.issue : null;
      if (src?.pull_request?.merged_at && typeof src.html_url === 'string' && src.html_url.startsWith('https://github.com/')) return { url: src.html_url, title: String(src.title ?? 'the pull request that fixed it') };
    }
    const closed = events.find((e) => e?.event === 'closed' && typeof e.commit_id === 'string' && /^[0-9a-f]{40}$/.test(e.commit_id));
    return closed ? { url: `https://github.com/${repo}/commit/${closed.commit_id}`, title: 'the commit that closed it' } : null;
  }

  /** Look the error up once (per query per day), keep what has a fix, and say exactly what was sent. */
  async lookup(text: string, opts: { max?: number } = {}): Promise<LookupResult | null> {
    if (!this.enabled()) return null;
    const query = lookupQuery(text);
    if (!query) return null;
    const cache = this.cache();
    const hit = cache[query];
    if (hit && this.now() - hit.at < DAY) return { query, found: hit.found, note: 'Looked up on GitHub earlier today.' };
    const found: LookupFound[] = [];
    let note = '';
    try {
      const res = await this.get(`/search/issues?q=${encodeURIComponent(`${query} is:issue is:closed reason:completed`)}&per_page=5`);
      for (const item of (res.items ?? []) as any[]) {
        if (found.length >= (opts.max ?? 3)) break;
        const m = /^https:\/\/api\.github\.com\/repos\/([\w.-]+\/[\w.-]+)$/.exec(String(item.repository_url ?? ''));
        if (!m || item.pull_request || typeof item.html_url !== 'string') continue;
        const fix = await this.fixOf(m[1], Number(item.number));
        if (!fix) continue;
        const kept = await this.keep({ repo: m[1], title: String(item.title ?? ''), url: item.html_url, closed: String(item.closed_at ?? '').slice(0, 10) }, fix, query);
        if (kept) found.push(kept);
      }
      note = found.length ? `Found ${found.length} closed GitHub issue${found.length === 1 ? '' : 's'} with a fix. Not yet confirmed by anyone here.` : 'GitHub has no closed issue with a fix for this.';
    } catch (e) { note = `Couldn’t look it up on GitHub: ${(e as Error).message}`; }
    cache[query] = { at: this.now(), found };
    this.save(cache);
    return { query, found, note };
  }

  /** Two records: what failed and what fixed it. Titles and links only; reused if already on the network. */
  private async keep(issue: { repo: string; title: string; url: string; closed: string }, fix: { url: string; title: string }, query: string): Promise<LookupFound | null> {
    const store = this.hub.node.store;
    const existing = store.all().find((s) => s.rec.kind === 'failure' && s.rec.evidence.includes(issue.url));
    if (existing) {
      const ans = store.referencing(existing.rec.id, 'answer')[0];
      return ans ? { issue: issue.url, fix: fix.url, failure: existing.rec.id, answer: ans.rec.id, new: false } : null;
    }
    const name = issue.repo.split('/')[1];
    const title = redactPersonal(issue.title).slice(0, 300);
    try {
      const { record: failure } = await this.hub.node.submit({
        kind: 'failure',
        context: { task: `${name}: ${title}`.slice(0, 500), domain: [name.toLowerCase().slice(0, 48), 'github'], environment: `${issue.repo}${issue.closed ? `, closed ${issue.closed}` : ''}` },
        body: { approach: title, outcome: 'error', error_summary: title, confidence: 0.8, source: 'github_lookup', query },
        evidence: [issue.url],
      }, { publish: true });
      const { record: answer } = await this.hub.node.submit({
        kind: 'answer',
        context: { task: `${name}: fix for "${title}"`.slice(0, 500), domain: [name.toLowerCase().slice(0, 48), 'github'], environment: issue.repo },
        body: { question: `How was "${title}" fixed?`.slice(0, 600), answer: `${redactPersonal(fix.title).slice(0, 300)} (${fix.url})`, proof: { type: 'citation', detail: 'The fix GitHub’s own timeline links to the closed issue.' }, source: 'github_lookup' },
        refs: [failure.id],
        evidence: [fix.url, issue.url],
      }, { publish: true });
      return { issue: issue.url, fix: fix.url, failure: failure.id, answer: answer.id, new: true };
    } catch (e) {
      if (e instanceof PrivacyBlockedError) return null; // a title the scrubber won't publish: skipped
      throw e;
    }
  }
}
