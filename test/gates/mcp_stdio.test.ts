import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hub } from '../../src/hub/hub.js';
import { LocalSigner } from '../../src/core/identity.js';
import { exportSnapshot } from '../../src/seed/snapshot.js';
import { FakeMesh, FakeDaemon } from '../../src/x0x/fake.js';
import { connect } from '../helpers.js';

/**
 * `constellate mcp` speaks MCP over stdio, the way strict clients and directory
 * checks (Glama, the Docker MCP Catalog) run it: stdout carries nothing but
 * JSON-RPC, from the very first run, and the server ends when the client hangs
 * up (closes stdin) or signals it, even with a daemon's event stream open. As a
 * container's first process Node ignores an unhandled SIGTERM, so both matter.
 */
function start(env: Record<string, string>) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'mcp'], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stderr.on('data', (d) => { err += d; });
  const listed = new Promise<void>((resolve) => child.stdout.on('data', (d) => { out += d; if (out.includes('"id":2')) resolve(); }));
  const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
  const send = (m: object) => child.stdin.write(JSON.stringify(m) + '\n');
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'gate', version: '1' } } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  /** Waits for tools/list, hangs up with `end`, and returns the exit code ('still running' after 15s). */
  const run = async (end: () => void) => {
    try {
      await listed;
      end();
      return await Promise.race([exited, new Promise<'still running'>((r) => setTimeout(() => r('still running'), 15_000))]);
    } finally { child.kill('SIGKILL'); }
  };
  return { child, run, out: () => out, err: () => err };
}

describe('mcp over stdio: protocol-only stdout, ends when the client goes', () => {
  it('first run with a starter library and no daemon: every stdout line is JSON-RPC, the note goes to stderr', async () => {
    const pub = new Hub({ signer: LocalSigner.generate(), preview: false });
    const { call } = await connect(pub);
    await call('failures_report', { task: 'pip install torch', domain: ['python'], environment: 'python 3.13', approach: 'pip install torch==2.1', outcome: 'error', error_summary: 'no wheel for python 3.13' });
    const dir = mkdtempSync(join(tmpdir(), 'constellate-stdio-'));
    const starter = join(dir, 'starter.cbor');
    writeFileSync(starter, exportSnapshot(pub.node.store));

    const s = start({ CONSTELLATE_HOME: join(dir, 'home'), CONSTELLATE_STARTER: starter, X0X_API: 'http://127.0.0.1:1' });
    expect(await s.run(() => s.child.stdin.end())).toBe(0);

    const lines = s.out().split('\n').filter((l) => l.trim());
    for (const l of lines) expect(() => JSON.parse(l), `non-JSON on stdout: ${l.slice(0, 120)}`).not.toThrow();
    expect(lines.map((l) => JSON.parse(l).jsonrpc)).toEqual(lines.map(() => '2.0'));
    const tools = JSON.parse(lines.find((l) => JSON.parse(l).id === 2)!).result.tools.map((t: { name: string }) => t.name);
    expect(tools).toContain('failures_search');
    expect(s.err()).toMatch(/Starter library: 1 signed lessons/);
  }, 60_000);

  for (const [how, end] of [['closing stdin', (c: ReturnType<typeof start>['child']) => c.stdin.end()], ['SIGTERM', (c: ReturnType<typeof start>['child']) => c.kill('SIGTERM')]] as const) {
    it(`connected to a daemon (event stream open): ${how} ends the server cleanly`, async () => {
      const daemon = await new FakeDaemon(new FakeMesh()).start();
      try {
        const dir = mkdtempSync(join(tmpdir(), 'constellate-stdio-'));
        const s = start({ CONSTELLATE_HOME: join(dir, 'home'), CONSTELLATE_STARTER: 'off', X0X_API: daemon.url, X0X_TOKEN: daemon.token });
        expect(await s.run(() => end(s.child))).toBe(0);
        expect(s.err()).toMatch(/Connected to x0x/);
      } finally { await daemon.stop(); }
    }, 60_000);
  }
});
