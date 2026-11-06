import { Hub } from '../hub/hub.js';
import { GitHubSource, Run } from './github.js';
import { PrivacyBlockedError } from '../privacy/scrub.js';

/**
 * Seeding the cold start. Rule: only public repos feed the ledger, only from
 * what is already public; closed projects read locally and never write.
 * - Allow-list, default deny. At launch it is exactly these two repos.
 * - Sources: failing CI runs, the commit whose later run passed (the fix), and
 *   issues that commit references. Never raw coding sessions, local files,
 *   environment variables or paths.
 * - Every seeded record links to its public sources as evidence and lineage.
 * - The on-device privacy scrubber still runs on every record as a second gate.
 */
export const SEED_ALLOW_LIST = ['nkoteskey/constellate', 'nkoteskey/daylight'] as const;

export interface SeedReport { repo: string; allowed: boolean; reason?: string; failures: number; answers: number; skipped: { run: number; reason: string }[] }

const firstLine = (s: string) => s.split('\n')[0].slice(0, 200);

export class Seeder {
  constructor(private readonly hub: Hub, private readonly gh: GitHubSource, private readonly allowList: readonly string[] = SEED_ALLOW_LIST) {}

  isAllowed(repo: string) { return this.allowList.map((r) => r.toLowerCase()).includes(repo.toLowerCase()); }

  private seen(url: string) { return this.hub.node.store.all().some((s) => s.rec.evidence.includes(url)); }

  async seed(repo: string, opts: { maxRuns?: number } = {}): Promise<SeedReport> {
    const report: SeedReport = { repo, allowed: false, failures: 0, answers: 0, skipped: [] };
    if (!this.isAllowed(repo)) return { ...report, reason: 'not on the seed allow-list (default deny)' };
    const info = await this.gh.repo(repo);
    if (info.private) return { ...report, reason: 'repository is private: closed projects never write' };
    report.allowed = true;
    const domain = [...new Set(['ci', (info.language ?? '').toLowerCase(), ...(info.topics ?? [])].filter(Boolean))].slice(0, 8);

    const failed = (await this.gh.runs(repo, { status: 'failure', perPage: opts.maxRuns ?? 30 })).filter((r) => r.conclusion === 'failure');
    for (const run of failed) {
      if (this.seen(run.html_url)) { report.skipped.push({ run: run.id, reason: 'already seeded' }); continue; }
      try {
        const jobs = (await this.gh.jobs(repo, run.id)).filter((j) => j.conclusion === 'failure');
        const steps = jobs.flatMap((j) => (j.steps ?? []).filter((s) => s.conclusion === 'failure').map((s) => `${j.name} › ${s.name}`));
        const broken = await this.gh.commit(repo, run.head_sha);
        const fix = await this.findFix(repo, run);
        const environment = `${run.name} workflow, GitHub Actions${info.language ? `, ${info.language}` : ''}`;
        const failure = await this.hub.node.submit({
          kind: 'failure',
          context: { task: `CI "${run.name}" on ${repo}`, domain, environment },
          body: { approach: firstLine(broken.message), outcome: 'error', error_summary: steps.length ? `failed at ${steps.slice(0, 3).join('; ')}` : `${run.name} failed`, confidence: 0.9 },
          evidence: [run.html_url, broken.html_url, ...jobs.map((j) => j.html_url)].slice(0, 8),
        }, { publish: true });
        report.failures++;
        if (fix) {
          const issues = [];
          for (const n of [...new Set([...fix.commit.message.matchAll(/(?:^|\s)#(\d+)\b/g)].map((m) => Number(m[1])))].slice(0, 3)) { const i = await this.gh.issue(repo, n); if (i) issues.push(i); }
          await this.hub.node.submit({
            kind: 'answer',
            context: { task: `fix CI "${run.name}" on ${repo}`, domain, environment },
            body: {
              question: `How was "${run.name}" ${steps.length ? `failing at ${steps[0]}` : 'failing'} fixed in ${repo}?`,
              answer: `${firstLine(fix.commit.message)}${fix.commit.files?.length ? ` (changed: ${fix.commit.files.slice(0, 6).map((f) => f.filename).join(', ')})` : ''}${issues.length ? `. Related: ${issues.map((i) => `#${i.number} ${i.title}`).join('; ')}` : ''}`,
              proof: { type: 'test', detail: `the next "${run.name}" run passed: ${fix.run.html_url}` },
            },
            refs: [failure.record.id],
            evidence: [fix.commit.html_url, fix.run.html_url, ...issues.map((i) => i.html_url)],
          }, { publish: true });
          report.answers++;
        }
      } catch (e) {
        report.skipped.push({ run: run.id, reason: e instanceof PrivacyBlockedError ? `privacy scrubber blocked it: ${e.findings.map((f) => f.type).join(', ')}` : (e as Error).message });
      }
    }
    return report;
  }

  /** The fix: the first later successful run of the same workflow on the same branch. */
  private async findFix(repo: string, failed: Run) {
    const ok = (await this.gh.runs(repo, { status: 'success', branch: failed.head_branch, perPage: 50 }))
      .filter((r) => r.workflow_id === failed.workflow_id && r.conclusion === 'success' && r.created_at > failed.created_at && r.head_sha !== failed.head_sha)
      .sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
    if (!ok) return null;
    return { run: ok, commit: await this.gh.commit(repo, ok.head_sha) };
  }
}
