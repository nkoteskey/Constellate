import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FakeMesh, FakeDaemon } from '../../src/x0x/fake.js';

/**
 * The two-computer check (scripts/two-computer-check.mjs, docs/NETWORK.md) run end to end, the way the owner
 * runs it on two real computers, but over the stand-in network: two separate Constellate homes, each behind its
 * own daemon, A shares a tagged failure and B finds it with failures_search and reports the delay.
 */
const root = join(import.meta.dirname, '../..');
const script = join(root, 'scripts/two-computer-check.mjs');
const cli = `${join(root, 'node_modules/.bin/tsx')} ${join(root, 'src/cli.ts')}`;

function run(args: string[], env: Record<string, string>) {
  const p = spawn(process.execPath, [script, ...args, '--cli', cli], { env: { ...process.env, CONSTELLATE_QUIET: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { out += d; });
  const done = new Promise<number>((r) => p.on('exit', (c) => r(c ?? 1)));
  return { done, out: () => out };
}

describe('two-computer check', () => {
  it('A shares a tagged failure, B sees it arrive and prints the delay', async () => {
    const mesh = new FakeMesh();
    const a = await new FakeDaemon(mesh, 'a').start(), b = await new FakeDaemon(mesh, 'b').start();
    const envA = { CONSTELLATE_HOME: mkdtempSync(join(tmpdir(), 'two-a-')), X0X_API: a.url, X0X_TOKEN: a.token };
    const envB = { CONSTELLATE_HOME: mkdtempSync(join(tmpdir(), 'two-b-')), X0X_API: b.url, X0X_TOKEN: b.token };

    const share = run(['share', '--stay', '20'], envA);
    let tag = '';
    for (let i = 0; i < 400 && !tag; i++) { tag = share.out().match(/^Tag: ([a-z0-9]{10})$/m)?.[1] ?? ''; await new Promise((r) => setTimeout(r, 50)); }
    expect(tag, share.out()).toMatch(/^[a-z0-9]{10}$/);

    const wait = run(['wait', tag, '--timeout', '40', '--every', '0.5'], envB);
    expect(await wait.done, wait.out()).toBe(0);
    expect(wait.out()).toMatch(/Arrived: failure [0-9a-f]{64}/);
    expect(wait.out()).toMatch(/Delay: \d+\.\d s/);
    expect(wait.out()).toContain('RESULT: ok');
    await share.done;
  }, 90_000);

  it('B refuses a malformed tag before connecting anywhere', async () => {
    const r = run(['wait', 'not a tag'], { CONSTELLATE_HOME: mkdtempSync(join(tmpdir(), 'two-x-')) });
    expect(await r.done).toBe(1);
    expect(r.out()).toMatch(/give the tag/);
  });

  it('0.2.0 everywhere the version is stated, with release notes', () => {
    const v = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
    expect(v).toBe('0.2.0');
    expect(JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')).version).toBe(v);
    const reg = JSON.parse(readFileSync(join(root, 'distribution/mcp-registry/server.json'), 'utf8'));
    expect([reg.version, reg.packages[0].version]).toEqual([v, v]);
    expect(JSON.parse(readFileSync(join(root, 'distribution/a2a/agent-card.example.json'), 'utf8')).version).toBe(v);
    for (const f of ['src/mcp/server.ts', 'src/economy/a2a.ts']) expect(readFileSync(join(root, f), 'utf8'), f).toContain(`version: '${v}'`);
    expect(readFileSync(join(root, `docs/releases/v${v}.md`), 'utf8')).toMatch(/two-computer-check/);
  });

  it('is documented for the owner', () => {
    const doc = readFileSync(join(root, 'docs/NETWORK.md'), 'utf8');
    expect(doc).toContain('two-computer-check.mjs share');
    expect(doc).toContain('two-computer-check.mjs wait');
  });
});
