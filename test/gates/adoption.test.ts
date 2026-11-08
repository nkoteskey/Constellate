import { describe, it, expect } from 'vitest';
import { Hub } from '../../src/hub/hub.js';
import { LocalSigner } from '../../src/core/identity.js';
import { MemoryNetwork } from '../../src/transport/bus.js';
import { LocalArchive } from '../../src/store/archive.js';
import { fixHitRate } from '../../src/hub/metrics.js';
import { until } from '../helpers.js';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { RecordStore } from '../../src/store/records.js';
import { ciReport, ciCommand } from '../../src/watch/ci.js';

/**
 * What makes an agent want Constellate: a fix that works, shown by an honest number, arriving where the agent
 * already is (its CI, its hook), with skills it can trust because it can trial them or check who published them.
 */
const world = () => {
  const net = new MemoryNetwork(), archive = new LocalArchive();
  return () => new Hub({ signer: LocalSigner.generate(), bus: net.bus(), archive, preview: false });
};
const ctx = { task: 'build the docs', domain: ['node'], environment: 'node 22' };

describe('the hit rate', () => {
  it('counts only other operators\' fix_tried reports on answers, and says "too few" instead of guessing', async () => {
    const mk = world();
    const author = mk(), b = mk(), c = mk();
    const { record: fix } = await author.ledger.submitAnswer(ctx, { question: 'ESM import fails', answer: 'Add "type": "module".', proof: { type: 'test', detail: 'build passes' } }, { publish: true });
    await until(() => !!b.node.store.get(fix.id) && !!c.node.store.get(fix.id));
    await expect(author.tried(fix.id, { worked: true, environment: 'node 22' }, { publish: true })).rejects.toThrow(/own operator/); // the author's word doesn't count
    await b.tried(fix.id, { worked: true, environment: 'node 22', error_before: 'ERR_REQUIRE_ESM' }, { publish: true });
    await c.tried(fix.id, { worked: false, environment: 'node 20', error_before: 'ERR_REQUIRE_ESM', error_after: 'still ERR_REQUIRE_ESM' }, { publish: true });
    await b.confirm(fix.id, { note: 'looks right' }, { publish: true }); // a plain confirmation is not a try
    await until(() => fixHitRate(author.node.store).tried === 2);
    expect(fixHitRate(author.node.store)).toMatchObject({ tried: 2, worked: 1, by_operators: 2, rate: null });
    expect(fixHitRate(author.node.store, 2).rate).toBe(0.5);
    expect(author.metrics.report().fix_hit_rate).toMatchObject({ tried: 2, rate: null });
  });
});

// ── The GitHub Action: a red run gets the fixes others verified; the next green run says what got fixed ──

async function ciLedger() {
  const home = mkdtempSync(join(tmpdir(), 'ci-'));
  const author = new Hub({ signer: LocalSigner.generate(), store: new RecordStore(join(home, 'records')), preview: false });
  const c = { task: 'Run the test suite', domain: ['node'], environment: 'node 22' };
  const { record: failure } = await author.ledger.reportFailure(c, { approach: 'Run tests after upgrading the bundler', outcome: 'error', error_summary: 'Error: Cannot find module legacy-plugin' }, { publish: true });
  const { record: fix } = await author.ledger.submitAnswer(c, { question: 'Cannot find module legacy-plugin', answer: 'Install the legacy plugin package separately: it left the core bundler.', proof: { type: 'test', detail: 'suite passes' } }, { publish: true, fixes: [failure.id] });
  const other = new Hub({ signer: LocalSigner.generate(), preview: false });
  other.node.ingest(failure); other.node.ingest(fix);
  author.node.ingest((await other.tried(fix.id, { worked: true, environment: 'node 22', error_before: 'Cannot find module legacy-plugin' }, { publish: true })).record);
  const count = () => author.node.store.all().length;
  return { home, fix, count };
}
const LOG = 'FAIL test/build.test.ts\nError: Cannot find module legacy-plugin\n    at /home/runner/work/app/src/build.ts:3:9\nTests: 1 failed';

describe('the CI Action', () => {
  it('a red run lists verified fixes; the next green run says what got fixed and how to report it', () => {
    const find = () => [{ id: 'a'.repeat(64), fix: 'Install the legacy plugin package separately.', for: 'Cannot find module legacy-plugin', trust: 'confirmed on 1 other computer', verified: true }];
    const red = ciReport({ log: LOG, exitCode: 1, command: 'npm test', sha: '1111111aaaa', find });
    expect(red.summary).toContain('Fixes other agents verified');
    expect(red.summary).toContain('a'.repeat(64));
    expect(red.summary).not.toContain('/home/runner'); // cleaned on the runner
    expect(red.annotations[0]).toMatch(/^::warning title=Constellate: a verified fix for this error::Install the legacy plugin/);
    expect(red.state).toMatchObject({ failed: true, sha: '1111111aaaa' });
    expect(red.outputs).toMatchObject({ suggested: '1', fixed_since_red: 'false' });

    const green = ciReport({ log: 'Tests: 12 passed', exitCode: 0, prev: red.state, sha: '2222222bbbb', find });
    expect(green.summary).toContain('Fixed since the last red run');
    expect(green.summary).toContain('`1111111` → `2222222`');
    expect(green.summary).toContain('fix_tried');
    expect(green.annotations[0]).toMatch(/^::notice title=Constellate: fixed since the last red run::/);
    expect(green.outputs.fixed_since_red).toBe('true');

    const quiet = ciReport({ log: 'ok', exitCode: 0, prev: green.state, find });
    expect(quiet).toMatchObject({ summary: '', annotations: [], outputs: { fixed_since_red: 'false' } });
    const none = ciReport({ log: 'Error: zzz qqq unknown', exitCode: 2, find: () => [] });
    expect(none.summary).toContain('Nothing on the network matches this error yet');
  });

  it('constellate ci reads this computer\'s ledger, writes the summary, outputs and state, and publishes nothing', async () => {
    const { home, fix, count } = await ciLedger();
    const before = count();
    const dir = mkdtempSync(join(tmpdir(), 'ci-run-'));
    const env = { CONSTELLATE_HOME: home, CONSTELLATE_STARTER: 'off', GITHUB_STEP_SUMMARY: join(dir, 'summary.md'), GITHUB_OUTPUT: join(dir, 'out.txt') };
    writeFileSync(join(dir, 'log.txt'), LOG);
    const printed: string[] = [];
    ciCommand(['--log', join(dir, 'log.txt'), '--exit-code', '1', '--command', 'npm test', '--state', join(dir, 'state.json'), '--sha', 'abc1234'], env, (s) => printed.push(s));
    expect(readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8')).toContain(fix.id);
    expect(readFileSync(env.GITHUB_OUTPUT, 'utf8')).toMatch(/^suggested=1$/m);
    expect(printed.join('')).toMatch(/::warning title=Constellate/);
    expect(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))).toMatchObject({ failed: true, sha: 'abc1234' });
    expect(new RecordStore(join(home, 'records')).all().length).toBe(before);
  });

  it('action.yml never puts an input inside a script (no injection), and its steps work as written', async () => {
    const yml = readFileSync(join(import.meta.dirname, '../../action.yml'), 'utf8');
    // Pull out each step's `run: |` script.
    const scripts = new Map<string, string>();
    const lines = yml.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = /^(\s+)run: \|$/.exec(lines[i]);
      if (!m) continue;
      const body: string[] = [];
      let j = i + 1;
      for (; j < lines.length && (lines[j].trim() === '' || lines[j].search(/\S/) > m[1].length); j++) body.push(lines[j].slice(m[1].length + 2));
      let k = i; while (k > 0 && !/^\s+- /.test(lines[k])) k--;
      const id = /id: (\w+)/.exec(lines.slice(k, i).join('\n'))?.[1] ?? `step${scripts.size}`;
      scripts.set(id, body.join('\n'));
    }
    expect([...scripts.keys()]).toEqual(expect.arrayContaining(['key', 'run', 'lookup']));
    for (const [id, s] of scripts) expect(s, id).not.toContain('${{');

    // Run the real steps: a red run, then a green one, with Constellate from this checkout.
    const { home, fix } = await ciLedger();
    const tmp = mkdtempSync(join(tmpdir(), 'ci-action-'));
    const DIR = join(tmp, 'constellate-ci');
    const base = { ...process.env, RUNNER_TEMP: tmp, GITHUB_SHA: 'feedbee1', DIR, CONSTELLATE_STARTER: 'off', CONSTELLATE_HOME: home, CONSTELLATE_CLI: `${process.execPath} ${join(import.meta.dirname, '../../node_modules/tsx/dist/cli.mjs')} ${join(import.meta.dirname, '../../src/cli.ts')}` };
    const step = (id: string, env: Record<string, string>) => {
      const out = join(tmp, `${id}-out.txt`); writeFileSync(out, '');
      execFileSync('bash', ['-c', scripts.get(id)!], { env: { ...base, ...env, GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: join(tmp, 'summary.md') }, stdio: 'pipe' });
      return Object.fromEntries(readFileSync(out, 'utf8').trim().split('\n').filter(Boolean).map((l) => l.split(/=(.*)/s).slice(0, 2)));
    };
    step('key', { WF: 'CI', JOB: 'test', REF: 'main', GITHUB_RUN_ID: '1', GITHUB_RUN_ATTEMPT: '1' });
    const red = step('run', { CONSTELLATE_RUN: `printf 'Error: Cannot find module legacy-plugin\\n'; exit 3` });
    expect(red['exit-code']).toBe('3');
    expect(step('lookup', { CODE: '3', CONSTELLATE_COMMAND: 'npm test', CONSTELLATE_VERSION: 'latest' })).toMatchObject({ suggested: '1' });
    expect(readFileSync(join(tmp, 'summary.md'), 'utf8')).toContain(fix.id);
    const green = step('run', { CONSTELLATE_RUN: 'echo all good' });
    expect(green['exit-code']).toBe('0');
    expect(step('lookup', { CODE: '0', CONSTELLATE_COMMAND: 'npm test', CONSTELLATE_VERSION: 'latest' })).toMatchObject({ fixed_since_red: 'true' });
    expect(readFileSync(join(tmp, 'summary.md'), 'utf8')).toContain('Fixed since the last red run');
    // Green after green: no lookup at all.
    expect(step('lookup', { CODE: '0', CONSTELLATE_CLI: 'false' })).toMatchObject({ fixed_since_red: 'false' });
    expect(existsSync(join(DIR, 'state.json'))).toBe(true);
  }, 60_000);
});

describe('official skills, checkably', () => {
  it('a skill is Official only when its repository lists the identity that signed it', async () => {
    const { parseOfficial, officialFile, officialFileUrl } = await import('../../src/economy/official.js');
    const mk = world();
    const org = mk(), someone = mk();
    expect(parseOfficial(officialFile([org.node.agentId]))).toEqual([org.node.agentId]);
    expect(parseOfficial('{"version":2,"signers":[]}')).toEqual([]);
    expect(parseOfficial('not json')).toEqual([]);
    expect(parseOfficial(JSON.stringify({ version: 1, signers: ['short', 42] }))).toEqual([]);

    const card = (name: string) => ({ name, description: 'Start the x0x daemon and check it is healthy.', capabilities: ['x0x'], price: 0, instructions: 'Run x0x start, then x0x health.', tests: [{ input: 'Which command starts the daemon? Last word.', check: { expected: 'start' } }], verifier: 'exact',
      source: { org: 'Saorsa Labs', repo: 'saorsa-labs/x0x', path: 'SKILL.md', commit: 'v0.49.0', url: 'https://github.com/saorsa-labs/x0x/blob/v0.49.0/SKILL.md' } });
    const { record: real } = await org.skills.publish(card('Start x0x (from Saorsa Labs)'));
    const { record: copy } = await someone.skills.publish(card('Start x0x (a copy)'));
    await until(() => !!org.node.store.get(copy.id));

    const fetched: string[] = [];
    org.skills.official.setFetcher(async (url) => { fetched.push(url); return url.includes('saorsa-labs/x0x') ? { ok: true, status: 200, text: async () => officialFile([org.node.agentId]) } : { ok: false, status: 404, text: async () => '' }; });
    expect(org.skills.catalog().skills.find((k) => k.id === real.id)!.official).toBe(false); // not checked yet: not shown
    await org.skills.official.refresh(org.skills.sourceRepos());
    expect(fetched).toEqual([officialFileUrl('saorsa-labs/x0x')]);
    const c = org.skills.catalog();
    expect(c.skills.find((k) => k.id === real.id)).toMatchObject({ official: true, group: 'network', from: 'Saorsa Labs (saorsa-labs/x0x)' });
    expect(c.skills.find((k) => k.id === copy.id)!.official).toBe(false); // same source, wrong signer
    expect(c.skills[0].id).toBe(real.id); // official first in its group
    await org.skills.official.refresh(org.skills.sourceRepos());
    expect(fetched).toHaveLength(1); // checked at most every six hours

    // A network failure is "unknown", never "official".
    const flaky = mk();
    flaky.node.ingest(org.node.store.get(real.id)!.rec);
    flaky.skills.official.setFetcher(async () => { throw new Error('offline'); });
    await flaky.skills.official.refresh(flaky.skills.sourceRepos());
    expect(flaky.skills.catalog().skills.find((k) => k.id === real.id)!.official).toBe(false);
  });

  it('skills_publish takes a source, and still needs test cases', async () => {
    const { connect } = await import('../helpers.js');
    const { call } = await connect(world()());
    const base = { name: 'n', description: 'd', capabilities: ['x'], price: 0, instructions: 'i', verifier: 'exact', source: { org: 'O', repo: 'o/r', path: 'SKILL.md', commit: 'abc', url: 'https://github.com/o/r/blob/abc/SKILL.md' } };
    expect((await call('skills_publish', { ...base, tests: [] })).isError).toBe(true);
    expect((await call('skills_publish', { ...base, tests: [{ input: 'q', check: { expected: 'a' } }] })).isError).toBe(false);
  });
});

describe('fresh skills', () => {
  it('every imported skill matches its pin in skill-sources.json, and the weekly refresh opens a pull request, never publishes', () => {
    const seed = join(import.meta.dirname, '../../data/seed');
    const pins = JSON.parse(readFileSync(join(seed, 'skill-sources.json'), 'utf8')) as { repos: { repo: string; commit: string }[]; x0x: { repo: string; tag: string }; autonomi: { repo: string; commit: string } };
    const pin = (repo: string) => pins.repos.find((r) => r.repo === repo)?.commit ?? (repo === pins.x0x.repo ? pins.x0x.tag : repo === pins.autonomi.repo ? pins.autonomi.commit : undefined);
    for (const k of (JSON.parse(readFileSync(join(seed, 'agent-skills.json'), 'utf8')) as { skills: { name: string; source: { repo: string; commit: string; url: string } }[] }).skills) {
      expect(k.source.commit, k.name).toBe(pin(k.source.repo));
      expect(k.source.url, k.name).toContain(k.source.commit);
    }
    const wf = readFileSync(join(import.meta.dirname, '../../.github/workflows/skills-refresh.yml'), 'utf8');
    expect(wf).toMatch(/schedule:/);
    expect(wf).toContain('node scripts/refresh-skills.mjs');
    expect(wf).toContain('gh pr create');
    expect(wf).toContain('privacy_rule.test.ts');
    expect(wf).not.toMatch(/git push[^\n]*(main|--force)/); // its own branch, never main, never forced
  });
});
