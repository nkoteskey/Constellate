import { describe, it, expect } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hub } from '../../src/hub/hub.js';
import { LocalArchive } from '../../src/store/archive.js';
import { connect } from '../helpers.js';

/** GATE 7: agents carry memory across sessions and platforms. */
describe('GATE 7 — private memory', () => {
  it('a note written from one client in one session is read from another client in a later session, and nowhere else', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cst-home-'));
    const archiveDir = mkdtempSync(join(tmpdir(), 'cst-archive-')); // stands in for Autonomi: shared, permanent
    const env = { CONSTELLATE_HOME: home, X0X_API: 'http://127.0.0.1:1', CONSTELLATE_ARCHIVE: archiveDir };

    // Session 1, "Claude Code" on the laptop.
    const s1 = await Hub.fromEnv(env);
    const c1 = await connect(s1);
    expect((await c1.call('memory_put', { name: 'project/deploy-notes', value: 'Shuttle needs ring 0.17 pinned; use --features rustls. API key lives in 1Password, not here.' })).bytes).toBeGreaterThan(10);
    await c1.call('memory_put', { name: 'prefs/style', value: 'User prefers small PRs.' });
    await s1.close();

    // Session 2, a different client ("Cursor") on the same identity, days later: nothing in RAM, nothing in the local record store.
    const s2 = await Hub.fromEnv(env);
    const c2 = await connect(s2);
    expect((await c2.call('memory_get', { name: 'project/deploy-notes' })).value).toMatch(/ring 0.17/);
    expect((await c2.call('memory_list', { prefix: 'prefs/' })).entries.map((e: { name: string }) => e.name)).toEqual(['prefs/style']);

    // Another machine: only the backed-up identity/memory key files are copied over.
    const home2 = mkdtempSync(join(tmpdir(), 'cst-home2-'));
    for (const f of ['memory.key']) (await import('node:fs')).copyFileSync(join(home, f), join(home2, f));
    const s3 = await Hub.fromEnv({ ...env, CONSTELLATE_HOME: home2 });
    expect((await (await connect(s3)).call('memory_get', { name: 'prefs/style' })).value).toBe('User prefers small PRs.');

    // A different agent sharing the same archive sees nothing.
    const other = await Hub.fromEnv({ ...env, CONSTELLATE_HOME: mkdtempSync(join(tmpdir(), 'cst-other-')) });
    expect((await (await connect(other)).call('memory_get', { name: 'prefs/style' })).value).toBeNull();

    // The archive holds no plaintext, and memory never became a public record.
    const blobs = readdirSync(join(archiveDir, 'chunks')).map((f) => readFileSync(join(archiveDir, 'chunks', f)).toString('latin1')).join('');
    expect(blobs).not.toMatch(/ring 0\.17|small PRs|deploy-notes|prefs\/style/);
    expect(s2.node.store.all().some((s) => s.rec.kind === 'memory')).toBe(false);
  });

  it('detects tampering with stored memory', async () => {
    const archive = new LocalArchive();
    const { PrivateMemory, MemoryKey } = await import('../../src/services/memory.js');
    const key = MemoryKey.generate();
    const m = new PrivateMemory(archive, key);
    await m.put('a', 'secret plan');
    const ptr = (archive as unknown as { ptr: Map<string, string> }).ptr;
    const name = [...ptr.keys()][0];
    const forged = await archive.put(new Uint8Array(64));
    await archive.setPointer(name, forged);
    await expect(new PrivateMemory(archive, key).get('a')).rejects.toThrow();
  });
});
