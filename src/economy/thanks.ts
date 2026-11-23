import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import type { Hub } from '../hub/hub.js';
import type { StoredRecord } from '../store/records.js';
import { payoutAddress } from './funding-routes.js';
import { authorization, requirements, typedData, type Authorization, type Requirements, type PaymentPayload } from './x402-base.js';

/**
 * Thank what worked (docs/REWARDS.md): opt-in tips along the lineage when a fix worked for this computer's agents.
 *
 * Off by default. When on, every `fix_tried` that worked (a signed confirmation by this computer) adds a thank-you
 * worth `per_fix` (default $0.02), at most `monthly_cap` a month (default $2), split along the lineage of the record
 * that worked: 70% to its author, 20% to whoever reported the failure it answers, 10% to what it built on (to its
 * author when it built on nothing). Nobody thanks themselves. Thanks never expire: they wait, visibly, until the
 * recipient has a payout address on Base and is owed at least `pay_at` (default $1). Then the person approves one
 * x402 payment (USDC on Base) per recipient in their own wallet, settled by their x402 facilitator, and a signed
 * `thanks` receipt makes the reward part of the record.
 */
export interface ThanksSettings { on: boolean; since: string | null; per_fix_micro: number; monthly_cap_micro: number; pay_at_micro: number }
export const THANKS_DEFAULTS: ThanksSettings = { on: false, since: null, per_fix_micro: 20_000, monthly_cap_micro: 2_000_000, pay_at_micro: 1_000_000 };
export const SPLIT = { author: 0.7, reporter: 0.2, built_on: 0.1 };

export interface Owed { operator: string; owed_micro: number; paid_micro: number; for: string[]; payout_address: string | null; due: boolean }

export class Thanks {
  private readonly file: string;
  private pending = new Map<string, { operator: string; req: Requirements; auth: Authorization; records: string[] }>();
  constructor(private readonly hub: Hub, home = process.env.CONSTELLATE_HOME ?? join(homedir(), '.constellate')) { this.file = join(home, 'thanks.json'); }

  settings(): ThanksSettings { try { return { ...THANKS_DEFAULTS, ...(existsSync(this.file) ? JSON.parse(readFileSync(this.file, 'utf8')) : {}) }; } catch { return { ...THANKS_DEFAULTS }; } }
  set(patch: Partial<ThanksSettings>): ThanksSettings {
    const s = { ...this.settings(), ...patch };
    if (patch.on && !this.settings().on) s.since = new Date().toISOString(); // thanks start from when it's turned on
    for (const [k, lo, hi] of [['per_fix_micro', 1000, 1_000_000], ['monthly_cap_micro', 0, 100_000_000], ['pay_at_micro', 100_000, 100_000_000]] as const) {
      if (!Number.isInteger(s[k]) || s[k] < lo || s[k] > hi) throw new Error(`${k} must be between ${lo} and ${hi} micro-dollars`);
    }
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(s));
    return s;
  }

  /** The operators a record's thanks go to, with their shares (this computer's own operator left out). */
  split(record: StoredRecord): { operator: string; share: number }[] {
    const store = this.hub.node.store, me = this.hub.node.operatorId;
    const out = new Map<string, number>();
    const give = (op: string | undefined, share: number) => { if (op && op !== me) out.set(op, (out.get(op) ?? 0) + share); };
    const failure = record.rec.refs.map((r) => store.get(r)).find((s) => s?.rec.kind === 'failure');
    const builtOn = record.rec.refs.map((r) => store.get(r)).filter((s): s is StoredRecord => !!s && s !== failure && !['problem', 'review_request'].includes(s.rec.kind));
    give(record.operatorId, SPLIT.author + (failure ? 0 : SPLIT.reporter) + (builtOn.length ? 0 : SPLIT.built_on));
    if (failure) give(failure.operatorId, SPLIT.reporter);
    for (const b of builtOn) give(b.operatorId, SPLIT.built_on / builtOn.length);
    return [...out].map(([operator, share]) => ({ operator, share }));
  }

  /** What each recipient is owed: accrued from this computer's worked confirmations since thanks were turned on. */
  owed(): Owed[] {
    const s = this.settings();
    if (!s.since) return [];
    const store = this.hub.node.store, me = this.hub.node.operatorId;
    const worked = store.ofKind('confirmation', { includePrivate: true })
      .filter((c) => c.operatorId === me && (c.rec.body as { tried?: { worked?: boolean } }).tried?.worked && c.rec.created >= s.since!)
      .sort((a, b) => a.rec.created.localeCompare(b.rec.created));
    const byMonth = new Map<string, number>();
    const acc = new Map<string, { micro: number; for: Set<string> }>();
    for (const c of worked) {
      const target = store.get(c.rec.refs[0]);
      if (!target) continue;
      const month = c.rec.created.slice(0, 7), used = byMonth.get(month) ?? 0;
      const amount = Math.min(s.per_fix_micro, s.monthly_cap_micro - used);
      if (amount <= 0) continue;
      byMonth.set(month, used + amount);
      for (const { operator, share } of this.split(target)) {
        const a = acc.get(operator) ?? { micro: 0, for: new Set() };
        a.micro += amount * share; a.for.add(target.rec.id); acc.set(operator, a);
      }
    }
    const paid = new Map<string, number>();
    for (const r of store.ofKind('receipt')) {
      const b = r.rec.body as { type?: string; payee?: string; amount?: number };
      if (r.operatorId === me && b.type === 'thanks' && b.payee) paid.set(b.payee, (paid.get(b.payee) ?? 0) + Number(b.amount ?? 0));
    }
    return [...acc].map(([operator, a]) => {
      const p = paid.get(operator) ?? 0, owed = Math.floor(a.micro) - p, addr = payoutAddress(this.hub, operator);
      return { operator, owed_micro: Math.max(0, owed), paid_micro: p, for: [...a.for], payout_address: addr, due: owed >= s.pay_at_micro && !!addr };
    }).filter((o) => o.owed_micro > 0 || o.paid_micro > 0).sort((x, y) => y.owed_micro - x.owed_micro);
  }

  /** Thanks this operator received from everyone (public receipts): what their confirmed work earned. */
  received(operator: string) {
    const rs = this.hub.node.store.ofKind('receipt').filter((r) => (r.rec.body as { type?: string; payee?: string }).type === 'thanks' && (r.rec.body as { payee?: string }).payee === operator);
    return { micro: rs.reduce((n, r) => n + Number((r.rec.body as { amount?: number }).amount ?? 0), 0), from: new Set(rs.map((r) => r.operatorId)).size };
  }

  /** What the person's wallet signs to pay one recipient what they're owed. */
  quote(operator: string, payer: string) {
    const o = this.owed().find((x) => x.operator === operator);
    if (!o || !o.due) throw new Error('nothing due to them yet');
    const req = requirements({ amount: BigInt(o.owed_micro), payTo: o.payout_address!, resource: `thanks:${operator}`, description: 'Thanks for fixes that worked' });
    const auth = authorization(payer, req);
    const id = randomBytes(8).toString('hex');
    this.pending.set(id, { operator, req, auth, records: o.for });
    return { id, amount_micro: o.owed_micro, to: o.payout_address, typed_data: typedData(auth) };
  }

  /** Settle it with the x402 facilitator and sign the receipt that makes the reward part of the record. */
  async pay(id: string, signature: string) {
    const p = this.pending.get(id);
    if (!p) throw new Error('that payment has expired; ask again');
    this.pending.delete(id);
    const f = this.hub.market.facilitator;
    if (!f) throw new Error('paying thanks needs real payments on and an x402 facilitator (CONSTELLATE_X402_FACILITATOR)');
    const payment: PaymentPayload = { x402Version: 1, scheme: 'exact', network: 'base', payload: { signature, authorization: p.auth } };
    const v = await f.verify(payment, p.req);
    if (!v.valid) throw new Error(`payment not valid: ${v.reason ?? 'refused'}`);
    const s = await f.settle(payment, p.req);
    if (!s.ok) throw new Error(`the payment didn’t settle: ${s.reason ?? 'refused'}`);
    const { record } = await this.hub.node.submit({ kind: 'receipt', context: { task: 'thanks for fixes that worked', domain: ['payments'], environment: 'base' }, body: { type: 'thanks', payer: this.hub.node.agentId, payee: p.operator, payee_address: p.req.payTo, amount: Number(p.req.maxAmountRequired), tx: s.transaction, rail: 'x402', network: 'base', for: p.records.slice(0, 50) }, refs: p.records.slice(0, 8) }, { publish: true });
    return { receipt: record.id, transaction: s.transaction };
  }
}
