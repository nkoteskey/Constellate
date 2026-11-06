import { describe, it, expect } from 'vitest';
import { Hub } from '../../src/hub/hub.js';
import { LocalSigner } from '../../src/core/identity.js';
import { LocalArchive } from '../../src/store/archive.js';
import { MemoryNetwork } from '../../src/transport/bus.js';
import { MemoryBoard } from '../../src/work/board.js';
import { Worker } from '../../src/work/worker.js';
import { MockRunner } from '../../src/contributor/models.js';
import { TestnetLedger, signMandate } from '../../src/economy/rail.js';
import { Economy, EscrowAgent, ReceiptBody } from '../../src/economy/economy.js';
import { Skills } from '../../src/economy/skills.js';
import { lineage } from '../../src/economy/lineage.js';
import { WebServer } from '../../src/web/server.js';
import { registerEconomyRoutes } from '../../src/economy/routes.js';
import { fetchWithPayment } from '../../src/economy/x402.js';
import { CheckpointBody, TaskResultBody } from '../../src/work/problems.js';

/** GATE 5: contributors are paid automatically and traceably for confirmed work. Testnet only. */
const MOD = 1000000007n;
const solve = (p: string) => { if (p.includes('You are verifying')) return 'YES'; const m = p.match(/from (\d+) to (\d+)/)!; let s = 0n; for (let i = BigInt(m[1]); i <= BigInt(m[2]); i++) s = (s + i * i) % MOD; return `${s}`; };

function world() {
  const net = new MemoryNetwork();
  const archive = new LocalArchive();
  const ledger = new TestnetLedger();
  const mk = () => new Hub({ signer: LocalSigner.generate(), bus: net.bus(), archive, preview: false });
  return { ledger, mk };
}

describe('GATE 5 — economy (testnet)', () => {
  it('a human sponsors a problem over x402; contributors are paid per verified checkpoint, traceably', async () => {
    const { ledger, mk } = world();
    const hubAgent = mk(), w1 = mk(), w2 = mk();
    const human = LocalSigner.generate();
    ledger.faucet(human.agentId, 5_000_000);
    const eco = new Economy(hubAgent, ledger);
    eco.autoSettle();
    const web = await new WebServer(hubAgent).listen(0);
    registerEconomyRoutes(web, eco);

    const { record: problem } = await hubAgent.problems.propose({ title: 'Paid sums', goal: 'g', realm: 'maths_physics', definition_of_done: { verifier: 'sum_squares_mod', description: 'recomputed' },
      chunks: Array.from({ length: 4 }, (_, i) => ({ key: `c${i}`, title: `c${i}`, prompt: `from ${i * 50 + 1} to ${(i + 1) * 50}`, check: { from: i * 50 + 1, to: (i + 1) * 50, mod: 1000000007 } })) }, { publish: true });

    // x402: unpaid request gets 402 with requirements; the client pays and retries.
    const url = `${web.url}/api/problems/${problem.id}/sponsor?amount=2000000&per_checkpoint=400000`;
    const unpaid = await fetch(url, { method: 'POST' });
    expect(unpaid.status).toBe(402);
    expect((await unpaid.json()).accepts[0].payTo).toBe(hubAgent.node.agentId);
    const paid = await fetchWithPayment(url, { method: 'POST' }, human, 2_000_000);
    expect(paid.status).toBe(200);
    expect(paid.headers.get('x-payment-response')).toBeTruthy();
    expect(ledger.balance(hubAgent.node.agentId)).toBe(2_000_000);

    // Work happens; payouts happen by themselves as checkpoints land.
    const board = new MemoryBoard();
    const workers = [new Worker(w1, new MockRunner('a', 'llama', 'small', (p, n) => (n === 0 ? 'wrong 1' : solve(p))), w1.problems, board), new Worker(w2, new MockRunner('b', 'qwen', 'small', solve), w2.problems, board)];
    for (let i = 0; i < 40 && (await hubAgent.problems.state(problem.id)).done < 4; i++) await workers[i % 2].step(problem.id);
    await eco.idle();
    expect((await hubAgent.problems.state(problem.id)).done).toBe(4);

    const payouts = eco.receipts({ type: 'payout' });
    const total = payouts.reduce((n, r) => n + r.b.amount, 0);
    expect(total).toBe(4 * 400_000);
    expect(ledger.balance(w1.node.agentId) + ledger.balance(w2.node.agentId)).toBe(total);
    expect(ledger.balance(hubAgent.node.agentId)).toBe(2_000_000 - total);

    // Traceable: every payout -> checkpoint -> verified result -> problem, and the split matches lineage.
    for (const { s, b } of payouts) {
      const cp = hubAgent.node.store.get(s.rec.refs[0])!;
      expect(cp.rec.kind).toBe('checkpoint');
      const cb = cp.rec.body as unknown as CheckpointBody;
      const res = hubAgent.node.store.get(cb.result)!;
      expect((res.rec.body as unknown as TaskResultBody).problem).toBe(problem.id);
      const expected = b.role === 'verification' ? cp.rec.agent_id : res.rec.agent_id;
      expect(b.payee).toBe(expected);
      expect(ledger.txs.find((t) => t.tx === b.tx)!.for_record).toBe(cp.rec.id);
    }
    // No payment for the rejected wrong answer.
    const rejected = hubAgent.node.store.ofKind('verification').map((v) => (v.rec.body as { result: string }).result);
    expect(rejected.length).toBeGreaterThan(0);
    for (const r of rejected) expect(payouts.some((p) => lineage(hubAgent.node.store, p.s.rec.refs[0]).some((c) => c.record === r))).toBe(false);
    // Idempotent.
    expect(await eco.settleCheckpoints()).toBe(0);
    const earnings = await (await fetch(`${web.url}/api/earnings/${w2.node.agentId}`)).json();
    expect(earnings.total).toBe(ledger.balance(w2.node.agentId));
    await web.close();
  });

  it('skills: free sandboxed trial, author paid per run, parent skill shares through inheritance', async () => {
    const { ledger, mk } = world();
    const parentAuthor = mk(), author = mk(), user = mk();
    ledger.faucet(user.node.agentId, 1_000_000);
    const upper = (p: string) => p.split('Input:\n')[1].toUpperCase();
    const { record: parent } = await new Skills(parentAuthor).publish({ name: 'shout', description: 'Uppercase text', capabilities: ['text'], price: 0, instructions: 'Uppercase the input.', tests: [{ input: 'hi', check: { expected: 'HI' } }], verifier: 'exact' });
    const { record: skill } = await new Skills(author).publish({ name: 'shout-pro', description: 'Uppercase text, robustly', capabilities: ['text'], price: 10_000, instructions: 'Uppercase the input.', tests: [{ input: 'abc', check: { expected: 'ABC' } }, { input: 'x', check: { expected: 'X' } }], verifier: 'exact' }, { inherits: [parent.id] });
    const sk = new Skills(user, new Economy(user, ledger));
    expect(sk.find('robustly uppercase text')[0].id).toBe(skill.id);
    const t = await sk.trial(skill.id, new MockRunner('m', 'llama', 'small', upper));
    expect(t).toMatchObject({ passed: 2, total: 2 });
    expect(ledger.balance(user.node.agentId)).toBe(1_000_000); // trials are free
    const r = await sk.use(skill.id, new MockRunner('m', 'llama', 'small', upper), 'hello');
    expect(r.output).toBe('HELLO');
    expect(ledger.balance(author.node.agentId)).toBe(8_000);
    expect(ledger.balance(parentAuthor.node.agentId)).toBe(2_000);
    expect(sk.find('uppercase')[0].runs).toBe(2);
  });

  it('second opinion: reviewer paid, bonus when the critique is confirmed useful', async () => {
    const { ledger, mk } = world();
    const requester = mk(), reviewer = mk();
    ledger.faucet(requester.node.agentId, 100_000);
    const eReq = new Economy(requester, ledger), eRev = new Economy(reviewer, ledger);
    const { record: req } = await eReq.requestReview('plan', 'Migration plan: drop column then backfill', 'a'.repeat(64), 20_000, ['postgres']);
    const { record: rev } = await eRev.respondReview(req.id, 'wrong', 'Backfill before dropping, or you lose data.');
    await eReq.settleReview(rev.id, true);
    expect(ledger.balance(reviewer.node.agentId)).toBe(30_000);
    expect(requester.trust.explain(requester.node.store.get(rev.id)!).confirmations).toBe(1);
  });

  it('refundable deposit comes back with a reward once someone independent confirms', async () => {
    const { ledger, mk } = world();
    const author = mk(), confirmer = mk(), escrowHub = mk();
    ledger.faucet(author.node.agentId, 10_000);
    ledger.faucet(escrowHub.node.agentId, 1_000_000);
    const { record } = await author.ledger.submitAnswer({ task: 't', domain: ['x'], environment: 'e' }, { question: 'q', answer: 'a', proof: { type: 'test', detail: 'd' } }, { publish: true });
    await new Economy(author, ledger).deposit(record.id, escrowHub.node.agentId, 1_000);
    const escrow = new EscrowAgent(new Economy(escrowHub, ledger));
    expect(await escrow.settle()).toBe(0);
    await confirmer.confirm(record.id, {}, { publish: true });
    expect(await escrow.settle()).toBe(1);
    expect(ledger.balance(author.node.agentId)).toBe(10_000 + 200);
    expect(await escrow.settle()).toBe(0);
  });

  it('refuses forged, replayed and overdrawn payments', async () => {
    const ledger = new TestnetLedger();
    const a = LocalSigner.generate(), b = LocalSigner.generate();
    ledger.faucet(a.agentId, 100);
    const m = await signMandate(a, { payee: b.agentId, amount: 50, purpose: 't' });
    await ledger.settle(m);
    await expect(ledger.settle(m)).rejects.toThrow(/replay/);
    await expect(ledger.settle({ ...m, mandate: { ...m.mandate, amount: 60, nonce: 'x' } })).rejects.toThrow(/signature/);
    await expect(ledger.settle(await signMandate(a, { payee: b.agentId, amount: 500, purpose: 't' }))).rejects.toThrow(/insufficient/);
    await expect(ledger.settle(await signMandate(b, { payee: a.agentId, amount: 51, purpose: 't' }))).rejects.toThrow(/insufficient/);
  });
});
