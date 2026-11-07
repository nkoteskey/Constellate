import { Signer, verifyExternal, peerIdFromPublicKey } from '../core/identity.js';
import { canonicalBytes, sha256Hex } from '../core/canonical.js';
import { fromB64, fromHex, toB64 } from '../util/bytes.js';

/**
 * Payments. Amounts are integer micro-units of a USD stablecoin (1_000_000 = $1).
 * Every transfer is authorised by a payment mandate the payer signs with its
 * agent key (AP2-style: the mandate states payer, payee, amount, purpose and
 * the record it pays for), so payments are attributable and auditable.
 *
 * TESTNET ONLY. The only rail implemented is an in-process testnet ledger.
 * Mainnet (x402 on Base, AP2) needs a human decision and is not wired.
 */
export const PAYMENT_CONTEXT = 'constellate.payment.v1';

export interface Mandate {
  payer: string; // agent id
  payer_key: string; // b64 public key
  payee: string; // agent or operator id
  amount: number; // micro-units
  purpose: string;
  for_record?: string;
  nonce: string;
  expires: string; // ISO
}
export interface SignedMandate { mandate: Mandate; signature: string }

export async function signMandate(signer: Signer, m: Omit<Mandate, 'payer' | 'payer_key' | 'nonce' | 'expires'> & { expiresInSec?: number }): Promise<SignedMandate> {
  const mandate: Mandate = {
    payer: signer.agentId, payer_key: toB64(signer.publicKey), payee: m.payee, amount: Math.floor(m.amount), purpose: m.purpose, for_record: m.for_record,
    nonce: sha256Hex(canonicalBytes([signer.agentId, m.payee, m.amount, m.for_record ?? '', Date.now(), Math.random()])).slice(0, 32),
    expires: new Date(Date.now() + (m.expiresInSec ?? 600) * 1000).toISOString(),
  };
  if (!mandate.for_record) delete mandate.for_record;
  const sig = await signer.sign(PAYMENT_CONTEXT, fromHex(sha256Hex(canonicalBytes(mandate))));
  return { mandate, signature: toB64(sig) };
}

export function verifyMandate(s: SignedMandate, now = Date.now()): string | null {
  const m = s.mandate;
  if (!Number.isInteger(m.amount) || m.amount <= 0) return 'bad amount';
  if (Date.parse(m.expires) < now) return 'mandate expired';
  const pk = fromB64(m.payer_key);
  if (peerIdFromPublicKey(pk) !== m.payer) return 'payer key mismatch';
  if (!verifyExternal(pk, PAYMENT_CONTEXT, fromHex(sha256Hex(canonicalBytes(m))), fromB64(s.signature))) return 'bad mandate signature';
  return null;
}

export interface Settlement { tx: string; rail: string; network: string }

export interface PaymentRail {
  readonly name: string;
  readonly network: string;
  settle(m: SignedMandate): Promise<Settlement>;
  balance(account: string): number;
  /**
   * Move money out of an account this ledger holds for the network, once: a bounty's `escrow:` account
   * (src/economy/bounties.ts) or the storage fund's `fund:` account (src/economy/fund.ts).
   * Returns false if `ref` was already applied. Only the ledger's own hub calls it, after its own checks.
   */
  release?(from: string, to: string, amount: number, ref: string): boolean;
}

/** Testnet ledger with faucet. Rejects bad signatures, overdrafts and replayed mandates. */
export class TestnetLedger implements PaymentRail {
  readonly name = 'testnet-ledger';
  readonly network = 'constellate-testnet';
  private balances = new Map<string, number>();
  private seen = new Set<string>();
  readonly txs: { tx: string; from: string; to: string; amount: number; purpose: string; for_record?: string }[] = [];

  faucet(account: string, amount: number) { this.balances.set(account, this.balance(account) + amount); }

  release(from: string, to: string, amount: number, ref: string) {
    if (!/^(escrow|fund):/.test(from)) throw new Error('only escrow and fund accounts are released without a mandate');
    if (this.seen.has(ref)) return false;
    if (!Number.isSafeInteger(amount) || amount <= 0 || this.balance(from) < amount) throw new Error('escrow does not hold that much');
    this.seen.add(ref);
    this.balances.set(from, this.balance(from) - amount);
    this.balances.set(to, this.balance(to) + amount);
    this.txs.push({ tx: ref, from, to, amount, purpose: ref.split(':')[0] });
    return true;
  }
  balance(account: string) { return this.balances.get(account) ?? 0; }

  async settle(s: SignedMandate): Promise<Settlement> {
    const err = verifyMandate(s);
    if (err) throw new Error(`payment refused: ${err}`);
    const m = s.mandate;
    if (this.seen.has(m.nonce)) throw new Error('payment refused: replayed mandate');
    if (this.balance(m.payer) < m.amount) throw new Error('payment refused: insufficient testnet balance');
    this.seen.add(m.nonce);
    this.balances.set(m.payer, this.balance(m.payer) - m.amount);
    this.balances.set(m.payee, this.balance(m.payee) + m.amount);
    const tx = sha256Hex(canonicalBytes(s)).slice(0, 40);
    this.txs.push({ tx, from: m.payer, to: m.payee, amount: m.amount, purpose: m.purpose, for_record: m.for_record });
    return { tx, rail: this.name, network: this.network };
  }
}
