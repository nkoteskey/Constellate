import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { Hub } from '../../src/hub/hub.js';
import { LocalSigner } from '../../src/core/identity.js';
import { Seeder } from '../../src/seed/seeder.js';
import { GitHubRest } from '../../src/seed/github.js';

/**
 * Seeding from REAL public CI history: responses recorded from the GitHub API for
 * nkoteskey/daylight on 2026-11-06, replayed through the real REST client
 * (only fetch is stubbed), so the client's mapping of GitHub's shapes is tested.
 */
const fx = JSON.parse(readFileSync(new URL('../fixtures/daylight-ci.json', import.meta.url), 'utf8'));
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function replay() {
  const seen: string[] = [];
  globalThis.fetch = (async (input: string | URL) => {
    const u = new URL(String(input));
    seen.push(u.pathname + u.search);
    const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    const p = u.pathname.replace('/repos/nkoteskey/daylight', '');
    if (!u.pathname.startsWith('/repos/nkoteskey/daylight')) return json({ message: 'Not Found' }, 404);
    if (p === '') return json(fx.repo);
    if (p === '/actions/runs') {
      const status = u.searchParams.get('status'), branch = u.searchParams.get('branch');
      return json({ workflow_runs: fx.runs.filter((r: { conclusion: string; head_branch: string }) => (!status || r.conclusion === status) && (!branch || r.head_branch === branch)) });
    }
    let m = p.match(/^\/actions\/runs\/(\d+)\/jobs$/);
    if (m) return json({ jobs: fx.jobs[m[1]] ?? [] });
    m = p.match(/^\/commits\/(\w+)$/);
    if (m) return fx.commits[m[1]] ? json(fx.commits[m[1]]) : json({ message: 'Not Found' }, 404);
    return json({ message: 'Not Found' }, 404);
  }) as typeof fetch;
  return seen;
}

describe('GATE 1 — seeding from real Daylight CI history', () => {
  it('turns each real failing run and its fix into a linked failure and answer', async () => {
    const seen = replay();
    const hub = new Hub({ signer: LocalSigner.generate(), preview: false });
    const rep = await new Seeder(hub, new GitHubRest(undefined)).seed('nkoteskey/daylight');
    expect(rep).toMatchObject({ allowed: true, failures: 2, answers: 2, skipped: [] });
    expect(seen.every((p) => p.startsWith('/repos/nkoteskey/daylight'))).toBe(true);

    const fmt = hub.ledger.searchFailures('cargo fmt failure', { limit: 1 })[0];
    expect(fmt.error_summary).toBe('failed at fmt · clippy · test › cargo fmt');
    expect(fmt.approach).toBe('Reader navigation, reading-first Settings and a Civic list');
    expect(fmt.fixed_by).toHaveLength(1);
    const fix = hub.node.store.get(fmt.fixed_by[0])!;
    expect((fix.rec.body as { answer: string }).answer).toMatch(/^Score explainer, filter polish, and fix rustfmt on the bills test \(changed: crates\/daylight-app-core\/tests\/core.rs/);
    expect(fix.rec.evidence).toEqual([
      'https://github.com/nkoteskey/daylight/commit/35e3a482169ef036fd6ea45083572c4d7994f20d',
      'https://github.com/nkoteskey/daylight/actions/runs/41244454840',
    ]);

    const flaky = hub.ledger.searchFailures('cargo test failure', { limit: 1 })[0];
    expect(flaky.error_summary).toMatch(/cargo test$/);
    const flakyFix = hub.node.store.get(flaky.fixed_by[0])!;
    expect((flakyFix.rec.body as { answer: string }).answer).toMatch(/make the duress-wipe plaintext check robust/);

    // Nothing private: only first lines, file names and public URLs; the commit bodies and emails never enter a record.
    const all = JSON.stringify(hub.node.store.all().map((s) => s.rec));
    expect(all).not.toMatch(/noreply@anthropic\.com|Co-Authored-By|passcodes\.json/);
  });
});
