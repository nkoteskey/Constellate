import { secp256k1 } from '@noble/curves/secp256k1.js';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { randomBytes } from 'node:crypto';
import { utf8 } from '../util/bytes.js';
import { addressFromPublicKey, isAddress, normalize } from './evm.js';
import { USDC_BASE, BASE } from './topup.js';

/**
 * x402 "exact" payments in USDC on Base, the standard way (x402 v1): the payer signs an EIP-3009
 * TransferWithAuthorization in their own wallet (eth_signTypedData_v4); the payee checks it here, then has an x402
 * facilitator settle it on Base (POST /settle). No hot key on the payee's computer moves money, and the payer's
 * wallet never gives anyone a standing allowance: one signature, one exact amount, one payee, a short time window.
 */
export const USDC_DOMAIN = { name: 'USD Coin', version: '2', chainId: BASE, verifyingContract: USDC_BASE };
export interface Authorization { from: string; to: string; value: string; validAfter: string; validBefore: string; nonce: string }
export interface Requirements { scheme: 'exact'; network: 'base'; maxAmountRequired: string; resource: string; description: string; mimeType: string; payTo: string; maxTimeoutSeconds: number; asset: string; extra: { name: string; version: string } }
export interface PaymentPayload { x402Version: 1; scheme: 'exact'; network: 'base'; payload: { signature: string; authorization: Authorization } }

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (s: string) => { const h = s.replace(/^0x/, ''); return new Uint8Array(h.match(/../g)?.map((x) => parseInt(x, 16)) ?? []); };
const word = (h: string) => h.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const k = (s: string) => hex(keccak_256(utf8(s)));
const DOMAIN_TYPE = k('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)');
const TWA_TYPE = k('TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)');

export function requirements(o: { amount: bigint; payTo: string; resource: string; description: string; seconds?: number }): Requirements {
  return { scheme: 'exact', network: 'base', maxAmountRequired: o.amount.toString(), resource: o.resource, description: o.description, mimeType: 'application/json', payTo: o.payTo, maxTimeoutSeconds: o.seconds ?? 600, asset: USDC_BASE, extra: { name: USDC_DOMAIN.name, version: USDC_DOMAIN.version } };
}

/** The EIP-712 digest a wallet signs for this authorization. */
export function digest(a: Authorization): Uint8Array {
  const domain = keccak_256(unhex(DOMAIN_TYPE + k(USDC_DOMAIN.name) + k(USDC_DOMAIN.version) + word(BigInt(USDC_DOMAIN.chainId).toString(16)) + word(USDC_DOMAIN.verifyingContract)));
  const struct = keccak_256(unhex(TWA_TYPE + word(a.from) + word(a.to) + word(BigInt(a.value).toString(16)) + word(BigInt(a.validAfter).toString(16)) + word(BigInt(a.validBefore).toString(16)) + word(a.nonce)));
  return keccak_256(new Uint8Array([0x19, 0x01, ...domain, ...struct]));
}

/** What the browser hands to eth_signTypedData_v4 (the payer signs in their own wallet). */
export function typedData(a: Authorization) {
  return {
    types: {
      EIP712Domain: [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }],
      TransferWithAuthorization: [{ name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' }],
    },
    primaryType: 'TransferWithAuthorization', domain: USDC_DOMAIN, message: a,
  };
}

/** A fresh authorization for the payer to sign: exactly the amount, to the payee, valid for a few minutes. */
export function authorization(from: string, r: Requirements, now = Math.floor(Date.now() / 1000)): Authorization {
  return { from, to: r.payTo, value: r.maxAmountRequired, validAfter: String(now - 60), validBefore: String(now + r.maxTimeoutSeconds), nonce: `0x${randomBytes(32).toString('hex')}` };
}

export function recoverAuthorizer(a: Authorization, signature: string): string {
  const sig = unhex(signature);
  if (sig.length !== 65) throw new Error('signature must be 65 bytes');
  const v = sig[64] >= 27 ? sig[64] - 27 : sig[64];
  return addressFromPublicKey(secp256k1.recoverPublicKey(new Uint8Array([v, ...sig.slice(0, 64)]), digest(a), { prehash: false }));
}

/** Sign like a wallet (tests and tools only). */
export function signAuthorization(a: Authorization, secretKey: Uint8Array) {
  const s = secp256k1.sign(digest(a), secretKey, { prehash: false, format: 'recovered' });
  return '0x' + hex(new Uint8Array([...s.slice(1), s[0] + 27]));
}

/** Why a payment can't be accepted for these requirements, or null. Checked here before any facilitator is asked. */
export function paymentProblem(p: PaymentPayload, r: Requirements, now = Math.floor(Date.now() / 1000)): string | null {
  const a = p?.payload?.authorization;
  if (p?.x402Version !== 1 || p.scheme !== 'exact' || p.network !== 'base' || !a) return 'not an x402 exact payment on Base';
  if (![a.from, a.to].every(isAddress) || !/^0x[0-9a-fA-F]{64}$/.test(a.nonce)) return 'malformed authorization';
  if (normalize(a.to) !== normalize(r.payTo)) return 'paid to someone else';
  if (BigInt(a.value) < BigInt(r.maxAmountRequired)) return 'underpaid';
  if (Number(a.validAfter) > now) return 'not valid yet';
  if (Number(a.validBefore) < now + 30) return 'expired or about to';
  try { if (normalize(recoverAuthorizer(a, p.payload.signature)) !== normalize(a.from)) return 'the signature isn’t the payer’s'; } catch { return 'invalid signature'; }
  return null;
}

/** An x402 facilitator (x402 v1 HTTP API): it verifies and settles the authorization on Base. */
export class Facilitator {
  constructor(readonly url: string, private readonly f: typeof fetch = fetch, private readonly headers: Record<string, string> = {}) {}
  private async post(path: string, body: unknown) {
    const r = await this.f(`${this.url.replace(/\/$/, '')}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...this.headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    const j = await r.json().catch(() => ({})) as any;
    if (!r.ok) throw new Error(`facilitator ${path} answered ${r.status}${j.error ? `: ${j.error}` : ''}`);
    return j;
  }
  async verify(p: PaymentPayload, r: Requirements) { const j = await this.post('/verify', { x402Version: 1, paymentPayload: p, paymentRequirements: r }); return { valid: !!j.isValid, reason: j.invalidReason ?? null }; }
  async settle(p: PaymentPayload, r: Requirements) { const j = await this.post('/settle', { x402Version: 1, paymentPayload: p, paymentRequirements: r }); return { ok: !!j.success, transaction: String(j.transaction ?? ''), reason: j.errorReason ?? null }; }
}

/** The facilitator configured on this computer (CONSTELLATE_X402_FACILITATOR), only with real payments on. */
export function facilitatorFromEnv(env = process.env): Facilitator | null {
  if (env.CONSTELLATE_PAYMENTS !== 'live' || !env.CONSTELLATE_X402_FACILITATOR) return null;
  return new Facilitator(env.CONSTELLATE_X402_FACILITATOR);
}
