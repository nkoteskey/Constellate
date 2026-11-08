import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Hub } from '../../src/hub/hub.js';
import { LocalSigner } from '../../src/core/identity.js';
import { FakeMesh, FakeDaemon } from '../../src/x0x/fake.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { profileProblem } from '../../src/collab/profiles.js';
import { toB64, utf8 } from '../../src/util/bytes.js';

/**
 * People who use Constellate only through an agent (no app) still contribute and can be reached: what their
 * agent shared while offline goes out once x0x is there, messages for their computer reach the agent with its
 * next reply, and the agent is told once when it's offline.
 */
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const env = (home: string, d?: FakeDaemon) => ({ ...process.env, CONSTELLATE_HOME: home, X0X_API: d ? d.url : 'http://127.0.0.1:1', X0X_TOKEN: d?.token ?? '', CONSTELLATE_X0X_START_TIMEOUT_MS: '500', CONSTELLATE_X0X_START_BACKOFF_MS: '10', CONSTELLATE_QUIET: '1', CONSTELLATE_PREVIEW: 'off' });

describe('people who use Constellate only through an agent', () => {
  it('what the agent shared while offline goes out the next time Constellate starts with x0x, once', async () => {
    const home = mkdtempSync(join(tmpdir(), 'reach-'));
    const offline = await Hub.fromEnv(env(home));
    expect(offline.x0x).toBeFalsy();
    const { record } = await offline.node.submit({ kind: 'failure', context: { task: 'Bundle the docs site', domain: ['software'], environment: 'node 22' }, body: { approach: 'Upgrade the bundler a major version', outcome: 'error', error_summary: 'Config format changed' } }, { publish: true });
    await offline.close();

    const mesh = new FakeMesh();
    const mine = await new FakeDaemon(mesh, 'mine').start(), theirs = await new FakeDaemon(mesh, 'theirs').start();
    const other = await Hub.fromEnv(env(mkdtempSync(join(tmpdir(), 'reach-other-')), theirs));
    const online = await Hub.fromEnv(env(home, mine));
    expect(await online.sendOfflineShares(home)).toBe(1);
    for (let i = 0; i < 40 && !other.node.store.get(record.id); i++) await wait(25);
    expect(other.node.store.get(record.id)?.rec.id).toBe(record.id); // it reached the network
    expect(await online.sendOfflineShares(home)).toBe(0); // and only once
    await Promise.all([online.close(), other.close()]);
  });

  it('messages for this computer reach the agent with its next reply, and it is told once when offline', async () => {
    process.env.CONSTELLATE_HOME = mkdtempSync(join(tmpdir(), 'reach-'));
    try {
      const hub = new Hub({ signer: LocalSigner.generate(), preview: false }); // no x0x
      const server = createMcpServer(hub);
      const [a, b] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'claude-code', version: '1' });
      await Promise.all([server.connect(a), client.connect(b)]);
      const call = async () => JSON.parse(((await client.callTool({ name: 'failures_search', arguments: { query: 'bundler upgrade' } })).content as { text: string }[])[0].text);

      const first = await call();
      expect(first.network).toMatch(/^Not on the network.*what you share stays here/); // (tests run with CONSTELLATE_X0X=off)
      expect((await call()).network).toBeUndefined(); // said once

      const sender = LocalSigner.generate().agentId;
      hub.people.receive(sender, toB64(utf8(JSON.stringify({ app: 'constellate', type: 'dm', text: 'Want to help with the Ramsey bounds?' }))));
      const next = await call();
      expect(next.messages).toEqual([expect.objectContaining({ from: sender, text: 'Want to help with the Ramsey bounds?' })]);
      expect(next.messages_note).toMatch(/Tell your person/);
      expect((await call()).messages).toBeUndefined(); // passed on once
      await client.close();
    } finally { delete process.env.CONSTELLATE_HOME; }
  });

  it('a profile can say it uses Constellate through an agent', () => {
    expect(profileProblem({ kind: 'agent', reach: 'agent' })).toBeNull();
    expect(profileProblem({ kind: 'agent', reach: 'app' })).toBeNull();
    expect(profileProblem({ kind: 'agent', reach: 'other' as 'app' })).toMatch(/reach/);
  });
});
