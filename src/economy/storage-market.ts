import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { Hub } from '../hub/hub.js';
import { isAddress } from './evm.js';
import { authorization, paymentProblem, requirements, typedData, type Authorization, type Facilitator, type PaymentPayload, type Requirements } from './x402-base.js';

/**
 * Storing for others (docs/STORAGE.md, "Store for others"): a computer that already holds ANT offers to store other
 * people's contributions on Autonomi, paid in USDC on Base with x402. The buyer never touches ANT.
 *
 * Offer: a signed `storage_offer` record (price per MB, a minimum, the most it takes at once, where to be paid).
 * Over x0x direct messages:
 *   buyer  → seller  store.ask    { id, sha256, bytes }
 *   seller → buyer   store.price  { id, requirements }            (x402 "exact", USDC on Base)
 *   buyer  → seller  store.pay    { id, bundle, payment }          (the bundle, and an EIP-3009 authorization signed
 *                                                                  in the buyer's own wallet)
 *   seller → buyer   store.done   { id, address, transaction }     or store.failed { id, reason }
 * The seller checks the bundle matches what was priced and the payment (here, then with its x402 facilitator),
 * uploads, and only then settles. The buyer's receipt names who stored it and the payment transaction, and says
 * whether this computer could read the bundle back from Autonomi; anyone who can read it later can check it.
 *
 * Trust, said plainly: the buyer signs before the upload, so a dishonest seller could take a small payment and
 * not store. Payments are small, the authorization is for one exact amount for minutes, and a seller's record of
 * stores that others checked is shown next to its offer.
 */
export const MAX_MARKET_BYTES = 256 * 1024; // what fits in an x0x direct message comfortably
export const OfferBody = z.object({
  price_micro_usdc_per_mb: z.number().int().min(1).max(100_000_000),
  min_micro_usdc: z.number().int().min(0).max(10_000_000),
  max_bytes: z.number().int().min(1024).max(MAX_MARKET_BYTES),
  pay_to: z.string().refine(isAddress, 'a Base address'),
  network: z.literal('base'),
  note: z.string().max(200).default(''),
});
export type OfferBody = z.infer<typeof OfferBody>;

export interface Transport { send(agentId: string, msg: Record<string, unknown>): Promise<void> }
type Msg = { t: string; id: string; [k: string]: unknown };

export const priceOf = (o: OfferBody, bytes: number) => BigInt(Math.max(o.min_micro_usdc, Math.ceil((bytes / 1e6) * o.price_micro_usdc_per_mb)));

export class StorageMarket {
  private asks = new Map<string, { buyer: string; sha256: string; bytes: number; req: Requirements }>();
  private waiting = new Map<string, (m: Msg) => void>();
  transport: Transport | null = null;
  facilitator: Facilitator | null = null;
  constructor(private readonly hub: Hub) {}

  /** Offers on the network, cheapest first, with each seller's stores that buyers could check. */
  offers() {
    const latest = new Map<string, { id: string; seller: string; at: string; b: OfferBody }>();
    for (const s of this.hub.node.store.ofKind('storage_offer' as never)) {
      const p = OfferBody.safeParse(s.rec.body);
      if (!p.success) continue;
      const prev = latest.get(s.rec.agent_id);
      if (!prev || s.rec.created > prev.at) latest.set(s.rec.agent_id, { id: s.rec.id, seller: s.rec.agent_id, at: s.rec.created, b: p.data });
    }
    const receipts = this.hub.node.store.ofKind('receipt').filter((r) => (r.rec.body as { type?: string; stored_by?: string }).type === 'self_store' && (r.rec.body as { stored_by?: string }).stored_by);
    return [...latest.values()].map((o) => ({ ...o, checked_stores: receipts.filter((r) => (r.rec.body as { stored_by: string; verified?: boolean }).stored_by === o.seller && (r.rec.body as { verified?: boolean }).verified).length, stores: receipts.filter((r) => (r.rec.body as { stored_by: string }).stored_by === o.seller).length }))
      .sort((a, b) => a.b.price_micro_usdc_per_mb - b.b.price_micro_usdc_per_mb);
  }

  /** Offer to store for others (needs Autonomi and an x402 facilitator on this computer). */
  async offer(b: z.input<typeof OfferBody>) {
    const body = OfferBody.parse(b);
    if (!this.facilitator) throw new Error('storing for others needs real payments on and an x402 facilitator (CONSTELLATE_X402_FACILITATOR)');
    const { record } = await this.hub.node.submit({ kind: 'storage_offer' as never, context: { task: 'store on Autonomi for others', domain: ['storage'], environment: 'autonomi' }, body, refs: [] }, { publish: true });
    return record.id;
  }

  private myOffer(): OfferBody | null { return this.offers().find((o) => o.seller === this.hub.node.agentId)?.b ?? null; }

  /** Incoming direct message. True when it was a market message (handled or refused). */
  handle(sender: string, payloadB64: string): boolean {
    let m: Msg;
    try { m = JSON.parse(Buffer.from(payloadB64, 'base64').toString('utf8')); } catch { return false; }
    if (typeof m?.t !== 'string' || !m.t.startsWith('store.') || typeof m.id !== 'string') return false;
    void this.receive(sender, m).catch(() => {});
    return true;
  }

  private async receive(sender: string, m: Msg) {
    const w = this.waiting.get(m.id);
    if (w && ['store.price', 'store.no', 'store.done', 'store.failed'].includes(m.t)) { this.waiting.delete(m.id); w(m); return; }
    const reply = (msg: Record<string, unknown>) => this.transport?.send(sender, { id: m.id, ...msg });
    if (m.t === 'store.ask') {
      const o = this.myOffer();
      const bytes = Number(m.bytes), sha256 = String(m.sha256);
      if (!o || !this.facilitator) return reply({ t: 'store.no', reason: 'this computer isn’t storing for others' });
      if (!(bytes > 0) || bytes > o.max_bytes || !/^[0-9a-f]{64}$/.test(sha256)) return reply({ t: 'store.no', reason: `up to ${o.max_bytes} bytes at once` });
      const req = requirements({ amount: priceOf(o, bytes), payTo: o.pay_to, resource: `autonomi:store:${sha256}`, description: `Store ${bytes} bytes on Autonomi` });
      this.asks.set(m.id, { buyer: sender, sha256, bytes, req });
      return reply({ t: 'store.price', requirements: req });
    }
    if (m.t === 'store.pay') {
      const ask = this.asks.get(m.id);
      if (!ask || ask.buyer !== sender) return reply({ t: 'store.failed', reason: 'no price was asked for this' });
      this.asks.delete(m.id);
      const bundle = Buffer.from(String(m.bundle ?? ''), 'base64');
      if (bundle.length !== ask.bytes || createHash('sha256').update(bundle).digest('hex') !== ask.sha256) return reply({ t: 'store.failed', reason: 'the bundle isn’t the one that was priced' });
      const payment = m.payment as PaymentPayload;
      // A wallet's own signature is checked here; a smart-wallet signature (not 65 bytes) is left to the facilitator.
      const local = String(payment?.payload?.signature ?? '').replace(/^0x/, '').length === 130 ? paymentProblem(payment, ask.req) : null;
      if (local) return reply({ t: 'store.failed', reason: local });
      const v = await this.facilitator!.verify(payment, ask.req).catch((e) => ({ valid: false, reason: (e as Error).message }));
      if (!v.valid) return reply({ t: 'store.failed', reason: `payment not valid: ${v.reason ?? 'refused'}` });
      const address = await this.hub.archive.put(new Uint8Array(bundle));
      const s = await this.facilitator!.settle(payment, ask.req).catch((e) => ({ ok: false, transaction: '', reason: (e as Error).message }));
      if (!s.ok) return reply({ t: 'store.failed', reason: `stored, but the payment didn’t settle: ${s.reason ?? 'refused'}` });
      return reply({ t: 'store.done', address, transaction: s.transaction });
    }
  }

  private ask(seller: string, msg: Record<string, unknown>, ms: number): Promise<Msg> {
    const id = String(msg.id);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.waiting.delete(id); reject(new Error('the storing computer didn’t answer')); }, ms);
      this.waiting.set(id, (m) => { clearTimeout(t); resolve(m); });
      this.transport!.send(seller, msg).catch((e) => { clearTimeout(t); this.waiting.delete(id); reject(e); });
    });
  }

  /** Buyer, step 1: the price for a bundle, and what the buyer's wallet signs. */
  async quote(seller: string, bundle: Uint8Array, payer: string) {
    if (!this.transport) throw new Error('not on the x0x network');
    if (!isAddress(payer)) throw new Error('connect a wallet first');
    const id = randomBytes(8).toString('hex');
    const m = await this.ask(seller, { t: 'store.ask', id, sha256: createHash('sha256').update(bundle).digest('hex'), bytes: bundle.length }, 30_000);
    if (m.t !== 'store.price') throw new Error(String(m.reason ?? 'refused'));
    const req = m.requirements as Requirements;
    const offer = this.offers().find((o) => o.seller === seller);
    if (!offer || BigInt(req.maxAmountRequired) > priceOf(offer.b, bundle.length) || req.payTo.toLowerCase() !== offer.b.pay_to.toLowerCase()) throw new Error('the price asked doesn’t match the seller’s published offer');
    const auth = authorization(payer, req);
    return { id, requirements: req, authorization: auth, typed_data: typedData(auth) };
  }

  /** Buyer, step 2: send the bundle with the signed authorization; returns where it was stored. */
  async pay(seller: string, id: string, bundle: Uint8Array, req: Requirements, auth: Authorization, signature: string) {
    const payment: PaymentPayload = { x402Version: 1, scheme: 'exact', network: 'base', payload: { signature, authorization: auth } };
    const m = await this.ask(seller, { t: 'store.pay', id, bundle: Buffer.from(bundle).toString('base64'), payment }, 180_000);
    if (m.t !== 'store.done') throw new Error(String(m.reason ?? 'not stored'));
    // Check it ourselves where we can read Autonomi; otherwise say it isn't checked yet.
    const back = await this.hub.archive.get(String(m.address)).catch(() => null);
    const verified = !!back && createHash('sha256').update(back).digest('hex') === createHash('sha256').update(bundle).digest('hex');
    return { address: String(m.address), transaction: String(m.transaction ?? ''), verified };
  }
}
