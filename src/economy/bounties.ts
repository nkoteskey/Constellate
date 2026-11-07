import type { Hub } from '../hub/hub.js';
import type { StoredRecord } from '../store/records.js';
import type { HelpBody } from '../collab/collab.js';
import type { ReceiptBody } from './economy.js';

/**
 * Bounties (docs/BOUNTIES.md): a question with money set aside up front.
 *
 * - Posting moves the amount from the asker into an escrow account on the ledger that holds the asker's
 *   money (`escrow:<request id>`). A bounty that couldn't be held is never shown as open.
 * - "check" bounties are paid automatically, by the ledger's hub, to the first independent answer that
 *   passes the named machine check. The asker can't keep the money once an answer passes.
 * - "asker" bounties are paid when the asker picks an answer (a signed confirmation of it). If the deadline
 *   passes without a pick, the money goes to answers another operator confirmed, split evenly. With none,
 *   it's refunded. So nobody gets free answers by letting a bounty run out.
 * - Answers from the asker's own operator never earn the bounty. Every payment is a signed receipt.
 */
export type Accept = 'check' | 'asker';
export interface BountyBody extends HelpBody { expires: string; accept: Accept }

export const ESCROW = (requestId: string) => `escrow:${requestId}`;
const DAY = 86_400_000;
const MAX_DAYS = 90;

export interface BountyView {
  id: string; question: string; amount: number; accept: Accept; verifier: string; expires: string; asker: string; at: string; domain: string[];
  state: 'open' | 'paid' | 'refunded' | 'expired' | 'not_held';
  answers: number; paid_to: { agent: string; answer: string; amount: number }[];
}

export class Bounties {
  private busy: Promise<unknown> = Promise.resolve();
  constructor(private readonly hub: Hub) {}

  private get economy() {
    const e = this.hub.economy;
    if (!e?.rail.release) throw new Error('bounties are paid from this computer\'s Constellate balance: open the app (or run `constellate serve`) to post one');
    return e;
  }

  /** What this identity can still commit: its balance (escrowed money has already left it). */
  spendable() { return this.hub.economy?.balance() ?? 0; }

  async post(o: { question: string; amount: number; accept?: Accept; verifier?: string; check?: Record<string, unknown>; days?: number; domain: string[]; refs?: string[] }) {
    const economy = this.economy;
    const amount = Math.floor(o.amount);
    const accept = o.accept ?? (o.verifier ? 'check' : 'asker');
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('a bounty needs an amount above zero');
    if (!o.question.trim()) throw new Error('say what you need answered');
    if (accept === 'check') {
      if (!o.verifier || !this.hub.problems.verifiers.get(o.verifier)) throw new Error(`a "check" bounty names a machine check: one of ${this.hub.problems.verifiers.names().join(', ')}`);
      if (o.verifier === 'exact') throw new Error('the "exact" check would publish the expected answer with the bounty: pick "asker" and choose the answer yourself');
    }
    if (economy.balance() < amount) throw new Error(`not enough balance: you have ${usd(economy.balance())}, the bounty is ${usd(amount)}`);
    const days = Math.min(MAX_DAYS, Math.max(1, o.days ?? 7));
    const body: BountyBody = { question: o.question, needs: 'any', verifier: o.verifier ?? '', check: o.check ?? {}, bounty: amount, expires: new Date(Date.now() + days * DAY).toISOString(), accept };
    const { record } = await this.hub.node.submit({ kind: 'help_request', context: { task: o.question.slice(0, 200), domain: o.domain, environment: '' }, body: body as unknown as Record<string, unknown>, refs: o.refs ?? [] }, { publish: true });
    await this.hub.board.ensure(`[bounty ${record.id.slice(0, 10)}] ${o.question.slice(0, 80)}`, { help: record.id, needs: 'any' }).catch(() => {});
    await economy.pay(ESCROW(record.id), amount, 'bounty_hold', [record.id]);
    return this.view(this.hub.node.store.get(record.id)!);
  }

  /** The asker picks an answer: a signed confirmation, which the ledger's hub then pays out. */
  async award(requestId: string, answerId: string) {
    const req = this.request(requestId);
    if (req.rec.agent_id !== this.hub.node.agentId) throw new Error('only the asker can pick the answer');
    const a = this.hub.node.store.get(answerId);
    if (!a || a.rec.kind !== 'answer' || !a.rec.refs.includes(requestId)) throw new Error('that is not an answer to this bounty');
    if (a.operatorId === req.operatorId) throw new Error('answers from your own computers can\'t earn your bounty');
    await this.hub.confirm(answerId, { note: 'picked by the asker for the bounty' }, { publish: true });
    await this.settle();
    return this.view(req);
  }

  private request(id: string) {
    const s = this.hub.node.store.get(id);
    if (!s || s.rec.kind !== 'help_request' || !((s.rec.body as { bounty?: number }).bounty! > 0)) throw new Error('unknown bounty');
    return s;
  }

  private receipts(requestId: string, type: ReceiptBody['type']) {
    return this.hub.node.store.referencing(requestId, 'receipt').filter((r) => (r.rec.body as unknown as ReceiptBody).type === type);
  }

  private answers(req: StoredRecord) {
    return this.hub.node.store.referencing(req.rec.id, 'answer').filter((a) => a.operatorId !== req.operatorId).sort((x, y) => x.rec.created.localeCompare(y.rec.created));
  }

  view(req: StoredRecord, now = Date.now()): BountyView {
    const b = req.rec.body as unknown as BountyBody;
    const held = this.receipts(req.rec.id, 'bounty_hold').some((r) => r.rec.agent_id === req.rec.agent_id);
    const paid = this.receipts(req.rec.id, 'bounty_paid');
    const refunded = this.receipts(req.rec.id, 'bounty_refund').length > 0;
    const expires = b.expires ?? new Date(Date.parse(req.rec.created) + 7 * DAY).toISOString();
    const state = !held ? 'not_held' : paid.length ? 'paid' : refunded ? 'refunded' : Date.parse(expires) < now ? 'expired' : 'open';
    return {
      id: req.rec.id, question: b.question, amount: b.bounty, accept: b.accept ?? (b.verifier ? 'check' : 'asker'), verifier: b.verifier ?? '', expires, asker: req.rec.agent_id, at: req.rec.created, domain: req.rec.context.domain,
      state, answers: this.answers(req).length,
      paid_to: paid.map((r) => { const rb = r.rec.body as unknown as ReceiptBody; return { agent: rb.payee, answer: r.rec.refs[1] ?? '', amount: rb.amount }; }),
    };
  }

  list(o: { state?: BountyView['state'] | 'all'; mine?: boolean; domain?: string; limit?: number } = {}) {
    return this.hub.node.store.ofKind('help_request')
      .filter((s) => ((s.rec.body as { bounty?: number }).bounty ?? 0) > 0 && (!o.mine || s.rec.agent_id === this.hub.node.agentId) && (!o.domain || s.rec.context.domain.includes(o.domain)))
      .map((s) => this.view(s))
      .filter((v) => (o.state ?? 'open') === 'all' || v.state === (o.state ?? 'open'))
      .sort((a, b) => b.amount - a.amount || b.at.localeCompare(a.at))
      .slice(0, o.limit ?? 50);
  }

  /** Pay or refund every bounty escrowed on THIS ledger that is ready. Safe to call often; each payment happens once. */
  settle(now = Date.now()): Promise<number> {
    const run = this.busy.then(() => this.settleNow(now));
    this.busy = run.catch(() => 0);
    return run;
  }

  private async settleNow(now: number) {
    const economy = this.hub.economy;
    if (!economy?.rail.release) return 0;
    let n = 0;
    for (const req of this.hub.node.store.ofKind('help_request')) {
      const b = req.rec.body as unknown as BountyBody;
      if (!(b.bounty > 0)) continue;
      const held = economy.rail.balance(ESCROW(req.rec.id));
      if (held <= 0) continue; // nothing escrowed here (another ledger holds it, or it's settled)
      const v = this.view(req, now);
      const answers = this.answers(req);
      let winners: StoredRecord[] = [];
      if (v.accept === 'check') {
        const check = this.hub.problems.verifiers.get(b.verifier);
        for (const a of check ? answers : []) if ((await check!.check(b.check, String((a.rec.body as { answer?: string }).answer ?? ''))).ok) { winners = [a]; break; }
      } else {
        const picked = answers.find((a) => this.hub.node.store.referencing(a.rec.id, 'confirmation').some((c) => c.rec.agent_id === req.rec.agent_id));
        if (picked) winners = [picked];
        else if (Date.parse(v.expires) < now) winners = answers.filter((a) => this.hub.node.store.referencing(a.rec.id, 'confirmation').some((c) => c.operatorId !== req.operatorId && c.operatorId !== a.operatorId));
      }
      if (winners.length) {
        const share = Math.floor(held / winners.length);
        for (const [i, a] of winners.entries()) {
          const amount = i === winners.length - 1 ? held - share * (winners.length - 1) : share;
          await this.release(req, a.rec.agent_id, amount, 'bounty_paid', [req.rec.id, a.rec.id]);
        }
        n++;
      } else if (Date.parse(v.expires) < now) {
        await this.release(req, req.rec.agent_id, held, 'bounty_refund', [req.rec.id]);
        n++;
      }
    }
    return n;
  }

  private async release(req: StoredRecord, payee: string, amount: number, type: 'bounty_paid' | 'bounty_refund', refs: string[]) {
    const economy = this.hub.economy!;
    const ref = `${type}:${refs.join(':')}`;
    if (!economy.rail.release!(ESCROW(req.rec.id), payee, amount, ref)) return;
    const body = { type, payer: ESCROW(req.rec.id), payee, amount, tx: ref, rail: economy.rail.name, network: economy.rail.network, asker: req.rec.agent_id };
    await this.hub.node.submit({ kind: 'receipt', context: { task: `payment: ${type}`, domain: ['payments'], environment: economy.rail.network }, body, refs }, { publish: true });
  }

  /** Settle whenever an answer or a pick arrives, and on a timer for deadlines. */
  watch(everyMs = 10 * 60_000) {
    const off = this.hub.node.store.onAdd((s) => { if (s.rec.kind === 'answer' || s.rec.kind === 'confirmation') void this.settle(); });
    const t = setInterval(() => void this.settle(), everyMs); t.unref?.();
    return () => { off?.(); clearInterval(t); };
  }
  idle() { return this.busy; }
}

export const usd = (micro: number) => `$${(micro / 1e6).toFixed(micro % 1e6 ? 2 : 0)}`;
