import { describe, it, expect } from 'vitest';
import { mkdtempSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Hub } from '../../src/hub/hub.js';
import { LocalSigner } from '../../src/core/identity.js';
import { SignedRecord, signRecord, merkle, merkleRootFrom, verifyRecord } from '../../src/core/record.js';
import { canonicalBytes } from '../../src/core/canonical.js';
import { RecordStore } from '../../src/store/records.js';
import { makeBundle, openBundle } from '../../src/store/bundle.js';
import { FakeMesh, FakeDaemon } from '../../src/x0x/fake.js';
import { X0xClient, DaemonSigner } from '../../src/x0x/client.js';
import { createMcpServer } from '../../src/mcp/server.js';

/**
 * Storage and its cost (docs/STORAGE.md): compact bundles that keep every guarantee, packing on disk,
 * catching up from peers over x0x, and a lean default for agents.
 */
const ctx = { task: 'deploy', domain: ['x0x'], environment: 'node 22' };
const fail = (i: number) => ({ kind: 'failure' as const, context: ctx, body: { approach: `approach number ${i}`, outcome: 'error', error_summary: `it broke in way ${i}`, confidence: 0.7 } });
const tmp = () => mkdtempSync(join(tmpdir(), 'stor-'));

describe('storage: smaller, still verifiable, and shared with late joiners', () => {
  it('Merkle proofs lead every id to its root at any batch size, and nothing else does', () => {
    for (let n = 1; n <= 13; n++) {
      const ids = Array.from({ length: n }, (_, i) => canonicalBytes({ i, n }).reduce((h, b) => h + b.toString(16).padStart(2, '0'), '').padEnd(64, '0').slice(0, 64));
      const m = merkle(ids);
      for (const [id, p] of m.proofs) expect(merkleRootFrom(id, p.i, p.path, m.proofs.size)).toBe(m.root);
      const [id, p] = [...m.proofs][0];
      if (n > 1) expect(merkleRootFrom(id, p.i + 1 < n ? p.i + 1 : p.i - 1, p.path, n)).not.toBe(m.root);
    }
  });

  it('a bundle keeps every guarantee at a fraction of the size, and refuses forgeries', async () => {
    const a = LocalSigner.generate(), b = LocalSigner.generate();
    const recs: SignedRecord[] = [];
    for (let i = 0; i < 40; i++) recs.push(await signRecord(fail(i), i % 4 ? a : b) as SignedRecord);
    const aIds = recs.filter((r) => r.agent_id === a.agentId).map((r) => r.id);
    const m = merkle(aIds);
    const root = await signRecord({ kind: 'batch_root', context: { task: 'batch', domain: ['storage'], environment: '' }, body: { root: m.root, count: m.proofs.size } }, a) as SignedRecord;
    const bytes = makeBundle(recs, [{ root, ids: aIds }]);
    const asSent = recs.reduce((n, r) => n + canonicalBytes(r).length, 0);
    expect(bytes.length).toBeLessThan(asSent / 4); // keys once, binary, one signature for author a's 30 records

    const store = new RecordStore();
    const { roots, records } = openBundle(bytes);
    for (const r of [...roots, ...records]) expect(store.add(r)).not.toBeNull();
    expect(store.all().length).toBe(41);
    expect(records.find((r) => r.agent_id === a.agentId)!.signature).toBe('');

    // Tampering: change a covered record's text; a proof pointing at someone else's root; a missing root.
    const covered = records.find((r) => r.batch)!;
    const fresh = new RecordStore(); fresh.add(root);
    expect(verifyRecord({ ...covered, body: { ...covered.body, approach: 'rewritten' } }, { root: (id) => fresh.get(id)?.rec }).ok).toBe(false);
    const bRoot = await signRecord({ kind: 'batch_root', context: { task: 'batch', domain: ['storage'], environment: '' }, body: { root: m.root, count: m.proofs.size } }, b) as SignedRecord;
    fresh.add(bRoot);
    expect(verifyRecord({ ...covered, batch: { ...covered.batch!, root: bRoot.id } }, { root: (id) => fresh.get(id)?.rec }).ok).toBe(false);
    expect(verifyRecord(covered).ok).toBe(false);
  });

  it('packs history into a compact segment on disk, survives a restart, and remembers what was pruned', async () => {
    const home = tmp();
    process.env.CONSTELLATE_HOME = home;
    try {
      const dir = join(home, 'records');
      const hub = new Hub({ signer: LocalSigner.generate(), store: new RecordStore(dir), preview: false });
      for (let i = 0; i < 25; i++) await hub.node.submit(fail(i), { publish: true });
      const other = LocalSigner.generate();
      const old = await signRecord({ ...fail(99), created: '2020-01-01T00:00:00.000Z' }, other) as SignedRecord;
      hub.node.ingest(old);
      const before = hub.node.store.diskUsage();
      const r = await hub.storage.compact();
      expect(r.records).toBe(27); // 25 failures, the stranger's record, and this computer's batch root
      expect(readdirSync(join(dir, 'public')).filter((f) => f.endsWith('.cbor'))).toEqual([]);
      expect(hub.node.store.diskUsage().segments).toBeLessThan(before.loose / 3);

      const reopened = new RecordStore(dir);
      expect(reopened.all().length).toBe(hub.node.store.all().length);

      const dry = hub.storage.prune({ keepDays: 30 });
      expect(dry).toMatchObject({ records: 1, applied: false });
      hub.storage.prune({ keepDays: 30, apply: true });
      expect(new RecordStore(dir).get(old.id)).toBeUndefined(); // gone, and stays gone after a restart
      expect(new RecordStore(dir).all().length).toBe(26);
    } finally { delete process.env.CONSTELLATE_HOME; }
  });

  it('a computer that joins later catches up from a peer over x0x', async () => {
    process.env.CONSTELLATE_HOME = tmp();
    try {
      const mesh = new FakeMesh();
      const mk = async (name: string) => { const d = await new FakeDaemon(mesh, name).start(); const x0x = new X0xClient(d.url, d.token); return new Hub({ signer: await DaemonSigner.connect(x0x), preview: false, x0x }); };
      const veteran = await mk('veteran'), newcomer = await mk('newcomer');
      for (let i = 0; i < 60; i++) await veteran.node.submit(fail(i), { publish: false, private: false } as never).then(() => {});
      for (const s of veteran.node.store.all()) if (s.visibility !== 'public') veteran.node.store.setVisibility(s.rec.id, 'public');
      await veteran.storage.batchOwn();
      for (const h of [veteran, newcomer]) h.x0x!.directEvents((m) => { h.sync.handle(m.sender, m.payload); });
      await new Promise((r) => setTimeout(r, 100));
      expect(newcomer.node.store.all().filter((s) => s.rec.kind === 'failure').length).toBe(0);
      expect(await newcomer.sync.request([veteran.node.agentId])).toBe(1);
      for (let i = 0; i < 50 && !newcomer.sync.results.length; i++) await new Promise((r) => setTimeout(r, 100));
      expect(newcomer.sync.results[0]).toMatchObject({ from: veteran.node.agentId, refused: 0 });
      expect(newcomer.node.store.all().filter((s) => s.rec.kind === 'failure').length).toBe(60);
    } finally { delete process.env.CONSTELLATE_HOME; }
  });

  it('agents get a lean tool list by default (about a fifth of the tokens); the full set on request', async () => {
    const list = async (mode?: 'lean' | 'full') => {
      const server = createMcpServer(new Hub({ signer: LocalSigner.generate(), preview: false }), mode ? { mode } : {});
      const [a, b] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 't', version: '1' });
      await Promise.all([server.connect(a), client.connect(b)]);
      const t = (await client.listTools()).tools;
      await client.close();
      return t;
    };
    const lean = await list(), full = await list('full');
    expect(lean.map((t) => t.name).sort()).toEqual(['answers_lookup', 'answers_submit', 'bounties', 'bounty_post', 'failures_report', 'failures_search', 'skills_find']);
    expect(full.length).toBeGreaterThan(40);
    expect(JSON.stringify(lean).length).toBeLessThan(JSON.stringify(full).length / 3);
  });
});
