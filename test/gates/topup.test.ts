import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { Hub } from '../../src/hub/hub.js';
import { LocalSigner } from '../../src/core/identity.js';
import { TopUp, quoteProblem, USDC_BASE, ANT_ARBITRUM, ETH_NATIVE, BASE, ARBITRUM } from '../../src/economy/topup.js';
import { WebServer } from '../../src/web/server.js';
import { registerAppRoutes } from '../../src/web/app.js';

/**
 * Top up storage (src/economy/topup.ts, docs/STORAGE.md): the person's USDC on Base becomes ANT (and gas) in this
 * computer's Autonomi wallet, signed in their own wallet. Every quote is checked before it reaches the wallet:
 * right chains, tokens, amount, sender, destination, slippage and contract. Approvals are exact. Test mode shows
 * real quotes and sends nothing.
 */
const PERSON = '0x' + '11'.repeat(20), STORE = '0x' + '22'.repeat(20), ROUTER = '0x' + '33'.repeat(20);

/** A LI.FI-shaped quote for exactly what was asked, unless `bend` changes it. */
function quoteFor(p: URLSearchParams, bend: (q: any) => void = () => {}) {
  const q: any = {
    tool: 'relay',
    action: { fromChainId: Number(p.get('fromChain')), toChainId: Number(p.get('toChain')), fromToken: { address: p.get('fromToken') }, toToken: { address: p.get('toToken') }, fromAddress: p.get('fromAddress'), toAddress: p.get('toAddress'), fromAmount: p.get('fromAmount'), slippage: Number(p.get('slippage')) },
    estimate: { toAmount: p.get('toToken') === ETH_NATIVE ? '150000000000000' : '40000000000000000000', toAmountMin: p.get('toToken') === ETH_NATIVE ? '145000000000000' : '38800000000000000000', approvalAddress: ROUTER, executionDuration: 30, feeCosts: [{ amountUSD: '0.05' }], gasCosts: [{ amountUSD: '0.02' }] },
    transactionRequest: { to: ROUTER, data: '0xabcdef', value: '0x0', chainId: BASE, gasLimit: '0x30d40' },
  };
  bend(q);
  return q;
}
function fakeLifi(bend?: (q: any) => void) {
  const calls: string[] = [];
  const f = (async (url: string) => {
    calls.push(url);
    const u = new URL(url);
    if (u.pathname.endsWith('/quote')) return new Response(JSON.stringify(quoteFor(u.searchParams, bend)), { status: 200 });
    if (u.pathname.endsWith('/status')) return new Response(JSON.stringify({ status: 'DONE', substatus: 'COMPLETED', receiving: { amount: '40000000000000000000' } }), { status: 200 });
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;
  return { f, calls };
}
const wallet = (eth_wei: string | null = '0') => async () => ({ address: STORE, eth_wei, ant_atto: '0' });

describe('top up storage', () => {
  it('a quote is shown only when it does exactly what was asked', () => {
    const p = new URLSearchParams({ fromChain: String(BASE), toChain: String(ARBITRUM), fromToken: USDC_BASE, toToken: ANT_ARBITRUM, fromAddress: PERSON, toAddress: STORE, fromAmount: '5000000', slippage: '0.03' });
    const want = { from: PERSON, to: STORE, toToken: ANT_ARBITRUM, fromAmount: 5_000_000n };
    expect(quoteProblem(quoteFor(p), want)).toBeNull();
    expect(quoteProblem(quoteFor(p, (q) => { q.action.toAddress = '0x' + '99'.repeat(20); }), want)).toMatch(/somewhere other than this computer/);
    expect(quoteProblem(quoteFor(p, (q) => { q.action.toToken.address = ETH_NATIVE; }), want)).toMatch(/wrong token/);
    expect(quoteProblem(quoteFor(p, (q) => { q.action.slippage = 0.2; }), want)).toMatch(/slippage/);
    expect(quoteProblem(quoteFor(p, (q) => { q.transactionRequest.to = '0x' + '44'.repeat(20); }), want)).toMatch(/somewhere other than the contract/);
    expect(quoteProblem(quoteFor(p, (q) => { q.transactionRequest.chainId = 1; }), want)).toMatch(/isn’t on Base/);
    expect(quoteProblem(quoteFor(p, (q) => { q.action.fromAmount = '50000000'; }), want)).toMatch(/different amount/);
    expect(quoteProblem(quoteFor(p, (q) => { q.action.fromAddress = STORE; }), want)).toMatch(/different wallet/);
  });

  it('quotes ANT for storage, adds gas when the wallet is low, approves exact amounts, and sends nothing in test mode', async () => {
    const li = fakeLifi();
    const t = new TopUp({ fetch: li.f, storageWallet: wallet('0') });
    const q = await t.quote(PERSON, 5);
    expect(q.legs.map((l) => [l.what, l.from_usd])).toEqual([['ANT for storage', 4.5], ['ETH for gas', 0.5]]);
    expect(q.approve).toEqual([{ token: USDC_BASE, spender: ROUTER.toLowerCase(), amount: '5000000' }]); // exact, summed per contract
    expect(q.can_send).toBe(false);
    expect(q.note).toMatch(/Test mode/);
    expect(li.calls[0]).toMatch(/toAddress=0x2222/);
    // Enough gas already: one leg.
    expect((await new TopUp({ fetch: fakeLifi().f, storageWallet: wallet('1000000000000000') }).quote(PERSON, 5)).legs).toHaveLength(1);
    // Limits and missing pieces.
    await expect(t.quote(PERSON, 500)).rejects.toThrow(/between \$1 and \$50/);
    await expect(t.quote('nope', 5)).rejects.toThrow(/connect a wallet/);
    await expect(new TopUp({ fetch: li.f, storageWallet: async () => ({ address: null, eth_wei: null, ant_atto: null }) }).quote(PERSON, 5)).rejects.toThrow(/no Autonomi wallet/);
    await expect(new TopUp({ fetch: fakeLifi((q) => { q.action.toAddress = PERSON; }).f, storageWallet: wallet() }).quote(PERSON, 5)).rejects.toThrow(/not shown/);
    process.env.CONSTELLATE_PAYMENTS = 'live';
    try { expect((await t.quote(PERSON, 5)).can_send).toBe(true); } finally { delete process.env.CONSTELLATE_PAYMENTS; }
    expect(await t.status('0x' + 'ab'.repeat(32))).toMatchObject({ status: 'DONE' });
    await expect(t.status('0x12')).rejects.toThrow(/transaction hash/);
  });

  it('in the browser: connect, quote, approve the exact amount, send, follow it to Arbitrum', async () => {
    const hub = new Hub({ signer: LocalSigner.generate(), preview: false });
    hub.topup = new TopUp({ fetch: fakeLifi().f, storageWallet: wallet('0') });
    const web = new WebServer(hub); registerAppRoutes(web); await web.listen(0);
    const { chromium } = createRequire(import.meta.url)('playwright');
    const browser = await chromium.launch();
    process.env.CONSTELLATE_PAYMENTS = 'live';
    try {
      const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
      const errors: string[] = [];
      page.on('pageerror', (e: Error) => errors.push(String(e)));
      // A stand-in wallet that records what it was asked to sign.
      await page.addInitScript(({ person }) => {
        const sent: unknown[] = [];
        (window as any).__sent = sent;
        (window as any).ethereum = { request: async ({ method, params }: { method: string; params?: any[] }) => {
          if (method === 'eth_requestAccounts') return [person];
          if (method === 'wallet_switchEthereumChain') return null;
          if (method === 'eth_call') return '0x0';
          if (method === 'eth_sendTransaction') { sent.push(params![0]); return '0x' + String(sent.length).padStart(64, '0'); }
          if (method === 'eth_getTransactionReceipt') return { status: '0x1' };
          throw new Error(`unexpected ${method}`);
        } };
      }, { person: PERSON });
      await page.goto(`${web.url}/#/compute`);
      await page.evaluate("import('/js/topup.js').then((m) => m.topUpSheet())"); // a string, so the test runner leaves import() alone
      await page.click('#tu-form button.primary');
      await page.waitForSelector('#tu-go:not([disabled])');
      expect(await page.textContent('#tu-out')).toMatch(/ANT for storage: \$4\.50.*≈ 40\.00 ANT.*at least 38\.80.*ETH for gas: \$0\.50/s);
      await page.click('#tu-go');
      await page.waitForFunction(() => !document.querySelector('#tu-out'));
      const sent = await page.evaluate(() => (window as any).__sent) as { to: string; data: string }[];
      expect(sent[0]).toMatchObject({ to: USDC_BASE }); // the approval, first
      expect(sent[0].data).toBe(`0x095ea7b3${ROUTER.slice(2).padStart(64, '0')}${(5_000_000).toString(16).padStart(64, '0')}`); // exact amount
      expect(sent.slice(1).map((s) => s.to)).toEqual([ROUTER, ROUTER]); // then the two legs
      expect(errors).toEqual([]);
    } finally { delete process.env.CONSTELLATE_PAYMENTS; await browser.close(); await web.close(); }
  }, 60_000);
});
