import { Hub } from '../hub/hub.js';
import { PrivacyBlockedError } from '../privacy/scrub.js';

/**
 * Seeding from public issue trackers: a closed issue describes what went wrong,
 * and the merged pull request that closed it is what fixed it. Only public
 * repositories, only what is already public, every record linked to its source.
 * The privacy scrubber still runs on every record as a second gate.
 *
 * Allow-list (owner-approved 2026-11-06): the Constellate and Daylight repos, and
 * every public repository of the saorsa-labs organisation.
 */
export const ISSUE_SEED_ALLOW = [/^nkoteskey\/(constellate|daylight)$/i, /^saorsa-labs\/[\w.-]+$/i];
export const issueSeedAllowed = (repo: string) => ISSUE_SEED_ALLOW.some((re) => re.test(repo));

export interface Issue { repo: string; number: number; title: string; body?: string; labels?: string[]; url: string; closed_at?: string }
export interface Pull extends Issue { merged_at?: string }
export interface IssueDump { issues: Issue[]; pulls: Pull[]; harvested?: string }
export interface IssueSeedReport { failures: number; answers: number; skipped: { url: string; reason: string }[]; denied: string[] }

const FAILURE = /fail|error|panic|crash|broken|bug|regress|hang|leak|wrong|does not|doesn.t|refus|time[sd]? ?out|flak|killed|stuck|cannot|can.t|lost|drop|deadlock|race|missing|incorrect|mismatch|stale|reject/i;
const CLOSES = /\b(?:fix(?:es|ed)?|close[sd]?|resolve[sd]?)\b[:\s]+((?:[\w.-]+\/[\w.-]+)?#\d+(?:\s*(?:,|and)\s*(?:[\w.-]+\/[\w.-]+)?#\d+)*)/gi;

/** First readable paragraph of a GitHub markdown body: no headings, code, tables, checklists, bot footers or session links. */
export function firstParagraph(body = '', max = 420): string {
  const text = body.replace(/<!--[\s\S]*?-->/g, '').replace(/```[\s\S]*?(```|$)/g, '');
  const paras = text.split(/\n\s*\n/).map((p) => p.split('\n')
    .filter((l) => !/^\s*(#|\||- \[[ x]\]|>|Co-Authored-By|Claude-Session|🤖|Generated with|https?:\/\/\S+$)/i.test(l))
    .map((l) => l.replace(/^\s*(?:[-*+]|\d+\.)\s+/, '')).join(' ').replace(/\s+/g, ' ').replace(/`([^`]+)`/g, '$1').replace(/\*\*?([^*]+)\*\*?/g, '$1').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').trim())
    .filter((p) => p.length > 20 && !/^(summary|tests?|test plan|changes?)\s*:?$/i.test(p));
  const p = paras[0] ?? '';
  return p.length > max ? `${p.slice(0, max - 1).replace(/\s+\S*$/, '')}…` : p;
}

/** Which issues does a pull request close? ("Fixes #12", "closes org/repo#3, #4") */
export function closedBy(pull: Pull): { repo: string; number: number }[] {
  const out: { repo: string; number: number }[] = [];
  for (const m of `${pull.title}\n${pull.body ?? ''}`.matchAll(CLOSES)) {
    for (const ref of m[1].matchAll(/((?:[\w.-]+\/[\w.-]+)?)#(\d+)/g)) out.push({ repo: ref[1] || pull.repo, number: Number(ref[2]) });
  }
  return out;
}

const repoName = (r: string) => r.split('/')[1];
const domainOf = (r: string, labels: string[] = []) => [...new Set([repoName(r), 'rust', ...(/x0x|gossip|quic|mls|pqc/i.test(r) ? ['x0x'] : []), ...labels.filter((l) => l.length < 30).map((l) => l.toLowerCase())])].slice(0, 8);

/**
 * Plain-language versions of seeded lessons, keyed by the issue or pull request URL.
 * Written once (data/seed/plain-lessons.json) and reviewed like code; the original
 * stays one click away as evidence and stays searchable through the record's task.
 */
export interface PlainIssue { problem: string; detail: string; applies_when?: string }
export interface PlainFix { fix: string; how: string }
export type PlainLessons = Record<string, Partial<PlainIssue & PlainFix>>;

export class IssueSeeder {
  constructor(private readonly hub: Hub, private readonly plain: PlainLessons = {}) {}

  private seen(url: string) { return this.hub.node.store.all().some((s) => s.rec.evidence.includes(url)); }

  async seed(dump: IssueDump, opts: { limit?: number } = {}): Promise<IssueSeedReport> {
    const report: IssueSeedReport = { failures: 0, answers: 0, skipped: [], denied: [] };
    const allowed = (x: Issue) => { if (issueSeedAllowed(x.repo)) return true; if (!report.denied.includes(x.repo)) report.denied.push(x.repo); return false; };
    const issues = dump.issues.filter(allowed);
    const byIssue = new Map<string, string>();
    const pulls = dump.pulls.filter(allowed);
    const fixFor = new Map<string, Pull>();
    for (const p of pulls) for (const c of closedBy(p)) { const k = `${c.repo}#${c.number}`; const prev = fixFor.get(k); if (!prev || (p.merged_at ?? '') < (prev.merged_at ?? '')) fixFor.set(k, p); }
    const usedPulls = new Set<string>();
    let n = 0;
    const max = opts.limit ?? Infinity;

    // 1. Issues: what went wrong, and (when we know it) what fixed it. Feature requests and chores
    // aren't failures. The sample is chosen in harvest order, then seeded oldest first, so an issue
    // that mentions an earlier one can link to it (the web of cross-references).
    const chosen = issues.filter((i) => fixFor.has(`${i.repo}#${i.number}`) || FAILURE.test(i.title)).slice(0, max)
      .sort((a, b) => a.repo.localeCompare(b.repo) || a.number - b.number);
    for (const i of chosen) {
      const fix = fixFor.get(`${i.repo}#${i.number}`);
      if (this.seen(i.url)) { report.skipped.push({ url: i.url, reason: 'already seeded' }); continue; }
      try {
        const env = `${i.repo}${i.closed_at ? `, closed ${i.closed_at.slice(0, 10)}` : ''}`;
        const summary = firstParagraph(i.body) || i.title;
        const pi = this.plain[i.url];
        // Synapses: earlier issues this one mentions ("follow-up after #1766") become buildsOn links.
        const mentions = [...`${i.title}\n${i.body ?? ''}`.matchAll(/((?:[\w.-]+\/[\w.-]+)?)#(\d+)\b/g)]
          .map((m) => `${m[1] || i.repo}#${m[2]}`).filter((k) => k !== `${i.repo}#${i.number}`);
        const refs = [...new Set(mentions.map((k) => byIssue.get(k)).filter((x): x is string => !!x))].slice(0, 6);
        const { record } = await this.hub.node.submit({
          kind: 'failure',
          context: { task: `${repoName(i.repo)}: ${i.title}`.slice(0, 500), domain: domainOf(i.repo, i.labels), environment: env },
          body: { approach: (pi?.problem || i.title).slice(0, 600), ...(pi?.problem ? { original: i.title.slice(0, 600) } : {}), ...(pi?.applies_when ? { applies_when: pi.applies_when.slice(0, 300) } : {}), outcome: /wrong|incorrect|mismatch|stale/i.test(i.title) ? 'wrong_result' : /slow|time[sd]? ?out|hang/i.test(i.title) ? 'too_slow' : 'error', error_summary: (pi?.detail || summary).slice(0, 600), confidence: fix ? 0.9 : 0.7 },
          evidence: [i.url],
          refs,
        }, { publish: true });
        byIssue.set(`${i.repo}#${i.number}`, record.id);
        report.failures++; n++;
        if (fix) {
          usedPulls.add(fix.url);
          const why = firstParagraph(fix.body);
          const pf = this.plain[fix.url];
          await this.hub.node.submit({
            kind: 'answer',
            context: { task: `${repoName(i.repo)}: fix for "${i.title}"`.slice(0, 500), domain: domainOf(i.repo, i.labels), environment: `${fix.repo}, merged ${fix.merged_at?.slice(0, 10) ?? ''}` },
            body: { question: `How was "${i.title}" fixed?`.slice(0, 600), answer: (pf?.fix ? `${pf.fix}${pf.how ? ` ${pf.how}` : ''}` : `${fix.title}${why ? ` — ${why}` : ''}`).slice(0, 4000), ...(pf?.fix ? { headline: pf.fix.slice(0, 300), original: fix.title.slice(0, 600) } : {}), proof: { type: 'test', detail: `merged pull request ${fix.url}` } },
            refs: [record.id],
            evidence: [fix.url, i.url],
          }, { publish: true });
          report.answers++; n++;
        }
      } catch (e) {
        report.skipped.push({ url: i.url, reason: e instanceof PrivacyBlockedError ? `privacy scrubber blocked it: ${[...new Set(e.findings.map((f) => f.type))].join(', ')}` : (e as Error).message });
      }
    }

    // 2. Fix pull requests that closed no tracked issue: still a verified answer.
    for (const p of pulls) {
      if (n >= max) break;
      if (usedPulls.has(p.url) || !/^(fix|bugfix|hotfix)\b|^fix\(/i.test(p.title)) continue;
      if (this.seen(p.url)) { report.skipped.push({ url: p.url, reason: 'already seeded' }); continue; }
      const what = p.title.replace(/^(fix|bugfix|hotfix)(\([^)]*\))?!?:\s*/i, '');
      try {
        const why = firstParagraph(p.body);
        const pf = this.plain[p.url];
        await this.hub.node.submit({
          kind: 'answer',
          context: { task: `${repoName(p.repo)}: ${what}`.slice(0, 500), domain: domainOf(p.repo, p.labels), environment: `${p.repo}, merged ${p.merged_at?.slice(0, 10) ?? ''}` },
          body: { question: `${repoName(p.repo)}: ${what}`.slice(0, 600), answer: (pf?.fix ? `${pf.fix}${pf.how ? ` ${pf.how}` : ''}` : why || p.title).slice(0, 4000), ...(pf?.fix ? { headline: pf.fix.slice(0, 300), original: p.title.slice(0, 600) } : {}), proof: { type: 'test', detail: `merged pull request ${p.url}` } },
          evidence: [p.url],
        }, { publish: true });
        report.answers++; n++;
      } catch (e) {
        report.skipped.push({ url: p.url, reason: e instanceof PrivacyBlockedError ? `privacy scrubber blocked it: ${[...new Set(e.findings.map((f) => f.type))].join(', ')}` : (e as Error).message });
      }
    }
    return report;
  }
}
