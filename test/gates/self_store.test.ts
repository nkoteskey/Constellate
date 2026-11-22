import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Hub } from '../../src/hub/hub.js';
import { LocalSigner } from '../../src/core/identity.js';
import { signRecord, verifyRecord } from '../../src/core/record.js';
import { LocalArchive } from '../../src/store/archive.js';
import { openBundle } from '../../src/store/bundle.js';
import { WebServer } from '../../src/web/server.js';
import { registerAppRoutes } from '../../src/web/app.js';

/**
 * Each contributor stores their own (docs/STORAGE.md): sharing is free, and anyone who wants their contributions
 * on Autonomi for good pays for exactly those from their own computer's wallet. No fund, no shared wallet. The
 * signed receipt proves the contribution; it can be published or kept private.
 */
const ctx = { task: 'a task', domain: ['ci'], environment: 'node 22' };
const failure = (i: number) => ({ kind: 'failure' as const, context: ctx, body: { approach: `approach ${i}`, outcome: 'error', error_summary: `broke ${i}`, confidence: 0.6 } });

describe('storing what you shared, paid by you', () => {
  it('stores exactly your public contributions, with a signed receipt anyone can check against the stored bundle', async () => {
    const home = mkdtempSync(join(tmpdir(), 'self-'));
    const archive = new LocalArchive(join(home, 'archive'));
    const hub = new Hub({ signer: LocalSigner.generate(), preview: false, archive });
    const mine: string[] = [];
    for (let i = 0; i < 3; i++) mine.push((await hub.node.submit(failure(i), { publish: true })).record.id);
    await hub.node.submit({ kind: 'vote', context: { task: 'vote', domain: ['collective'], environment: '' }, body: { problem: 'x', support: true } }, { publish: true });
    const other = new Hub({ signer: LocalSigner.generate(), preview: false });
    const theirs = (await other.node.submit(failure(9), { publish: true })).record;
    hub.node.ingest(theirs);
    // The person's browser key on this computer: theirs too, when the app says so.
    const browser = LocalSigner.generate();
    const fromBrowser = await signRecord({ kind: 'failure', context: { ...ctx, environment: 'human (browser)' }, body: { approach: 'by hand', outcome: 'error', error_summary: 'broke', confidence: 0.6 } }, browser);
    hub.node.ingest(fromBrowser);

    expect((await hub.selfStore.quote()).waiting).toBe(3); // not the vote, not someone else's
    expect((await hub.selfStore.quote(browser.agentId)).waiting).toBe(4);
    const r = (await hub.selfStore.run({ also: browser.agentId }))!;
    expect(r).toMatchObject({ stored: 4, archive: 'local', published: true });
    expect((await hub.selfStore.quote(browser.agentId)).waiting).toBe(0);

    // The receipt: signed, public, naming the bundle; the bundle holds the records with their own signatures.
    const receipt = hub.node.store.get(r.receipt)!;
    expect(receipt.visibility).toBe('public');
    expect(receipt.rec.body).toMatchObject({ type: 'self_store', address: r.address, records: 4, payer: hub.node.agentId });
    expect(verifyRecord(receipt.rec).ok).toBe(true);
    const bytes = (await archive.get(r.address))!;
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(r.bundle_sha256);
    const opened = openBundle(bytes).records;
    expect(opened.map((x) => x.id).sort()).toEqual([...mine, fromBrowser.id].sort());
    expect(opened.every((x) => verifyRecord(x).ok)).toBe(true);
    expect(opened.some((x) => x.id === theirs.id)).toBe(false);
    expect(hub.selfStore.proof(r.receipt)!.how_to_check[0]).toContain(r.address);

    // Private: stored the same, but the receipt stays on this computer.
    await hub.node.submit(failure(7), { publish: true });
    const p = (await hub.selfStore.run({ private: true }))!;
    expect(p).toMatchObject({ stored: 1, published: false });
    expect(hub.node.store.get(p.receipt)!.visibility).toBe('private');
    expect(hub.selfStore.list().map((x) => x.published)).toEqual([false, true]);
  });

  it('the shared library doesn’t pay again for what someone stored themselves', async () => {
    const home = mkdtempSync(join(tmpdir(), 'self-lib-'));
    const author = new Hub({ signer: LocalSigner.generate(), preview: false, archive: new LocalArchive(join(home, 'a')) });
    const keeperHub = new Hub({ signer: LocalSigner.generate(), preview: false, archive: new LocalArchive(join(home, 'k')) });
    const friend = new Hub({ signer: LocalSigner.generate(), preview: false });
    const rec = (await author.node.submit(failure(1), { publish: true })).record;
    for (const h of [keeperHub, friend]) h.node.ingest(rec);
    const conf = await friend.node.submit({ kind: 'confirmation', refs: [rec.id], context: ctx, body: { verdict: 'reproduced', note: '' } }, { publish: true });
    keeperHub.node.ingest(conf.record);
    expect(keeperHub.keeper.plan().records.map((r) => r.id)).toContain(rec.id); // confirmed: the library would keep it
    const r = (await author.selfStore.run())!;
    keeperHub.node.ingest(author.node.store.get(r.receipt)!.rec);
    expect(keeperHub.keeper.plan().records.map((x) => x.id)).not.toContain(rec.id); // already stored by its author
  });

  it('in the app: only on this computer; the quote, the run and the receipt file', async () => {
    const home = mkdtempSync(join(tmpdir(), 'self-web-'));
    const hub = new Hub({ signer: LocalSigner.generate(), preview: false, archive: new LocalArchive(join(home, 'archive')) });
    await hub.node.submit(failure(1), { publish: true });
    const web = new WebServer(hub); registerAppRoutes(web); await web.listen(0);
    try {
      expect(await (await fetch(`${web.url}/api/self-store`)).json()).toMatchObject({ waiting: 1, archive: 'local' });
      const r = await (await fetch(`${web.url}/api/self-store`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ private: true }) })).json() as { receipt: string; published: boolean };
      expect(r.published).toBe(false);
      const proof = await (await fetch(`${web.url}/api/self-store/proof/${r.receipt}`)).json() as { receipt: { id: string }; how_to_check: string[] };
      expect(proof.receipt.id).toBe(r.receipt);
    } finally { await web.close(); }
    expect(readFileSync(new URL('../../docs/STORAGE.md', import.meta.url), 'utf8')).toMatch(/Each contributor stores their own/);
  });
});
