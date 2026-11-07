import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { Hub } from '../../src/hub/hub.js';
import { LocalSigner } from '../../src/core/identity.js';
import { MemoryNetwork } from '../../src/transport/bus.js';
import { Seeder, SEED_ALLOW_LIST } from '../../src/seed/seeder.js';
import { GitHubSource, Run, Job, Commit, Issue, RepoInfo } from '../../src/seed/github.js';
import { exportSnapshot } from '../../src/seed/snapshot.js';
import { ClosedIdentityError } from '../../src/hub/node.js';
import { connect } from '../helpers.js';

/**
 * GATE 1 (Amendment 1, seeding the cold start):
 * seeded records appear for both allow-listed repos with working source links;
 * a non-allow-listed repo produces zero records; a private-mode search sends
 * nothing over the network (verified by capturing every socket and fetch);
 * a closed-project identity's publish attempt is refused.
 * Live GitHub: READY FOR HUMAN TESTING (`constellate seed`); api.github.com is not reachable from the build session.
 */
class FixtureGitHub implements GitHubSource {
  calls: string[] = [];
  constructor(private readonly data: Record<string, { info: RepoInfo; runs: Run[]; jobs: Record<number, Job[]>; commits: Record<string, Commit>; issues: Record<number, Issue> }>) {}
  private d(f: string) { this.calls.push(f); const x = this.data[f]; if (!x) throw Object.assign(new Error('404'), { status: 404 }); return x; }
  async repo(f: string) { return this.d(f).info; }
  async runs(f: string, o: { status?: string; branch?: string }) { return this.d(f).runs.filter((r) => (!o.status || r.conclusion === o.status) && (!o.branch || r.head_branch === o.branch)); }
  async jobs(f: string, id: number) { return this.d(f).jobs[id] ?? []; }
  async commit(f: string, sha: string) { return this.d(f).commits[sha]; }
  async issue(f: string, n: number) { return this.d(f).issues[n] ?? null; }
}

function repoFixture(full: string, priv = false) {
  const u = `https://github.com/${full}`;
  const run = (id: number, sha: string, conclusion: string, day: number): Run => ({ id, name: 'CI', head_branch: 'main', head_sha: sha, conclusion, status: 'completed', html_url: `${u}/actions/runs/${id}`, created_at: `2026-10-0${day}T10:00:00Z`, workflow_id: 7, event: 'push' });
  return {
    info: { full_name: full, private: priv, html_url: u, language: 'TypeScript', topics: ['agents'] },
    runs: [run(101, 'aaa', 'failure', 1), run(102, 'bbb', 'success', 2)],
    jobs: { 101: [{ name: 'test', conclusion: 'failure', html_url: `${u}/actions/runs/101/job/1`, steps: [{ name: 'npm test', conclusion: 'failure' }] }] },
    commits: {
      aaa: { sha: 'aaa', html_url: `${u}/commit/aaa`, message: 'Bump vitest to 4.0' },
      bbb: { sha: 'bbb', html_url: `${u}/commit/bbb`, message: 'Pin vitest to 3.2 until pool option lands (fixes #12)', files: [{ filename: 'package.json' }] },
    },
    issues: { 12: { number: 12, title: 'Tests hang after vitest upgrade', html_url: `${u}/issues/12`, state: 'closed' } },
  };
}

describe('GATE 1 — seeding the cold start', () => {
  it('seeds both allow-listed repos from the public trail, with source links, and nothing else', async () => {
    expect([...SEED_ALLOW_LIST]).toEqual(['nkoteskey/constellate', 'nkoteskey/daylight']);
    const gh = new FixtureGitHub({
      'nkoteskey/constellate': repoFixture('nkoteskey/constellate'),
      'nkoteskey/daylight': repoFixture('nkoteskey/daylight'),
      'someone/else': repoFixture('someone/else'),
    });
    const netw = new MemoryNetwork();
    const hub = new Hub({ signer: LocalSigner.generate(), bus: netw.bus(), preview: false });
    const peer = new Hub({ signer: LocalSigner.generate(), bus: netw.bus(), preview: false });
    const seeder = new Seeder(hub, gh);
    for (const r of SEED_ALLOW_LIST) {
      const rep = await seeder.seed(r);
      expect(rep).toMatchObject({ allowed: true, failures: 1, answers: 1 });
    }
    const other = await seeder.seed('someone/else');
    expect(other).toMatchObject({ allowed: false, failures: 0, answers: 0 });
    expect(gh.calls).not.toContain('someone/else'); // default deny: never even fetched

    const records = hub.node.store.all();
    expect(records).toHaveLength(4);
    for (const s of records) {
      expect(s.rec.evidence.length).toBeGreaterThan(0);
      for (const url of s.rec.evidence) expect(url).toMatch(/^https:\/\/github\.com\/nkoteskey\/(constellate|daylight)\/(actions\/runs\/\d+(\/job\/\d+)?|commit\/\w+|issues\/\d+)$/);
    }
    const ans = hub.ledger.lookupAnswers('CI npm test failing vitest', { limit: 2 });
    expect(ans[0].answer).toMatch(/Pin vitest to 3.2.*Tests hang after vitest upgrade/);
    expect(peer.node.store.size).toBe(4); // gossiped like any other record
    expect((await seeder.seed('nkoteskey/daylight')).skipped[0].reason).toBe('already seeded'); // idempotent
  });

  it('refuses a private repo even if it is allow-listed, and still scrubs public text', async () => {
    const leaky = repoFixture('nkoteskey/daylight');
    leaky.commits.aaa.message = 'Try deploy with key AKIAABCDEFGHIJKLMNOP';
    const gh = new FixtureGitHub({ 'nkoteskey/constellate': repoFixture('nkoteskey/constellate', true), 'nkoteskey/daylight': leaky });
    const hub = new Hub({ signer: LocalSigner.generate(), preview: false });
    expect(await new Seeder(hub, gh).seed('nkoteskey/constellate')).toMatchObject({ allowed: false, reason: expect.stringMatching(/private/) });
    const rep = await new Seeder(hub, gh).seed('nkoteskey/daylight');
    expect(rep.failures).toBe(0);
    expect(rep.skipped[0].reason).toMatch(/privacy scrubber blocked it: aws_access_key/);
    expect(hub.node.store.size).toBe(0);
  });

  it('private read mode searches a snapshot with zero network traffic, and refuses to publish', async () => {
    // A public hub with some knowledge, exported as a snapshot.
    const pub = new Hub({ signer: LocalSigner.generate(), preview: false });
    await new Seeder(pub, new FixtureGitHub({ 'nkoteskey/constellate': repoFixture('nkoteskey/constellate') })).seed('nkoteskey/constellate');
    const home = mkdtempSync(join(tmpdir(), 'closed-'));
    writeFileSync(join(home, 'snapshot.cbor'), exportSnapshot(pub.node.store));

    // Capture every outbound connection and fetch from here on.
    const sockets: string[] = [];
    const origConnect = net.Socket.prototype.connect;
    const origFetch = globalThis.fetch;
    net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) { sockets.push(JSON.stringify(args[0]).slice(0, 80)); return (origConnect as (...a: unknown[]) => net.Socket).apply(this, args); } as typeof origConnect;
    globalThis.fetch = (async (...a: Parameters<typeof fetch>) => { sockets.push(`fetch ${String(a[0])}`); return origFetch(...a); }) as typeof fetch;
    try {
      const closed = await Hub.privateMode({ CONSTELLATE_HOME: home, X0X_API: 'http://127.0.0.1:12700' });
      expect(closed.node.readOnly).toBe(true);
      const { call } = await connect(closed);
      const r = await call('failures_search', { query: 'vitest npm test CI' });
      expect(r.results.length).toBe(1);
      expect((await call('answers_lookup', { question: 'how was CI fixed vitest' })).results[0].answer).toMatch(/Pin vitest/);
      expect(sockets).toEqual([]); // nothing went over the network

      // A closed-project identity's publish attempt is refused, in the MCP server and in the node.
      const refused = await call('failures_report', { task: 'internal build', domain: ['ci'], environment: 'x', approach: 'a', outcome: 'error', error_summary: 'b', publish: true });
      expect(refused.isError).toBe(true);
      expect(refused.refused).toMatch(/closed-project identity/);
      await expect(closed.ledger.reportFailure({ task: 't', domain: ['x'], environment: '' }, { approach: 'a', outcome: 'error', error_summary: 'b' }, { publish: true })).rejects.toBeInstanceOf(ClosedIdentityError);
      await expect(closed.node.relay(pub.node.store.all()[0].rec)).rejects.toBeInstanceOf(ClosedIdentityError);
      expect(closed.node.agentId).not.toBe(pub.node.agentId);
      expect(sockets).toEqual([]);
    } finally {
      net.Socket.prototype.connect = origConnect;
      globalThis.fetch = origFetch;
    }
  });
});
