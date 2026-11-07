import { describe, it, expect, afterEach } from 'vitest';
import { createServer, Server } from 'node:http';
import { createHmac } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { CreditLedger } from '../../src/economy/credits.js';
import { fundingConfig, verifyStripeSignature, applyStripeEvent, stripeCheckout, claimUsdc, confirmPayout, claimMessage, NETWORKS } from '../../src/economy/funding.js';
import { addressFromPublicKey, personalSign, recoverSigner, TRANSFER_TOPIC } from '../../src/economy/evm.js';
import { AutonomiArchive, autonomiFromEnv } from '../../src/store/autonomi.js';
import { signMandate } from '../../src/economy/rail.js';
import { LocalSigner } from '../../src/core/identity.js';
import { Hub } from '../../src/hub/hub.js';
import { WebServer } from '../../src/web/server.js';
import { registerAppRoutes } from '../../src/web/app.js';
import { registerFundingRoutes } from '../../src/economy/funding-routes.js';

/**
 * Real money, ready but off. Everything here runs against stand-ins shaped
 * from the official docs (Stripe's API and webhook signing, Base JSON-RPC,
 * Autonomi's antd REST API): READY FOR TESTING with test keys, then live.
 */
const servers: Server[] = [];
afterEach(() => { for (const s of servers.splice(0)) s.close(); });
const serve = async (handler: (method: string, path: string, body: any) => [number, unknown]) => {
  const s = createServer(async (req, res) => {
    const c: Buffer[] = []; for await (const x of req) c.push(x as Buffer);
    const body = c.length ? JSON.parse(Buffer.concat(c).toString()) : undefined;
    const [code, out] = handler(req.method!, req.url!, body);
    res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(out));
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  servers.push(s);
  return `http://127.0.0.1:${(s.address() as { port: number }).port}`;
};
const vault = (m: Record<string, string>) => ({ get: (n: string) => m[n] });
const acct = 'a'.repeat(64);

describe('payments: off by default, real money only when the owner says so', () => {
  it('is off unless turned on; live needs explicit approval and a live key', () => {
    expect(fundingConfig({}, vault({}))).toBeNull();
    expect(() => fundingConfig({ CONSTELLATE_PAYMENTS: 'live' }, vault({}))).toThrow(/MAINNET_APPROVED/);
    expect(() => fundingConfig({ CONSTELLATE_PAYMENTS: 'live', CONSTELLATE_MAINNET_APPROVED: 'yes' }, vault({ stripe: 'sk_test_x' }))).toThrow(/sk_live_/);
    const t = fundingConfig({ CONSTELLATE_PAYMENTS: 'test', CONSTELLATE_USDC_DEPOSIT_ADDRESS: '0x' + '1'.repeat(40) }, vault({ stripe: 'sk_test_x', 'stripe-webhook': 'whsec_x' }))!;
    expect(t.usdc).toMatchObject({ chainId: 84532, token: NETWORKS.test.usdc });
    expect(t.stripe).toBeTruthy();
    const live = fundingConfig({ CONSTELLATE_PAYMENTS: 'live', CONSTELLATE_MAINNET_APPROVED: 'yes', CONSTELLATE_USDC_DEPOSIT_ADDRESS: '0x' + '1'.repeat(40) }, vault({}))!;
    expect(live.usdc).toMatchObject({ chainId: 8453, token: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', minConfirmations: 5 });
  });

  it('the credit journal replays exactly and applies each payment once', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'credits-')), 'credits.jsonl');
    const l = new CreditLedger(path);
    expect(l.deposit(acct, 5_000_000, 'stripe:cs_1', 'stripe')).toBe(true);
    expect(l.deposit(acct, 5_000_000, 'stripe:cs_1', 'stripe')).toBe(false); // the same webhook twice
    const payer = LocalSigner.generate();
    l.deposit(payer.agentId, 1_000_000, 'stripe:cs_2', 'stripe');
    await l.settle(await signMandate(payer, { payee: acct, amount: 250_000, purpose: 'review_fee' }));
    const again = new CreditLedger(path);
    expect([again.balance(acct), again.balance(payer.agentId)]).toEqual([5_250_000, 750_000]);
  });
});

describe('Stripe: card top-ups', () => {
  it('verifies webhook signatures exactly as Stripe signs them', () => {
    const raw = '{"id":"evt_1"}', secret = 'whsec_test', t = 1_700_000_000;
    const v1 = createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');
    expect(verifyStripeSignature(`t=${t},v1=${v1}`, raw, secret, t + 10)).toBe(true);
    expect(verifyStripeSignature(`t=${t},v1=deadbeef,v1=${v1}`, raw, secret, t + 10)).toBe(true); // rolling secrets
    expect(verifyStripeSignature(`t=${t},v1=${v1}`, raw, 'whsec_other', t + 10)).toBe(false);
    expect(verifyStripeSignature(`t=${t},v1=${v1}`, raw + ' ', secret, t + 10)).toBe(false);
    expect(verifyStripeSignature(`t=${t},v1=${v1}`, raw, secret, t + 301)).toBe(false); // too old
  });

  it('creates a Checkout Session for the right account and credits it once paid', async () => {
    const real = globalThis.fetch; let sent: { url: string; auth: string; body: string } | null = null;
    globalThis.fetch = (async (url: string, init: RequestInit) => { sent = { url, auth: String((init.headers as Record<string, string>).authorization), body: String(init.body) }; return new Response(JSON.stringify({ id: 'cs_9', url: 'https://checkout.stripe.com/c/pay/cs_9' })); }) as typeof fetch;
    try {
      const r = await stripeCheckout({ secret: 'sk_test_abc', webhookSecret: 'w' }, { account: acct, amountCents: 2000, successUrl: 'http://x/ok', cancelUrl: 'http://x/no' });
      expect(r.url).toMatch(/checkout\.stripe\.com/);
      expect(sent!.url).toBe('https://api.stripe.com/v1/checkout/sessions');
      expect(sent!.auth).toBe(`Basic ${Buffer.from('sk_test_abc:').toString('base64')}`);
      const form = new URLSearchParams(sent!.body);
      expect(form.get('client_reference_id')).toBe(acct);
      expect(form.get('line_items[0][price_data][unit_amount]')).toBe('2000');
    } finally { globalThis.fetch = real; }
    await expect(stripeCheckout({ secret: 's', webhookSecret: 'w' }, { account: acct, amountCents: 50, successUrl: '', cancelUrl: '' })).rejects.toThrow(/between \$1/);
    const l = new CreditLedger(null);
    const ev = { type: 'checkout.session.completed', data: { object: { id: 'cs_9', payment_status: 'paid', currency: 'usd', amount_total: 2000, client_reference_id: acct } } };
    expect(applyStripeEvent(l, ev)).toEqual({ account: acct, amount: 20_000_000 });
    expect(applyStripeEvent(l, ev)).toBeNull();
    expect(applyStripeEvent(l, { ...ev, data: { object: { ...ev.data.object, id: 'cs_10', payment_status: 'unpaid' } } })).toBeNull();
    expect(l.balance(acct)).toBe(20_000_000);
  });

  it('the webhook route checks the raw body’s signature before crediting', async () => {
    const hub = new Hub({ signer: LocalSigner.generate(), preview: false });
    const web = new WebServer(hub); registerAppRoutes(web);
    const ledger = new CreditLedger(null);
    const cfg = fundingConfig({ CONSTELLATE_PAYMENTS: 'test' }, vault({ stripe: 'sk_test_x', 'stripe-webhook': 'whsec_hook' }))!;
    registerFundingRoutes(web, hub, { ledger, cfg }); await web.listen(0);
    try {
      const raw = JSON.stringify({ type: 'checkout.session.completed', data: { object: { id: 'cs_w', payment_status: 'paid', currency: 'usd', amount_total: 500, client_reference_id: acct } } });
      const t = Math.floor(Date.now() / 1000);
      const sig = createHmac('sha256', 'whsec_hook').update(`${t}.${raw}`).digest('hex');
      const bad = await fetch(`${web.url}/api/funds/stripe/webhook`, { method: 'POST', headers: { 'stripe-signature': `t=${t},v1=00` }, body: raw });
      expect(bad.status).toBe(400);
      const ok = await (await fetch(`${web.url}/api/funds/stripe/webhook`, { method: 'POST', headers: { 'stripe-signature': `t=${t},v1=${sig}` }, body: raw })).json();
      expect(ok.credited).toEqual({ account: acct, amount: 5_000_000 });
      expect((await (await fetch(`${web.url}/api/funds/config`)).json())).toMatchObject({ enabled: true, mode: 'test', stripe: true });
    } finally { await web.close(); }
  });
});

describe('USDC on Base from MetaMask', () => {
  const deposit = '0x' + 'd'.repeat(40);
  const sk = secp256k1.utils.randomSecretKey();
  const sender = addressFromPublicKey(secp256k1.getPublicKey(sk, false));
  const tx = '0x' + 'e'.repeat(64);
  const chain = (opts: { to?: string; amount?: bigint; head?: number }) => serve((_m, _p, b) => {
    if (b.method === 'eth_blockNumber') return [200, { jsonrpc: '2.0', id: 1, result: '0x' + (opts.head ?? 105).toString(16) }];
    const log = { address: NETWORKS.test.usdc, topics: [TRANSFER_TOPIC, '0x' + sender.slice(2).padStart(64, '0'), '0x' + (opts.to ?? deposit).slice(2).padStart(64, '0')], data: '0x' + (opts.amount ?? 5_000_000n).toString(16).padStart(64, '0') };
    return [200, { jsonrpc: '2.0', id: 1, result: { status: '0x1', blockNumber: '0x64', from: sender, to: NETWORKS.test.usdc, logs: [log] } }];
  });

  it('recovers MetaMask personal_sign signatures', () => {
    expect(recoverSigner('hello', personalSign('hello', sk))).toBe(sender);
  });

  it('credits a confirmed transfer once, only to the person who sent it', async () => {
    const rpc = await chain({});
    const cfg = { depositAddress: deposit, rpc, token: NETWORKS.test.usdc, chainId: 84532, network: 'Base Sepolia', explorer: '', minConfirmations: 3 };
    const l = new CreditLedger(null);
    const other = secp256k1.utils.randomSecretKey();
    await expect(claimUsdc(l, cfg, { account: acct, tx, signature: personalSign(claimMessage(acct, tx), other) })).rejects.toThrow(/wallet that sent/);
    expect(await claimUsdc(l, cfg, { account: acct, tx, signature: personalSign(claimMessage(acct, tx), sk) })).toMatchObject({ pending: false, amount: 5_000_000, from: sender });
    expect(l.balance(acct)).toBe(5_000_000);
    await expect(claimUsdc(l, cfg, { account: acct, tx, signature: personalSign(claimMessage(acct, tx), sk) })).rejects.toThrow(/already credited/);
  });

  it('waits for confirmations, and refuses transfers that went elsewhere', async () => {
    const l = new CreditLedger(null);
    const young = await chain({ head: 100 });
    expect(await claimUsdc(l, { depositAddress: deposit, rpc: young, token: NETWORKS.test.usdc, chainId: 84532, network: 'x', explorer: '', minConfirmations: 3 }, { account: acct, tx, signature: personalSign(claimMessage(acct, tx), sk) })).toEqual({ pending: true });
    const elsewhere = await chain({ to: '0x' + '9'.repeat(40) });
    await expect(claimUsdc(l, { depositAddress: deposit, rpc: elsewhere, token: NETWORKS.test.usdc, chainId: 84532, network: 'x', explorer: '', minConfirmations: 1 }, { account: acct, tx, signature: personalSign(claimMessage(acct, tx), sk) })).rejects.toThrow(/sent no USDC/);
  });

  it('records a payout only after the owner’s USDC transfer is confirmed in full', async () => {
    const payee = '0x' + '7'.repeat(40);
    const l = new CreditLedger(null); l.deposit(acct, 3_000_000, 'stripe:x', 'stripe');
    const short = await chain({ to: payee, amount: 1_000_000n });
    const cfg = (rpc: string) => ({ depositAddress: deposit, rpc, token: NETWORKS.test.usdc, chainId: 84532, network: 'x', explorer: '', minConfirmations: 1 });
    await expect(confirmPayout(l, cfg(short), { account: acct, to: payee, tx, amount: 3_000_000 })).rejects.toThrow(/less than/);
    const full = await chain({ to: payee, amount: 3_000_000n });
    expect(await confirmPayout(l, cfg(full), { account: acct, to: payee, tx, amount: 3_000_000 })).toEqual({ pending: false });
    expect(l.balance(acct)).toBe(0);
  });
});

describe('Autonomi mainnet archive (through antd)', () => {
  it('needs explicit approval and every setting before it will spend', () => {
    expect(autonomiFromEnv({})).toBeNull();
    expect(() => autonomiFromEnv({ CONSTELLATE_ARCHIVE: 'autonomi' })).toThrow(/MAINNET_APPROVED/);
    expect(() => autonomiFromEnv({ CONSTELLATE_ARCHIVE: 'autonomi', CONSTELLATE_MAINNET_APPROVED: 'yes' })).toThrow(/POINTER/);
  });

  it('prices before paying, stops at the daily cap, and keeps named pointers behind one paid pointer', async () => {
    const chunks = new Map<string, string>(); let pointer: string | null = null; const paid: string[] = [];
    const antd = await serve((m, p, b) => {
      if (m === 'POST' && p === '/v1/data/cost') return [200, { cost: String(Buffer.from(b.data, 'base64').length * 10), file_size: 0, chunk_count: 1 }];
      if (m === 'POST' && p === '/v1/data/public') { const a = createHmac('sha256', 'k').update(b.data).digest('hex'); chunks.set(a, b.data); paid.push('data'); return [200, { address: a, chunks_stored: 1 }]; }
      const g = p.match(/^\/v1\/data\/public\/([0-9a-f]+)$/); if (m === 'GET' && g) return chunks.has(g[1]) ? [200, { data: chunks.get(g[1]) }] : [404, { error: 'not found' }];
      if (m === 'POST' && p === '/v1/pointers/update') { pointer = b.target; paid.push('pointer'); return [200, { address: b.owner, state_id: 's', counter: '1' }]; }
      if (m === 'GET' && p === '/v1/pointers/ptr1/resolve') return pointer ? [200, { kind: 'chunk', target: pointer }] : [404, { error: 'not found' }];
      return [404, { error: 'no route' }];
    });
    const a = new AutonomiArchive({ url: antd, indexPointer: 'ptr1', dailyCapAtto: '5000', flushEveryMs: 60_000 });
    const addr = await a.put(new TextEncoder().encode('hello autonomi'));
    expect(new TextDecoder().decode((await a.get(addr))!)).toBe('hello autonomi');
    await a.setPointer('constellate/cluster/abc', addr);
    expect(paid).toEqual(['data']); // batched: no pointer write yet
    await a.flush();
    expect(paid).toEqual(['data', 'data', 'pointer']);
    // A fresh process finds it through the one pointer.
    expect(await new AutonomiArchive({ url: antd, indexPointer: 'ptr1', dailyCapAtto: '5000' }).getPointer('constellate/cluster/abc')).toBe(addr);
    // Past the cap: refused before anything is paid.
    await expect(a.put(new Uint8Array(1000))).rejects.toThrow(/budget/);
    expect(paid.filter((x) => x === 'data')).toHaveLength(2);
  });
});
