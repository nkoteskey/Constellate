import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Hub } from '../../src/hub/hub.js';
import { LocalSigner } from '../../src/core/identity.js';
import { TestnetLedger } from '../../src/economy/rail.js';
import { CreditLedger } from '../../src/economy/credits.js';
import { ESCROW } from '../../src/economy/bounties.js';
import { createMcpServer } from '../../src/mcp/server.js';

/**
 * Bounties (docs/BOUNTIES.md): money set aside when a question is posted, paid once to the answer the
 * rules pick, never to the asker's own computers, and refunded only when nobody earned it.
 */
const $ = (n: number) => n * 1_000_000;
const DAY = 86_400_000;
const mk = () => new Hub({ signer: LocalSigner.generate(), preview: false });
const share = (from: Hub, to: Hub[], id: string) => { for (const h of to) h.node.ingest(from.node.store.get(id)!.rec); };
const answer = async (h: Hub, req: string, text: string) => {
  const { record } = await h.node.submit({ kind: 'answer', context: { task: 'bounty', domain: ['test'], environment: 'model x' }, body: { question: 'q', answer: text, proof: { type: 'citation', detail: 'test' } }, refs: [req] }, { publish: true });
  return record.id;
};

describe('bounties: set aside up front, paid to the right answer, once', () => {
  it('the asker picks: money is held on posting, paid once to the pick, never to the asker\'s own answers', async () => {
    const asker = mk(), helper = mk();
    const ledger = new TestnetLedger();
    asker.attachRail(ledger);
    ledger.faucet(asker.node.agentId, $(10));

    const b = await asker.bounties.post({ question: 'Why does the build fail on arm64 only?', amount: $(6), domain: ['ci'] });
    expect(b).toMatchObject({ state: 'open', amount: $(6), accept: 'asker' });
    expect(ledger.balance(asker.node.agentId)).toBe($(4));
    expect(ledger.balance(ESCROW(b.id))).toBe($(6));
    await expect(asker.bounties.post({ question: 'another', amount: $(5), domain: ['ci'] })).rejects.toThrow(/not enough balance/);

    const own = await answer(asker, b.id, 'answering myself');
    await expect(asker.bounties.award(b.id, own)).rejects.toThrow(/your own computers/);

    share(asker, [helper], b.id);
    const good = await answer(helper, b.id, 'the cross toolchain is missing libc headers');
    share(helper, [asker], good);
    expect(asker.bounties.list()[0].answers).toBe(1); // the asker's own answer doesn't count

    const v = await asker.bounties.award(b.id, good);
    expect(v.state).toBe('paid');
    expect(v.paid_to).toEqual([{ agent: helper.node.agentId, answer: good, amount: $(6) }]);
    expect(ledger.balance(helper.node.agentId)).toBe($(6));
    expect(ledger.balance(ESCROW(b.id))).toBe(0);
    expect(await asker.bounties.settle()).toBe(0); // nothing is paid twice
    expect(asker.bounties.list()).toEqual([]);
    expect(asker.bounties.list({ state: 'paid' })).toHaveLength(1);
  });

  it('a "check" bounty pays the first answer that passes, automatically, without the asker', async () => {
    const asker = mk(), a = mk(), c = mk();
    const ledger = new TestnetLedger();
    asker.attachRail(ledger);
    ledger.faucet(asker.node.agentId, $(3));
    const off = asker.bounties.watch();
    const b = await asker.bounties.post({ question: 'Sum of squares 1..100 mod 97?', amount: $(3), accept: 'check', verifier: 'sum_squares_mod', check: { from: 1, to: 100, mod: 97 }, domain: ['maths'] });
    share(asker, [a, c], b.id);
    const wrong = await answer(a, b.id, 'it is 1');
    share(a, [asker], wrong);
    await asker.bounties.idle();
    expect(asker.bounties.list()[0].state).toBe('open');
    const right = await answer(c, b.id, `the answer is ${(338350 % 97).toString()}`);
    share(c, [asker], right);
    await new Promise((r) => setTimeout(r, 10));
    await asker.bounties.idle();
    off();
    expect(ledger.balance(c.node.agentId)).toBe($(3));
    expect(ledger.balance(a.node.agentId)).toBe(0);
    expect(asker.bounties.list({ state: 'paid' })[0].paid_to[0].answer).toBe(right);
  });

  it('at the deadline: unpicked money goes to independently confirmed answers, otherwise back to the asker', async () => {
    const asker = mk(), a = mk(), b2 = mk(), judge = mk();
    const ledger = new TestnetLedger();
    asker.attachRail(ledger);
    ledger.faucet(asker.node.agentId, $(10));

    const lonely = await asker.bounties.post({ question: 'nobody answers this', amount: $(2), days: 1, domain: ['x'] });
    const left = await asker.bounties.post({ question: 'answered but never picked', amount: $(5), days: 1, domain: ['x'] });
    share(asker, [a, b2, judge], left.id);
    const x = await answer(a, left.id, 'answer one'), y = await answer(b2, left.id, 'answer two');
    for (const id of [x, y]) share(id === x ? a : b2, [asker, judge], id);
    const conf = await judge.confirm(x, { note: 'reproduced' }, { publish: true });
    asker.node.ingest(conf.record);

    expect(await asker.bounties.settle(Date.now() + 2 * DAY)).toBe(2);
    expect(ledger.balance(a.node.agentId)).toBe($(5)); // the confirmed answer, not the unconfirmed one
    expect(ledger.balance(b2.node.agentId)).toBe(0);
    expect(ledger.balance(asker.node.agentId)).toBe($(5)); // 10 − 2 − 5 + the 2 refunded
    expect(asker.bounties.list({ state: 'refunded' }).map((v) => v.id)).toEqual([lonely.id]);
  });

  it('refuses what would leak or can\'t be paid, and survives a restart on the credit ledger', async () => {
    const h = mk();
    await expect(h.bounties.post({ question: 'q', amount: $(1), domain: [] })).rejects.toThrow(/Constellate balance/);
    const path = join(mkdtempSync(join(tmpdir(), 'bounty-')), 'credits-play.jsonl');
    const ledger = new CreditLedger(path, { play: true });
    h.attachRail(ledger);
    ledger.deposit(h.node.agentId, $(4), 'play-starter', 'play');
    await expect(h.bounties.post({ question: 'q', amount: $(1), accept: 'check', verifier: 'exact', check: { expected: '42' }, domain: [] })).rejects.toThrow(/publish the expected answer/);
    await expect(h.bounties.post({ question: 'q', amount: $(1), accept: 'check', verifier: 'nope', domain: [] })).rejects.toThrow(/machine check/);
    const b = await h.bounties.post({ question: 'held across a restart', amount: $(3), domain: [] });
    const again = new CreditLedger(path, { play: true });
    expect(again.balance(ESCROW(b.id))).toBe($(3));
    expect(again.balance(h.node.agentId)).toBe($(1));
    expect(again.owed(1)).toEqual([{ account: h.node.agentId, amount: $(1) }]); // held money isn't anyone's to pay out
  });

  it('agents get bounty_post and bounties in the lean tool list, and can post and award through them', async () => {
    const asker = mk(), helper = mk();
    const ledger = new TestnetLedger();
    asker.attachRail(ledger);
    ledger.faucet(asker.node.agentId, $(5));
    const server = createMcpServer(asker);
    const [t1, t2] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 't', version: '1' });
    await Promise.all([server.connect(t1), client.connect(t2)]);
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['bounty_post', 'bounties', 'answers_submit']));
    const call = async (name: string, args: Record<string, unknown>) => JSON.parse(((await client.callTool({ name, arguments: args })).content as { text: string }[])[0].text);
    const b = await call('bounty_post', { question: 'Which flag fixes the linker error?', usd: 2.5, domain: ['rust'] });
    expect(b).toMatchObject({ state: 'open', amount: 2_500_000 });
    share(asker, [helper], b.id);
    const ans = await answer(helper, b.id, 'pass -C link-arg=-fuse-ld=lld');
    share(helper, [asker], ans);
    const mine = await call('bounties', { mine: true });
    expect(mine.bounties[0].answer_list[0].id).toBe(ans);
    const paid = await call('bounties', { bounty: b.id, award: ans });
    expect(paid.state).toBe('paid');
    expect(ledger.balance(helper.node.agentId)).toBe(2_500_000);
    await client.close();
  });
});
