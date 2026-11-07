import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { PaymentRail, SignedMandate, Settlement, verifyMandate } from './rail.js';
import { canonicalBytes, sha256Hex } from '../core/canonical.js';

/**
 * Real-money credit, in micro-US-dollars (1,000,000 = $1, the same unit as the
 * pricing table and as USDC's six decimals). People top up with a card (Stripe)
 * or with USDC from MetaMask; the network pays contributors from these balances;
 * the owner pays balances out in USDC from MetaMask. Nothing here holds a key.
 *
 * Every change is a line in an append-only journal, so the books can always be
 * replayed and audited. Each external payment is applied exactly once (by ref).
 */
export interface JournalEntry { type: 'deposit' | 'transfer' | 'payout'; account: string; to?: string; amount: number; ref: string; source: string; at: string; note?: string }

export class CreditLedger implements PaymentRail {
  readonly name = 'credits';
  readonly network: string;
  private balances = new Map<string, number>();
  private refs = new Set<string>();
  private entries: JournalEntry[] = [];

  constructor(private readonly path: string | null, opts: { live?: boolean; play?: boolean } = {}) {
    this.network = opts.live ? 'constellate-credit:usd' : opts.play ? 'constellate-credit:play' : 'constellate-credit:usd-test';
    if (path && existsSync(path)) for (const line of readFileSync(path, 'utf8').split('\n')) if (line.trim()) this.apply(JSON.parse(line) as JournalEntry, false);
  }

  private apply(e: JournalEntry, write = true) {
    if (this.refs.has(e.ref)) return false;
    if (e.type === 'deposit') this.balances.set(e.account, this.balance(e.account) + e.amount);
    else {
      if (this.balance(e.account) < e.amount) throw new Error('insufficient credit');
      this.balances.set(e.account, this.balance(e.account) - e.amount);
      if (e.type === 'transfer' && e.to) this.balances.set(e.to, this.balance(e.to) + e.amount);
    }
    this.refs.add(e.ref);
    this.entries.push(e);
    if (write && this.path) { mkdirSync(dirname(this.path), { recursive: true }); appendFileSync(this.path, JSON.stringify(e) + '\n', { mode: 0o600 }); }
    return true;
  }

  balance(account: string) { return this.balances.get(account) ?? 0; }
  applied(ref: string) { return this.refs.has(ref); }
  history(account: string) { return this.entries.filter((e) => e.account === account || e.to === account); }

  /** Money in. Returns false if this payment was already applied. */
  deposit(account: string, amount: number, ref: string, source: string, note?: string) {
    if (!/^[0-9a-f]{64}$/.test(account)) throw new Error('credit goes to a Constellate identity (64 hex)');
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('bad amount');
    return this.apply({ type: 'deposit', account, amount, ref, source, at: new Date().toISOString(), note });
  }

  /** Money out to a contributor's wallet, once the owner's on-chain payment is confirmed. */
  payout(account: string, amount: number, ref: string, note?: string) {
    return this.apply({ type: 'payout', account, amount, ref, source: 'usdc', at: new Date().toISOString(), note });
  }

  /** The network paying for confirmed work: same signed mandates as the testnet rail. */
  async settle(s: SignedMandate): Promise<Settlement> {
    const err = verifyMandate(s);
    if (err) throw new Error(`payment refused: ${err}`);
    const m = s.mandate;
    const ref = `mandate:${m.nonce}`;
    if (this.refs.has(ref)) throw new Error('payment refused: replayed mandate');
    if (this.balance(m.payer) < m.amount) throw new Error('payment refused: insufficient credit');
    this.apply({ type: 'transfer', account: m.payer, to: m.payee, amount: m.amount, ref, source: 'mandate', at: new Date().toISOString(), note: m.purpose });
    return { tx: sha256Hex(canonicalBytes(s)).slice(0, 40), rail: this.name, network: this.network };
  }

  /** Bounties: money leaves an escrow account once, to the answer the bounty's rules picked (or back to the asker). */
  release(from: string, to: string, amount: number, ref: string) {
    if (!from.startsWith('escrow:')) throw new Error('only escrow accounts are released without a mandate');
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('bad amount');
    return this.apply({ type: 'transfer', account: from, to, amount, ref, source: 'escrow', at: new Date().toISOString(), note: ref.split(':')[0] });
  }

  /** Who is owed what, for the owner's payout page (money held for open bounties isn't anyone's yet). */
  owed(minimum = 1_000_000) { return [...this.balances.entries()].filter(([a, v]) => v >= minimum && !a.startsWith('escrow:')).map(([account, amount]) => ({ account, amount })).sort((a, b) => b.amount - a.amount); }
}
