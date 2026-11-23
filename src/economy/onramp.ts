import { ed25519 } from '@noble/curves/ed25519.js';
import { randomBytes } from 'node:crypto';
import { isAddress } from './evm.js';

/**
 * Buy USDC on Base by card, delivered to the person's own wallet (docs/STORAGE.md, "Top up storage"), through
 * Coinbase Onramp. Coinbase handles the card, any identity checks, and delivery; this app never sees card details
 * or holds the money. Creating a session needs a Coinbase Developer Platform secret API key (Ed25519), which
 * whoever runs this computer stores with `constellate keys set cdp` (the JSON file Coinbase gives, or "id:secret").
 * Without one, the app says how to get USDC on Base another way.
 *
 * API (read 2026-11-22, docs.cdp.coinbase.com): POST https://api.cdp.coinbase.com/platform/v2/onramp/sessions with
 * a Bearer JWT (EdDSA; iss "cdp", sub and kid the key id, aud ["cdp_service"], nbf, exp two minutes later, uri
 * "POST host/path", a nonce in the header). Body: destinationAddress, destinationNetwork, purchaseCurrency,
 * paymentAmount, paymentCurrency. The answer's session.onrampUrl is single-use.
 */
export const ONRAMP = { host: 'api.cdp.coinbase.com', path: '/platform/v2/onramp/sessions' };
const b64url = (b: Uint8Array | string) => Buffer.from(typeof b === 'string' ? b : b).toString('base64url');

/** A CDP key from what `constellate keys set cdp` stored: Coinbase's JSON file, or "id:secret". */
export function parseCdpKey(stored: string): { id: string; seed: Uint8Array } {
  let id = '', secret = '';
  try { const j = JSON.parse(stored) as { id?: string; name?: string; privateKey?: string }; id = j.id ?? j.name ?? ''; secret = j.privateKey ?? ''; } catch { const i = stored.indexOf(':'); id = stored.slice(0, i); secret = stored.slice(i + 1); }
  if (!id || !secret) throw new Error('the stored cdp key needs an id and a secret');
  if (/BEGIN (EC )?PRIVATE KEY/.test(secret)) throw new Error('this is an ECDSA key; create an Ed25519 secret API key in the Coinbase Developer Platform');
  const raw = Buffer.from(secret.trim(), 'base64');
  if (raw.length !== 64 && raw.length !== 32) throw new Error('the cdp secret should be a base64 Ed25519 key');
  return { id, seed: new Uint8Array(raw.subarray(0, 32)) };
}

/** The Bearer JWT for one request, valid for two minutes. */
export function cdpJwt(key: { id: string; seed: Uint8Array }, method: string, host: string, path: string, now = Math.floor(Date.now() / 1000)): string {
  const header = { alg: 'EdDSA', typ: 'JWT', kid: key.id, nonce: randomBytes(16).toString('hex') };
  const claims = { iss: 'cdp', sub: key.id, aud: ['cdp_service'], nbf: now, exp: now + 120, uri: `${method} ${host}${path}` };
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  return `${input}.${b64url(ed25519.sign(new TextEncoder().encode(input), key.seed))}`;
}

/** A single-use Coinbase page where the person buys `usd` of USDC by card, delivered to `address` on Base. */
export async function onrampUrl(stored: string | undefined, address: string, usd: number, f: typeof fetch = fetch): Promise<string> {
  if (!stored) throw new Error('card purchases need a Coinbase Developer Platform key on this computer (constellate keys set cdp); or buy USDC on Base anywhere and send it to your wallet');
  if (!isAddress(address)) throw new Error('connect a wallet first');
  if (!(usd >= 2) || usd > 500) throw new Error('buy between $2 and $500');
  const key = parseCdpKey(stored);
  const r = await f(`https://${ONRAMP.host}${ONRAMP.path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cdpJwt(key, 'POST', ONRAMP.host, ONRAMP.path)}` },
    body: JSON.stringify({ destinationAddress: address, destinationNetwork: 'base', purchaseCurrency: 'USDC', paymentAmount: usd.toFixed(2), paymentCurrency: 'USD' }),
    signal: AbortSignal.timeout(15_000),
  });
  const j = (await r.json().catch(() => ({}))) as { session?: { onrampUrl?: string }; errorMessage?: string; message?: string };
  if (!r.ok) throw new Error(`Coinbase answered ${r.status}${j.errorMessage ?? j.message ? `: ${j.errorMessage ?? j.message}` : ''}`);
  const url = j.session?.onrampUrl;
  if (!url || !/^https:\/\/pay\.coinbase\.com\//.test(url)) throw new Error('Coinbase didn’t return a purchase page');
  return url;
}
