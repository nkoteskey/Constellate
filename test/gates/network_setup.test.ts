import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Hub } from '../../src/hub/hub.js';
import { LocalSigner } from '../../src/core/identity.js';
import { FakeMesh, FakeDaemon } from '../../src/x0x/fake.js';
import { X0xClient } from '../../src/x0x/client.js';
import { createMcpServer, networkNote } from '../../src/mcp/server.js';
import { ManagedX0x, X0X_SHA256, X0X_VERSION, networkChoice, hostPlatform } from '../../src/x0x/managed.js';
import { joinNetwork } from '../../src/x0x/join.js';

/**
 * The network for people using Constellate through npm (docs/NETWORK.md): x0x is set up on its own (pinned,
 * checksum-checked), the running session switches onto it without a restart, what was shared offline goes out,
 * and the agent is told in plain words. The real daemon is exercised when its release archive is available
 * (CONSTELLATE_X0X_ARCHIVE); everything else runs on the stand-in network.
 */
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('joining the network from the npm package', () => {
  it('pins the same x0x release and checksums as the desktop app', () => {
    const desktop = readFileSync(join(import.meta.dirname, '../../desktop/scripts/fetch-x0x.mjs'), 'utf8');
    expect(desktop).toContain(`X0X_VERSION = '${X0X_VERSION}'`);
    for (const [platform, sum] of Object.entries(X0X_SHA256)) expect(desktop, platform).toContain(`'${platform}': '${sum}'`);
    expect(hostPlatform('darwin', 'arm64')).toBe('macos-arm64');
    expect(hostPlatform('freebsd', 'x64')).toBeNull();
  });

  it('joins by default; CONSTELLATE_X0X=ask waits for network_join, =off never joins', () => {
    expect(networkChoice({})).toBe('auto');
    expect(networkChoice({ CONSTELLATE_X0X: 'ask' })).toBe('ask');
    expect(networkChoice({ CONSTELLATE_X0X: 'off' })).toBe('off');
  });

  it('a running session switches onto the network without a restart, and what it shared offline goes out', async () => {
    const home = mkdtempSync(join(tmpdir(), 'net-'));
    process.env.CONSTELLATE_HOME = home;
    try {
      const keyFile = join(home, 'agent.key');
      const hub = new Hub({ signer: LocalSigner.loadOrCreate(keyFile), preview: false });
      const offlineId = hub.node.agentId;
      const { record: before } = await hub.node.submit({ kind: 'failure', context: { task: 'Bundle the docs site', domain: ['software'], environment: 'node 22' }, body: { approach: 'Upgrade the bundler a major version', outcome: 'error' } }, { publish: true });

      const mesh = new FakeMesh();
      const mine = await new FakeDaemon(mesh, 'mine').start(), theirs = await new FakeDaemon(mesh, 'theirs').start();
      const other = await Hub.fromEnv({ ...process.env, CONSTELLATE_HOME: mkdtempSync(join(tmpdir(), 'net-other-')), X0X_API: theirs.url, X0X_TOKEN: theirs.token, CONSTELLATE_QUIET: '1', CONSTELLATE_PREVIEW: 'off' });
      let hooked = 0;
      hub.onOnline(() => hooked++);
      expect(await hub.goOnline(new X0xClient(mine.url, mine.token))).toBe(true);
      expect(hooked).toBe(1);
      expect(hub.node.agentId).not.toBe(offlineId); // signs as its x0x identity from now on
      expect(networkNote(hub)).toMatch(/^Connected to the x0x network/);

      for (let i = 0; i < 80 && !other.node.store.get(before.id); i++) await wait(25);
      expect(other.node.store.get(before.id)).toBeTruthy(); // the offline share went out
      const { record: after } = await hub.node.submit({ kind: 'failure', context: { task: 'Bundle the docs site', domain: ['software'], environment: 'node 22' }, body: { approach: 'Pin the old bundler', outcome: 'too_slow' } }, { publish: true });
      for (let i = 0; i < 80 && !other.node.store.get(after.id); i++) await wait(25);
      expect(other.node.store.get(after.id)?.rec.agent_id).toBe(hub.node.agentId); // and new ones go out live
      let late = 0; hub.onOnline(() => late++); expect(late).toBe(1); // a hook added later runs at once
      await other.close();
    } finally { delete process.env.CONSTELLATE_HOME; }
  });

  it('an agent offline gets network_join and is told where it stands, in plain words', async () => {
    process.env.CONSTELLATE_HOME = mkdtempSync(join(tmpdir(), 'net-'));
    process.env.CONSTELLATE_X0X = 'ask';
    try {
      const hub = new Hub({ signer: LocalSigner.generate(), preview: false });
      const server = createMcpServer(hub);
      const [a, b] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'claude-code', version: '1' });
      await Promise.all([server.connect(a), client.connect(b)]);
      expect((await client.listTools()).tools.map((t) => t.name)).toContain('network_join');
      const r = JSON.parse(((await client.callTool({ name: 'failures_search', arguments: { query: 'x' } })).content as { text: string }[])[0].text);
      expect(r.network).toMatch(/connects you to global agentic knowledge graphs.*Call network_join/);
      hub.network = { state: 'joining', detail: '' };
      expect(networkNote(hub)).toMatch(/Setting it up now.*CONSTELLATE_X0X=off/);
      await client.close();
      process.env.CONSTELLATE_X0X = 'off';
      expect(networkNote(hub)).toMatch(/turned off/);
      const off = createMcpServer(new Hub({ signer: LocalSigner.generate(), preview: false }));
      const [c, d] = InMemoryTransport.createLinkedPair();
      const client2 = new Client({ name: 't', version: '1' });
      await Promise.all([off.connect(c), client2.connect(d)]);
      expect((await client2.listTools()).tools.map((t) => t.name)).not.toContain('network_join');
      await client2.close();
    } finally { delete process.env.CONSTELLATE_HOME; process.env.CONSTELLATE_X0X = 'off'; }
  });

  it('refuses an x0x download that doesn’t match its pinned checksum, and installs nothing', async () => {
    const home = mkdtempSync(join(tmpdir(), 'net-'));
    const fake = join(home, 'not-x0x.tar.gz');
    (await import('node:fs')).writeFileSync(fake, 'definitely not the release');
    process.env.CONSTELLATE_X0X_ARCHIVE = fake;
    try {
      const m = new ManagedX0x(home);
      if (!hostPlatform()) return;
      await expect(m.install()).rejects.toThrow(/didn’t match its pinned checksum.*nothing was installed/);
      expect(m.installed).toBe(false);
      expect(existsSync(m.binary)).toBe(false);
    } finally { delete process.env.CONSTELLATE_X0X_ARCHIVE; }
  });

  // The real daemon: set CONSTELLATE_TEST_X0X_ARCHIVE to the pinned release archive for this computer.
  it.skipIf(!process.env.CONSTELLATE_TEST_X0X_ARCHIVE)('with the real x0x release: installs, starts in the background, joins, and leaves', async () => {
    const home = mkdtempSync(join(tmpdir(), 'net-real-'));
    process.env.CONSTELLATE_X0X_ARCHIVE = process.env.CONSTELLATE_TEST_X0X_ARCHIVE;
    const m = new ManagedX0x(home, true);
    try {
      const hub = new Hub({ signer: LocalSigner.loadOrCreate(join(home, 'agent.key')), preview: false });
      await joinNetwork(hub, { home, env: { CONSTELLATE_X0X_OFFLINE: '1' } });
      expect(m.installed).toBe(true);
      expect(hub.x0x).toBeTruthy();
      expect(hub.network.state).toBe('online');
      expect((await m.status()).running).toBe(true);
      // A second process on this computer reuses the same daemon.
      expect((await m.running())?.dir).toBe(m.dataDir);
      await hub.close();
    } finally {
      m.setDisabled(true); await m.stop();
      expect((await m.status()).running).toBe(false);
      delete process.env.CONSTELLATE_X0X_ARCHIVE;
    }
  }, 60_000);
});
