import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Hub } from '../../src/hub/hub.js';
import { LocalSigner } from '../../src/core/identity.js';
import { RecordStore } from '../../src/store/records.js';
import { LocalArchive } from '../../src/store/archive.js';
import { TestnetLedger } from '../../src/economy/rail.js';
import { CreditLedger } from '../../src/economy/credits.js';
import { FUND } from '../../src/economy/fund.js';

/**
 * Who pays for permanence (docs/STORAGE.md): a shared fund, not the people sharing. The library keeps
 * only what earned its place, carries the evidence for why, and every gift, withdrawal and upload is a
 * signed receipt.
 */
const $ = (n: number) => n * 1_000_000;
const tmp = () => mkdtempSync(join(tmpdir(), 'lib-'));
const ctx = (domain: string[]) => ({ task: 'a task', domain, environment: 'node 22' });
const failure = (i: number, domain = ['ci']) => ({ kind: 'failure' as const, context: ctx(domain), body: { approach: `approach ${i}`, outcome: 'error', error_summary: `broke ${i}`, confidence: 0.6 } });

describe('the storage fund and the permanent library', () => {
  it('keeps what earned its place, with its evidence, and leaves the rest to peers', async () => {
    const home = tmp();
    process.env.CONSTELLATE_HOME = home;
    try {
      const archive = new LocalArchive(join(home, 'archive'));
      const keeper = new Hub({ signer: LocalSigner.generate(), preview: false, archive, store: new RecordStore() });
      const author = new Hub({ signer: LocalSigner.generate(), preview: false });
      const friend = new Hub({ signer: LocalSigner.generate(), preview: false });

      const ids: string[] = [];
      for (let i = 0; i < 4; i++) { const { record } = await author.node.submit(failure(i), { publish: true }); ids.push(record.id); keeper.node.ingest(record); friend.node.ingest(record); }
      const conf = await friend.confirm(ids[0], { note: 'same here' }, { publish: true });
      keeper.node.ingest(conf.record);
      const selfConf = await author.node.submit({ kind: 'confirmation', refs: [ids[1]], context: ctx(['ci']), body: { verdict: 'reproduced', note: '' } }, { publish: true });
      keeper.node.ingest(selfConf.record); // confirming your own record doesn't earn it a place

      const plan = keeper.keeper.plan();
      expect(plan.by).toMatchObject({ confirmed: 1, sponsored: 0 });
      expect(plan.records.map((r) => r.id)).toEqual(expect.arrayContaining([ids[0], conf.record.id]));
      expect(plan.records.map((r) => r.id)).not.toContain(ids[1]);
      expect(plan.left_to_peers).toBe(3);

      const r = await keeper.keeper.run();
      expect(r).toMatchObject({ uploaded: true, records: 2 });
      expect(keeper.keeper.status()).toMatchObject({ archived: 2, waiting: 0, archive: 'local' });
      expect(await keeper.keeper.run()).toMatchObject({ uploaded: false }); // nothing new, nothing paid
      const spend = keeper.node.store.ofKind('receipt').find((s) => (s.rec.body as { type: string }).type === 'storage_spend')!;
      expect(spend.rec.body).toMatchObject({ payer: FUND, records: 2, archive: 'local' });

      // A new computer restores the library from the archive, every record verified on the way in.
      const fresh = new Hub({ signer: LocalSigner.generate(), preview: false, archive, store: new RecordStore() });
      expect(await fresh.keeper.restore()).toMatchObject({ bundles: 1, added: 2, refused: 0 });
      expect(fresh.node.store.get(ids[0])).toBeDefined();
    } finally { delete process.env.CONSTELLATE_HOME; }
  });

  it('sponsoring a topic keeps everything public in it, and the fund shows where every dollar went', async () => {
    const home = tmp();
    process.env.CONSTELLATE_HOME = home;
    try {
      const hub = new Hub({ signer: LocalSigner.generate(), preview: false, archive: new LocalArchive(join(home, 'archive')) });
      const ledger = new TestnetLedger();
      hub.attachRail(ledger);
      ledger.faucet(hub.node.agentId, $(20));
      const other = new Hub({ signer: LocalSigner.generate(), preview: false });
      for (let i = 0; i < 3; i++) hub.node.ingest((await other.node.submit(failure(i, i ? ['x0x'] : ['rust']), { publish: true })).record);
      expect(hub.keeper.plan().records).toHaveLength(0);

      await hub.fund.donate($(5));
      await hub.fund.donate($(3), 'X0X');
      await expect(hub.fund.donate($(1), 'not a <topic>')).rejects.toThrow(/short tag/);
      await expect(hub.fund.donate($(100))).rejects.toThrow(/not enough/);
      expect(hub.keeper.plan().by.sponsored).toBe(2); // the two x0x records, not the rust one

      const v = hub.fund.view();
      expect(v).toMatchObject({ holds_money_here: true, balance: $(8), given: $(8), donors: 1, topics: [{ topic: 'x0x', amount: $(3), sponsors: 1 }] });
      expect(ledger.balance(hub.node.agentId)).toBe($(12));

      await expect(hub.fund.withdraw($(2), '  ')).rejects.toThrow(/what the money is for/);
      await hub.fund.withdraw($(2), 'ANT for Autonomi uploads');
      expect(hub.fund.view()).toMatchObject({ balance: $(6), withdrawn: $(2) });
      expect(hub.fund.view().recent[0]).toMatchObject({ type: 'withdrawal', note: 'ANT for Autonomi uploads' });
      await expect(hub.fund.withdraw($(50), 'too much')).rejects.toThrow();
    } finally { delete process.env.CONSTELLATE_HOME; }
  });

  it('money given to the fund is never listed as owed to anyone, and survives a restart', async () => {
    const path = join(tmp(), 'credits-play.jsonl');
    const hub = new Hub({ signer: LocalSigner.generate(), preview: false });
    hub.attachRail(new CreditLedger(path, { play: true }));
    (hub.economy!.rail as CreditLedger).deposit(hub.node.agentId, $(10), 'start', 'play');
    await hub.fund.donate($(4));
    const again = new CreditLedger(path, { play: true });
    expect(again.balance(FUND)).toBe($(4));
    expect(again.owed(1).map((o) => o.account)).toEqual([hub.node.agentId]);
  });
});
