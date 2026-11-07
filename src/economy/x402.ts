import { Signer } from '../core/identity.js';
import { PaymentRail, signMandate, SignedMandate, verifyMandate } from './rail.js';
import { toB64, fromB64, utf8, fromUtf8 } from '../util/bytes.js';

/**
 * x402 for human payments (sponsoring a problem, tipping a contributor).
 * Flow (x402 v1): the server answers 402 with `accepts` requirements; the
 * client pays and retries with an `X-PAYMENT` header; the server verifies and
 * settles through a facilitator and returns `X-PAYMENT-RESPONSE`.
 * Here the "exact" scheme carries a Constellate payment mandate and the
 * facilitator is the testnet ledger. On mainnet the payload would be an
 * EIP-3009 authorisation on Base settled by an x402 facilitator: human decision.
 */
export interface PaymentRequirements {
  scheme: 'exact';
  network: string;
  maxAmountRequired: string;
  resource: string;
  description: string;
  payTo: string;
  asset: string;
  maxTimeoutSeconds: number;
}

export function paymentRequired(req: Omit<PaymentRequirements, 'scheme' | 'asset' | 'maxTimeoutSeconds'>) {
  return { x402Version: 1, error: 'X-PAYMENT header is required', accepts: [{ scheme: 'exact', asset: 'USDC-testnet', maxTimeoutSeconds: 600, ...req }] };
}

export const encodePayment = (network: string, m: SignedMandate) => toB64(utf8(JSON.stringify({ x402Version: 1, scheme: 'exact', network, payload: m })));
export const decodePayment = (h: string): { x402Version: number; scheme: string; network: string; payload: SignedMandate } => JSON.parse(fromUtf8(fromB64(h)));

/** Server side: verify that a payment header satisfies the requirement, then settle it. */
export async function verifyAndSettle(rail: PaymentRail, header: string | undefined, req: PaymentRequirements) {
  if (!header) return { ok: false as const, status: 402, body: paymentRequired(req) };
  let p;
  try { p = decodePayment(header); } catch { return { ok: false as const, status: 400, body: { error: 'malformed X-PAYMENT' } }; }
  const m = p.payload.mandate;
  const problem = p.scheme !== 'exact' ? 'scheme' : p.network !== req.network ? 'network' : m.payee !== req.payTo ? 'payee' : m.amount < Number(req.maxAmountRequired) ? 'amount' : verifyMandate(p.payload);
  if (problem) return { ok: false as const, status: 402, body: { ...paymentRequired(req), error: `invalid payment: ${problem}` } };
  const s = await rail.settle(p.payload);
  return { ok: true as const, settlement: s, mandate: p.payload, responseHeader: toB64(utf8(JSON.stringify({ success: true, transaction: s.tx, network: s.network, payer: m.payer }))) };
}

/** Client side: fetch, and if the server asks for payment within `maxAmount`, pay and retry. */
export async function fetchWithPayment(url: string, init: RequestInit, signer: Signer, maxAmount: number): Promise<Response> {
  const first = await fetch(url, init);
  if (first.status !== 402) return first;
  const { accepts } = (await first.json()) as { accepts: PaymentRequirements[] };
  const req = accepts.find((a) => a.scheme === 'exact' && Number(a.maxAmountRequired) <= maxAmount);
  if (!req) throw new Error('payment required above your limit');
  const m = await signMandate(signer, { payee: req.payTo, amount: Number(req.maxAmountRequired), purpose: `x402 ${req.resource}` });
  return fetch(url, { ...init, headers: { ...(init.headers as Record<string, string>), 'X-PAYMENT': encodePayment(req.network, m) } });
}
