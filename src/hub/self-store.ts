import { createHash } from 'node:crypto';
import type { Hub } from './hub.js';
import type { StoredRecord } from '../store/records.js';
import { AutonomiArchive } from '../store/autonomi.js';
import { makeBundle } from '../store/bundle.js';
import type { Authorization, Requirements } from '../economy/x402-base.js';

/**
 * Store what you shared permanently, paid by you (docs/STORAGE.md, "Each contributor stores their own").
 *
 * Sharing is free: records live on the computers of everyone running Constellate. Anyone who wants their own
 * contributions on Autonomi for good pays for exactly those, from this computer's own Autonomi wallet (the local
 * antd). No fund, no shared wallet, nobody else's money. Storing is permissionless, so nothing can stop it either.
 *
 * Each upload is one bundle of this computer's public records (up to PER_BUNDLE), with their original
 * signatures, and a signed `self_store` receipt: the Autonomi address, the bundle's sha256, the record ids, the
 * bytes and the cost. That is the proof of contribution, timestamped and permanent: anyone can fetch the bundle,
 * check its hash, and check every record's signature against the same key that signed the receipt.
 *
 * Private by choice: the records themselves are already public under this computer's key (a key, not a name,
 * unless the person linked one). The receipt says "this key paid to store these". Publish it, or keep it on this
 * computer only and show it to whoever you choose later.
 */
export const PER_BUNDLE = 200;
const NOT_STORED = new Set(['memory', 'receipt', 'batch_root', 'vote', 'use']);

export interface SelfStoreResult { stored: number; address: string; archive: 'autonomi' | 'local'; bundle_sha256: string; bytes: number; atto_ant: string; receipt: string; published: boolean }

export class SelfStore {
  constructor(private readonly hub: Hub) {}

  private receipts(): StoredRecord[] {
    const me = this.hub.node.operatorId;
    return this.hub.node.store.all().filter((s) => s.operatorId === me && s.rec.kind === 'receipt' && (s.rec.body as { type?: string }).type === 'self_store');
  }

  /** Ids this computer already stored itself (published or private receipts). */
  stored(): Set<string> { return new Set(this.receipts().flatMap((s) => (s.rec.body as { ids?: string[] }).ids ?? [])); }

  /** Records anyone has stored themselves, from public receipts: the library needn't pay for them again. */
  static storedByAnyone(records: StoredRecord[]): Set<string> {
    return new Set(records.filter((s) => s.visibility === 'public' && s.rec.kind === 'receipt' && (s.rec.body as { type?: string }).type === 'self_store').flatMap((s) => (s.rec.body as { ids?: string[] }).ids ?? []));
  }

  /**
   * This computer's public contributions not yet stored by it, oldest first. `also`: the person's own browser key on
   * this computer (the app passes it), whose records are theirs too.
   */
  waiting(also?: string): StoredRecord[] {
    const me = this.hub.node.operatorId, done = this.stored();
    return this.hub.node.store.all().filter((s) => (s.operatorId === me || (!!also && s.rec.agent_id === also)) && s.visibility === 'public' && !NOT_STORED.has(s.rec.kind) && !done.has(s.rec.id))
      .sort((a, b) => a.rec.created.localeCompare(b.rec.created));
  }

  /** What the next upload holds and what it would cost (asked of antd, free; null without Autonomi). */
  async quote(also?: string) {
    const next = this.waiting(also).slice(0, PER_BUNDLE);
    const bytes = next.length ? makeBundle(next.map((s) => s.rec), []).length : 0;
    const auto = this.hub.archive instanceof AutonomiArchive ? this.hub.archive : null;
    let atto: string | null = null;
    if (auto && bytes) {
      const url = (process.env.ANTD_URL ?? 'http://127.0.0.1:8082').replace(/\/$/, '');
      const r = await fetch(`${url}/v1/data/cost`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: Buffer.alloc(bytes, 0x5a).toString('base64'), payment_mode: 0 }) }).catch(() => null);
      const j = r?.ok ? ((await r.json().catch(() => ({}))) as { cost?: string }) : {};
      atto = typeof j.cost === 'string' && /^\d+$/.test(j.cost) ? j.cost : null;
    }
    return { waiting: this.waiting(also).length, next: next.length, bytes, archive: auto ? 'autonomi' as const : 'local' as const, atto_ant: atto, receipts: this.list() };
  }

  /** Upload the next bundle of this computer's contributions and sign the receipt. Publishes it unless `private`. */
  async run(opts: { private?: boolean; also?: string } = {}): Promise<SelfStoreResult | null> {
    const next = this.waiting(opts.also).slice(0, PER_BUNDLE);
    if (!next.length) return null;
    const auto = this.hub.archive instanceof AutonomiArchive ? this.hub.archive : null;
    const batches = this.hub.storage.batches().filter((b) => b.ids.some((id) => next.some((s) => s.rec.id === id)));
    const bytes = makeBundle(next.map((s) => s.rec), batches);
    const logFrom = auto?.log.length ?? 0;
    const address = await this.hub.archive.put(bytes);
    const atto = auto ? auto.log.slice(logFrom).reduce((n, e) => n + (/^\d+$/.test(e.atto) ? BigInt(e.atto) : 0n), 0n) : 0n;
    const body = {
      type: 'self_store', payer: this.hub.node.agentId, payee: auto ? 'autonomi' : 'local', amount: 0, tx: address, rail: 'archive', network: auto ? 'autonomi' : 'local',
      address, archive: auto ? 'autonomi' : 'local', bundle_sha256: createHash('sha256').update(bytes).digest('hex'), records: next.length, ids: next.map((s) => s.rec.id), bytes: bytes.length, atto_ant: atto.toString(),
    };
    const { record } = await this.hub.node.submit({ kind: 'receipt', context: { task: 'stored my contributions permanently', domain: ['storage'], environment: auto ? 'autonomi' : 'local' }, body, refs: [] }, opts.private ? { private: true } : { publish: true });
    return { stored: next.length, address, archive: body.archive as 'autonomi' | 'local', bundle_sha256: body.bundle_sha256, bytes: bytes.length, atto_ant: body.atto_ant, receipt: record.id, published: !opts.private };
  }

  // ── Through another computer that stores for others (src/economy/storage-market.ts) ──
  private pending = new Map<string, { seller: string; bundle: Uint8Array; ids: string[]; req: Requirements; auth: Authorization }>();

  /** The next bundle that fits under `maxBytes` (fewer records when needed). */
  private bundleUnder(maxBytes: number, also?: string) {
    let next = this.waiting(also).slice(0, PER_BUNDLE);
    let bytes = makeBundle(next.map((s) => s.rec), []);
    while (bytes.length > maxBytes && next.length > 1) { next = next.slice(0, Math.max(1, Math.floor(next.length / 2))); bytes = makeBundle(next.map((s) => s.rec), []); }
    if (bytes.length > maxBytes) throw new Error('a single contribution is larger than this computer takes at once');
    return { next, bytes };
  }

  /** Ask a seller's price for the next bundle; returns what the person's wallet signs. */
  async marketQuote(seller: string, payer: string, also?: string) {
    const offer = this.hub.market.offers().find((o) => o.seller === seller);
    if (!offer) throw new Error('that computer has no storage offer');
    if (!this.waiting(also).length) throw new Error('nothing new to store');
    const { next, bytes } = this.bundleUnder(offer.b.max_bytes, also);
    const q = await this.hub.market.quote(seller, bytes, payer);
    this.pending.set(q.id, { seller, bundle: bytes, ids: next.map((s) => s.rec.id), req: q.requirements, auth: q.authorization });
    return { id: q.id, records: next.length, bytes: bytes.length, price_micro_usdc: q.requirements.maxAmountRequired, pay_to: q.requirements.payTo, typed_data: q.typed_data };
  }

  /** Send the bundle with the signature from the person's wallet; sign the receipt when it's stored. */
  async marketPay(id: string, signature: string, opts: { private?: boolean } = {}): Promise<SelfStoreResult> {
    const p = this.pending.get(id);
    if (!p) throw new Error('that quote has expired; ask again');
    this.pending.delete(id);
    const r = await this.hub.market.pay(p.seller, id, p.bundle, p.req, p.auth, signature);
    const body = {
      type: 'self_store', payer: this.hub.node.agentId, payee: p.seller, amount: Number(p.req.maxAmountRequired), tx: r.transaction, rail: 'x402', network: 'base',
      address: r.address, archive: 'autonomi', bundle_sha256: createHash('sha256').update(p.bundle).digest('hex'), records: p.ids.length, ids: p.ids, bytes: p.bundle.length, atto_ant: '0',
      stored_by: p.seller, payment: { asset: 'USDC', network: 'base', amount_micro: p.req.maxAmountRequired, transaction: r.transaction }, verified: r.verified,
    };
    const { record } = await this.hub.node.submit({ kind: 'receipt', context: { task: 'stored my contributions permanently', domain: ['storage'], environment: 'autonomi' }, body, refs: [] }, opts.private ? { private: true } : { publish: true });
    return { stored: p.ids.length, address: r.address, archive: 'autonomi', bundle_sha256: body.bundle_sha256, bytes: p.bundle.length, atto_ant: '0', receipt: record.id, published: !opts.private };
  }

  /** Store through a seller, paid from this computer's agent spending wallet: no wallet prompt (docs/REWARDS.md). */
  async marketViaAgent(seller: string, opts: { private?: boolean; also?: string } = {}) {
    const w = this.hub.agentWallet;
    const q = await this.marketQuote(seller, w.address(), opts.also);
    return this.marketPay(q.id, w.sign(q.typed_data.message, `storing ${q.records} contributions through ${seller.slice(0, 12)}`), { private: opts.private });
  }

  /** This computer's receipts, newest first. */
  list() {
    return this.receipts().sort((a, b) => b.rec.created.localeCompare(a.rec.created)).map((s) => {
      const b = s.rec.body as { address: string; archive: string; records: number; bytes: number; atto_ant: string; bundle_sha256: string };
      return { receipt: s.rec.id, at: s.rec.created, address: b.address, archive: b.archive, records: b.records, bytes: b.bytes, atto_ant: b.atto_ant, bundle_sha256: b.bundle_sha256, published: s.visibility === 'public' };
    });
  }

  /** The signed receipt and how anyone checks it: a file to keep, share, or not. */
  proof(receiptId: string) {
    const s = this.receipts().find((r) => r.rec.id === receiptId);
    if (!s) return null;
    return {
      receipt: s.rec,
      how_to_check: [
        `Fetch the bundle at Autonomi address ${(s.rec.body as { address: string }).address} and check its sha256 matches bundle_sha256.`,
        'Open the bundle (src/store/bundle.ts): every record in it is signed with ML-DSA-65; check each signature.',
        'Check this receipt\'s signature: the same key (agent_id) signed it, at the time in "created".',
      ],
    };
  }
}
