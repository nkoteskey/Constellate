import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { Presence } from '../../src/hub/activity.js';

/**
 * "N agents connected" means connected now: an agent's Constellate process keeps a presence file fresh while
 * it runs. Stale files, and files of processes that are gone, don't count and are cleaned up.
 */
describe('which agents are connected right now', () => {
  it('counts a running agent, and stops counting it when it leaves, goes quiet or its process is gone', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'online-')), 'agents-online');
    const p = new Presence(dir);
    expect(p.online()).toEqual([]);
    p.beat('claude-code', '2026-11-08T00:00:00Z');
    expect(p.online()).toEqual([{ client: 'Claude Code', since: '2026-11-08T00:00:00Z' }]);
    p.leave();
    expect(p.online()).toEqual([]);

    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '999991.json'), JSON.stringify({ client: 'Cursor', pid: process.pid, since: 'x', beat: new Date(Date.now() - 5 * 60_000).toISOString() })); // quiet for 5 minutes
    writeFileSync(join(dir, '999992.json'), JSON.stringify({ client: 'Cursor', pid: 2 ** 22 + 12345, since: 'x', beat: new Date().toISOString() })); // no such process
    expect(p.online()).toEqual([]);
    expect(existsSync(join(dir, '999991.json')) || existsSync(join(dir, '999992.json'))).toBe(false); // cleaned up
  });

  it('tests run in a throwaway home, never the real ~/.constellate (test/setup.ts)', () => {
    expect(homedir()).toMatch(/constellate-test-home-/);
  });
});
