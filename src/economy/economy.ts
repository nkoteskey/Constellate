import { Hub } from '../hub/hub.js';
import { PaymentRail, signMandate, SignedMandate } from './rail.js';
import { lineage, splitAmount } from './lineage.js';
import { CheckpointBody } from '../work/problems.js';
import { StoredRecord } from '../store/records.js';

export interface ReceiptBody {
  type: 'payout' | 'skill_fee' | 'review_fee' | 'review_bonus' | 'deposit' | 'refund' | 'reward' | 'sponsorship' | 'x402';
  payer: string;
  payee: string;
  amount: number;
  tx: string;
  rail: string;
  network: string;
  role?: string;
  mandate: SignedMandate;
  [k: string]: unknown;
}

/**
 * Settles money and records every settlement as a signed `receipt` that
 * references what it paid for, so any payment can be traced to the work,
 * and any work to the payments it earned.
 */
export class Economy {
  private busy = Promise.resolve();
  constructor(readonly hub: Hub, readonly rail: PaymentRail) {}

  get me() { return this.hub.node.agentId; }
  balance(agent = this.me) { return this.rail.balance(agent); }

  /** Pay and publish a receipt. refs[0] is the record being paid for. */
  async pay(payee: string, amount: number, type: ReceiptBody['type'], refs: string[], extra: Record<string, unknown> = {}) {
    if (amount <= 0) return null;
    const mandate = await signMandate(this.hub.node.signer, { payee, amount, purpose: type, for_record: refs[0] });
    const s = await this.rail.settle(mandate);
    const body: ReceiptBody = { type, payer: this.me, payee, amount, tx: s.tx, rail: s.rail, network: s.network, mandate, ...extra };
    const { record } = await this.hub.node.submit({ kind: 'receipt', context: { task: `payment: ${type}`, domain: ['payments'], environment: s.network }, body: body as unknown as Record<string, unknown>, refs }, { publish: true });
    return record;
  }

  receipts(filter: Partial<Pick<ReceiptBody, 'type' | 'payer' | 'payee'>> = {}) {
    return this.hub.node.store.ofKind('receipt').map((s) => ({ s, b: s.rec.body as unknown as ReceiptBody }))
      .filter(({ b }) => Object.entries(filter).every(([k, v]) => (b as Record<string, unknown>)[k] === v));
  }

  // ── Problem sponsorship: contributors are paid automatically for verified checkpoints ──

  async sponsor(problemId: string, perCheckpoint: number) {
    return this.hub.node.submit({ kind: 'receipt', context: { task: 'sponsor problem', domain: ['payments'], environment: this.rail.network }, body: { type: 'sponsorship', payer: this.me, problem: problemId, per_checkpoint: perCheckpoint, amount: 0, payee: '', tx: '', rail: this.rail.name, network: this.rail.network }, refs: [problemId] }, { publish: true });
  }

  private sponsorships() {
    return this.hub.node.store.ofKind('receipt').filter((s) => s.rec.agent_id === this.me && (s.rec.body as { type: string }).type === 'sponsorship');
  }

  /** Pay out every verified, not-yet-paid checkpoint on problems this agent sponsors. Idempotent. */
  async settleCheckpoints(): Promise<number> {
    let paid = 0;
    for (const sp of this.sponsorships()) {
      const { problem, per_checkpoint } = sp.rec.body as unknown as { problem: string; per_checkpoint: number };
      const st = await this.hub.problems.state(problem);
      for (const c of st.chunks) {
        if (!c.checkpoint) continue;
        const already = this.hub.node.store.referencing(c.checkpoint.rec.id, 'receipt').some((r) => r.rec.agent_id === this.me && (r.rec.body as { type: string }).type === 'payout');
        if (already) continue;
        const split = splitAmount(lineage(this.hub.node.store, c.checkpoint.rec.id), per_checkpoint);
        const roles = new Map(lineage(this.hub.node.store, c.checkpoint.rec.id).map((x) => [x.agent, x.role]));
        for (const [agent, amount] of split) {
          await this.pay(agent, amount, 'payout', [c.checkpoint.rec.id, problem], { role: roles.get(agent), problem, chunk: (c.checkpoint.rec.body as unknown as CheckpointBody).chunk });
          paid += amount;
        }
      }
    }
    return paid;
  }

  /** Watch the store and settle automatically whenever a checkpoint lands. */
  autoSettle() {
    return this.hub.node.store.onAdd((s) => {
      if (s.rec.kind === 'checkpoint') this.busy = this.busy.then(() => this.settleCheckpoints()).then(() => undefined, () => undefined);
    });
  }
  idle() { return this.busy; }

  // ── Second opinion ──────────────────────────────────────────────

  async requestReview(subject: 'plan' | 'code' | 'claim', summary: string, contentHash: string, bounty: number, domain: string[]) {
    return this.hub.node.submit({ kind: 'review_request', context: { task: `second opinion on ${subject}`, domain, environment: '' }, body: { subject, summary, content_hash: contentHash, bounty, requester: this.me } }, { publish: true });
  }

  async respondReview(requestId: string, verdict: 'sound' | 'concerns' | 'wrong', critique: string) {
    const req = this.hub.node.store.get(requestId);
    if (!req || req.rec.kind !== 'review_request') throw new Error('unknown review request');
    if (req.operatorId === this.hub.node.operatorId) throw new Error('reviews must be independent');
    return this.hub.node.submit({ kind: 'review', context: { task: req.rec.context.task, domain: req.rec.context.domain, environment: '' }, body: { request: requestId, verdict, critique }, refs: [requestId] }, { publish: true });
  }

  /** Requester pays the reviewer; a review confirmed useful earns a 50% bonus. */
  async settleReview(reviewId: string, useful: boolean) {
    const rev = this.hub.node.store.get(reviewId)!;
    const req = this.hub.node.store.get(rev.rec.refs[0])!;
    if (req.rec.agent_id !== this.me) throw new Error('only the requester settles a review');
    const bounty = (req.rec.body as { bounty: number }).bounty;
    const fee = await this.pay(rev.rec.agent_id, bounty, 'review_fee', [reviewId, req.rec.id]);
    let bonus = null;
    if (useful) {
      await this.hub.confirm(reviewId, { note: 'critique was useful' }, { publish: true });
      bonus = await this.pay(rev.rec.agent_id, Math.floor(bounty / 2), 'review_bonus', [reviewId, req.rec.id]);
    }
    return { fee, bonus };
  }

  // ── Refundable deposits on writes ────────────────────────────────

  /** Optional: put a refundable deposit behind a record you wrote, paid to an escrow agent. */
  async deposit(recordId: string, escrow: string, amount: number) {
    return this.pay(escrow, amount, 'deposit', [recordId]);
  }
}

/**
 * Testnet escrow agent: holds deposits and returns them, plus a reward,
 * once an independent operator confirms the deposited record.
 */
export class EscrowAgent {
  constructor(readonly economy: Economy, readonly rewardBps = 2000) {}

  async settle(): Promise<number> {
    const hub = this.economy.hub;
    let n = 0;
    for (const { s, b } of this.economy.receipts({ type: 'deposit', payee: this.economy.me })) {
      const target = s.rec.refs[0];
      const refunded = hub.node.store.referencing(s.rec.id, 'receipt').some((r) => (r.rec.body as { type: string }).type === 'refund');
      if (refunded) continue;
      const rec = hub.node.store.get(target);
      if (!rec) continue;
      const confirmed = hub.node.store.referencing(target, 'confirmation').some((c: StoredRecord) => c.operatorId !== rec.operatorId);
      if (!confirmed) continue;
      await this.economy.pay(b.payer, b.amount, 'refund', [s.rec.id, target]);
      await this.economy.pay(b.payer, Math.floor((b.amount * this.rewardBps) / 10_000), 'reward', [s.rec.id, target]);
      n++;
    }
    return n;
  }
}
