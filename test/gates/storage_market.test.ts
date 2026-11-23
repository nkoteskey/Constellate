import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ed25519 } from '@noble/curves/ed25519.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { Hub } from '../../src/hub/hub.js';
import { LocalSigner } from '../../src/core/identity.js';
import { LocalArchive } from '../../src/store/archive.js';
import { addressFromPublicKey } from '../../src/economy/evm.js';
import { Facilitator, digest, paymentProblem, recoverAuthorizer, requirements, signAuthorization, authorization, type PaymentPayload } from '../../src/economy/x402-base.js';
import { cdpJwt, onrampUrl, parseCdpKey } from '../../src/economy/onramp.js';
import { WebServer } from '../../src/web/server.js';
import { registerAppRoutes } from '../../src/web/app.js';

/**
 * Store for others (src/economy/storage-market.ts), x402 on Base (src/economy/x402-base.ts), card purchases
 * (src/economy/onramp.ts) and the passkey wallet (js/evm-wallet.js): a computer with ANT stores other people's
 * contributions for USDC, the buyer signs one exact authorization in their own wallet, and nobody holds anyone's
 * money in between.
 */
const hex = (b: Uint8Array) => '0x' + Buffer.from(b).toString('hex');
const ctx = { task: 'a task', domain: ['ci'], environment: 'node 22' };
const failure = (i: number) => ({ kind: 'failure' as const, context: ctx, body: { approach: `approach ${i}`, outcome: 'error', error_summary: `broke ${i}`, confidence: 0.6 } });

/** A stand-in x402 facilitator that records what it was asked. */
function fakeFacilitator(opts: { valid?: boolean; settle?: boolean } = {}) {
  const calls: { path: string; body: any }[] = [];
  const f = (async (url: string, init: { body: string }) => {
    const path = new URL(url).pathname;
    calls.push({ path, body: JSON.parse(init.body) });
    if (path === '/verify') return new Response(JSON.stringify({ isValid: opts.valid ?? true, invalidReason: opts.valid === false ? 'insufficient_funds' : undefined }), { status: 200 });
    return new Response(JSON.stringify({ success: opts.settle ?? true, transaction: '0x' + 'cd'.repeat(32), network: 'base' }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fac: new Facilitator('https://facilitator.example', f), calls };
}

describe('x402 payments in USDC on Base', () => {
  it('hashes and recovers exactly as wallets do (EIP-712, checked against viem)', () => {
    // Vector computed with viem 2.21 (hashTypedData / signTypedData) for the private key 0x4242…42.
    const a = { from: '0x17c5185167401eD00cF5F5b2fc97D9BBfDb7D025', to: '0x' + '22'.repeat(20), value: '1234567', validAfter: '100', validBefore: '200', nonce: '0x' + 'ab'.repeat(32) };
    expect(hex(digest(a))).toBe('0xeee84ec48452bccb0ba5fb99542f87cd4885578b9f5a80971e4d958ffb4e0f0b');
    expect(recoverAuthorizer(a, '0xddbf4b8725046b592c0f31078754c56d6b52768be590c1508267fb0209fe0f345d03a27aaf47393fe5e7306fa148d234817ed950bb462803e37e8cbb515a33ff1c').toLowerCase()).toBe(a.from.toLowerCase());
    expect(signAuthorization(a, new Uint8Array(32).fill(0x42))).toBe('0xddbf4b8725046b592c0f31078754c56d6b52768be590c1508267fb0209fe0f345d03a27aaf47393fe5e7306fa148d234817ed950bb462803e37e8cbb515a33ff1c');
  });

  it('a payment is accepted only for the right payee, amount, time window and signer', () => {
    const sk = secp256k1.utils.randomSecretKey(), payer = addressFromPublicKey(secp256k1.getPublicKey(sk, false));
    const r = requirements({ amount: 50_000n, payTo: '0x' + '22'.repeat(20), resource: 'autonomi:store:x', description: 'Store' });
    const pay = (a = authorization(payer, r), key = sk): PaymentPayload => ({ x402Version: 1, scheme: 'exact', network: 'base', payload: { signature: signAuthorization(a, key), authorization: a } });
    expect(paymentProblem(pay(), r)).toBeNull();
    expect(paymentProblem(pay({ ...authorization(payer, r), to: '0x' + '33'.repeat(20) }), r)).toMatch(/someone else/);
    expect(paymentProblem(pay({ ...authorization(payer, r), value: '49999' }), r)).toMatch(/underpaid/);
    expect(paymentProblem(pay({ ...authorization(payer, r), validBefore: String(Math.floor(Date.now() / 1000) + 5) }), r)).toMatch(/expired/);
    expect(paymentProblem(pay(authorization(payer, r), secp256k1.utils.randomSecretKey()), r)).toMatch(/isn’t the payer’s/);
  });
});

describe('storing for others', () => {
  it('a seller with ANT stores a buyer’s bundle for USDC: priced, paid by signature, uploaded, settled, receipted', async () => {
    const home = mkdtempSync(join(tmpdir(), 'market-'));
    const shared = new LocalArchive(join(home, 'autonomi')); // both can read it, like Autonomi
    const seller = new Hub({ signer: LocalSigner.generate(), preview: false, archive: shared });
    const buyer = new Hub({ signer: LocalSigner.generate(), preview: false, archive: shared });
    const { fac, calls } = fakeFacilitator();
    seller.market.facilitator = fac;
    // An in-memory x0x: each side's messages go to the other's handler.
    const hubs = new Map([[seller.node.agentId, seller], [buyer.node.agentId, buyer]]);
    for (const [id, h] of hubs) h.market.transport = { send: async (to, msg) => { setTimeout(() => hubs.get(to)!.market.handle(id, Buffer.from(JSON.stringify(msg)).toString('base64')), 1); } };
    const payTo = '0x' + '22'.repeat(20);
    await expect(buyer.market.offer({ price_micro_usdc_per_mb: 50_000, min_micro_usdc: 10_000, max_bytes: 65536, pay_to: payTo, network: 'base' })).rejects.toThrow(/facilitator/);
    buyer.node.ingest(seller.node.store.get(await seller.market.offer({ price_micro_usdc_per_mb: 50_000, min_micro_usdc: 10_000, max_bytes: 65536, pay_to: payTo, network: 'base' }))!.rec);
    expect(buyer.market.offers()).toMatchObject([{ seller: seller.node.agentId, b: { pay_to: payTo }, stores: 0 }]);

    for (let i = 0; i < 3; i++) await buyer.node.submit(failure(i), { publish: true });
    const sk = secp256k1.utils.randomSecretKey(), payer = addressFromPublicKey(secp256k1.getPublicKey(sk, false));
    const q = await buyer.selfStore.marketQuote(seller.node.agentId, payer);
    expect(q).toMatchObject({ records: 3, price_micro_usdc: '10000', pay_to: payTo }); // the minimum, for a small bundle
    expect(q.typed_data).toMatchObject({ primaryType: 'TransferWithAuthorization', domain: { name: 'USD Coin', version: '2', chainId: 8453 }, message: { to: payTo, value: '10000' } });
    // The person's wallet signs the typed data (here, the same key in Node).
    const r = await buyer.selfStore.marketPay(q.id, signAuthorization(q.typed_data.message, sk));
    expect(r).toMatchObject({ stored: 3, archive: 'autonomi', published: true });
    expect(calls.map((c) => c.path)).toEqual(['/verify', '/settle']); // checked, uploaded, then settled
    expect(calls[1].body.paymentRequirements).toMatchObject({ scheme: 'exact', network: 'base', payTo, maxAmountRequired: '10000' });
    const receipt = buyer.node.store.get(r.receipt)!.rec.body as Record<string, any>;
    expect(receipt).toMatchObject({ type: 'self_store', stored_by: seller.node.agentId, verified: true, payment: { asset: 'USDC', network: 'base', amount_micro: '10000', transaction: '0x' + 'cd'.repeat(32) } });
    expect(await shared.get(r.address)).not.toBeNull();
    seller.node.ingest(buyer.node.store.get(r.receipt)!.rec);
    expect(seller.market.offers()[0]).toMatchObject({ stores: 1, checked_stores: 1 }); // the seller's record grows
    expect((await buyer.selfStore.quote()).waiting).toBe(0);

    // A payment the facilitator won't accept: nothing is uploaded, nothing settled.
    seller.market.facilitator = fakeFacilitator({ valid: false }).fac;
    await buyer.node.submit(failure(9), { publish: true });
    const q2 = await buyer.selfStore.marketQuote(seller.node.agentId, payer);
    await expect(buyer.selfStore.marketPay(q2.id, signAuthorization(q2.typed_data.message, sk))).rejects.toThrow(/payment not valid: insufficient_funds/);
    // A signature from someone else's key is refused before any facilitator is asked.
    seller.market.facilitator = fac;
    const q3 = await buyer.selfStore.marketQuote(seller.node.agentId, payer);
    await expect(buyer.selfStore.marketPay(q3.id, signAuthorization(q3.typed_data.message, secp256k1.utils.randomSecretKey()))).rejects.toThrow(/isn’t the payer’s/);
  });
});

describe('buying USDC by card (Coinbase Onramp)', () => {
  it('signs the CDP request with the stored Ed25519 key and returns only a Coinbase page', async () => {
    const seed = ed25519.utils.randomSecretKey(), pub = ed25519.getPublicKey(seed);
    const stored = JSON.stringify({ id: 'key-123', privateKey: Buffer.concat([Buffer.from(seed), Buffer.from(pub)]).toString('base64') });
    expect(parseCdpKey(stored).id).toBe('key-123');
    expect(parseCdpKey(`key-123:${Buffer.from(seed).toString('base64')}`).seed).toEqual(seed);
    expect(() => parseCdpKey('k:-----BEGIN EC PRIVATE KEY-----x')).toThrow(/Ed25519/);
    const jwt = cdpJwt(parseCdpKey(stored), 'POST', 'api.cdp.coinbase.com', '/platform/v2/onramp/sessions', 1_000_000);
    const [h, c, s] = jwt.split('.');
    expect(ed25519.verify(Buffer.from(s, 'base64url'), new TextEncoder().encode(`${h}.${c}`), pub)).toBe(true);
    expect(JSON.parse(Buffer.from(h, 'base64url').toString())).toMatchObject({ alg: 'EdDSA', typ: 'JWT', kid: 'key-123' });
    expect(JSON.parse(Buffer.from(c, 'base64url').toString())).toEqual({ iss: 'cdp', sub: 'key-123', aud: ['cdp_service'], nbf: 1_000_000, exp: 1_000_120, uri: 'POST api.cdp.coinbase.com/platform/v2/onramp/sessions' });

    let sent: any = null;
    const ok = (async (_u: string, init: { body: string; headers: Record<string, string> }) => { sent = { body: JSON.parse(init.body), auth: init.headers.authorization }; return new Response(JSON.stringify({ session: { onrampUrl: 'https://pay.coinbase.com/buy?sessionToken=abc' } }), { status: 200 }); }) as unknown as typeof fetch;
    const addr = '0x' + '11'.repeat(20);
    expect(await onrampUrl(stored, addr, 5, ok)).toBe('https://pay.coinbase.com/buy?sessionToken=abc');
    expect(sent.body).toEqual({ destinationAddress: addr, destinationNetwork: 'base', purchaseCurrency: 'USDC', paymentAmount: '5.00', paymentCurrency: 'USD' });
    expect(sent.auth).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    const evil = (async () => new Response(JSON.stringify({ session: { onrampUrl: 'https://pay.example.com/steal' } }), { status: 200 })) as unknown as typeof fetch;
    await expect(onrampUrl(stored, addr, 5, evil)).rejects.toThrow(/didn’t return a purchase page/);
    await expect(onrampUrl(undefined, addr, 5, ok)).rejects.toThrow(/Coinbase Developer Platform key/);
  });
});

describe('the passkey wallet', () => {
  it('loads Coinbase’s Base Account SDK only when chosen, and only the exact published file', async () => {
    const hub = new Hub({ signer: LocalSigner.generate(), preview: false });
    const web = new WebServer(hub); registerAppRoutes(web); await web.listen(0);
    const { chromium } = createRequire(import.meta.url)('playwright');
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      let fetched = 0;
      // Serve a different file at the SDK's address: the integrity hash must make the browser refuse it.
      await page.route('https://cdn.jsdelivr.net/**', (route: { fulfill: (r: object) => void }) => { fetched++; route.fulfill({ status: 200, contentType: 'text/javascript', body: 'window.base = { createBaseAccountSDK: () => ({ getProvider: () => ({ evil: true }) }) };' }); });
      await page.goto(`${web.url}/#/compute`);
      expect(fetched).toBe(0); // not loaded until someone picks it
      const r = await page.evaluate("import('/js/evm-wallet.js').then((m) => m.walletProvider('passkey')).then(() => 'loaded', (e) => e.message)");
      expect(fetched).toBe(1);
      expect(r).toMatch(/couldn’t load the Base Account SDK/);
      expect(await page.evaluate("import('/js/evm-wallet.js').then((m) => m.walletChoices().map((c) => c.id))")).toEqual(['passkey']); // no extension installed here
    } finally { await browser.close(); await web.close(); }
  }, 60_000);
});
