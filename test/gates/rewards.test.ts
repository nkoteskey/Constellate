import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { Hub } from '../../src/hub/hub.js';
import { LocalSigner } from '../../src/core/identity.js';
import { signRecord } from '../../src/core/record.js';
import { LocalArchive } from '../../src/store/archive.js';
import { KeyVault } from '../../src/contributor/keyvault.js';
import { addressFromPublicKey } from '../../src/economy/evm.js';
import { Thanks } from '../../src/economy/thanks.js';
import { AgentWallet } from '../../src/economy/agent-wallet.js';
import { Facilitator, recoverAuthorizer, requirements, signAuthorization } from '../../src/economy/x402-base.js';
import { WebServer } from '../../src/web/server.js';
import { registerAppRoutes } from '../../src/web/app.js';

/**
 * Rewarding confirmed work (docs/REWARDS.md). Thank what worked: opt-in tips along the lineage when a fix worked
 * for this computer's agents, paid from the person's own wallet. Agents' spending: a small, capped wallet agents
 * pay from without a prompt each time. Nobody holds anyone else's money.
 */
const ctx = (env = 'node 22') => ({ task: 'a task', domain: ['ci'], environment: env });
const fac = () => {
  const calls: string[] = [];
  const f = (async (url: string) => { calls.push(new URL(url).pathname); return new Response(JSON.stringify(url.endsWith('/verify') ? { isValid: true } : { success: true, transaction: '0x' + 'ef'.repeat(32) }), { status: 200 }); }) as unknown as typeof fetch;
  return { f: new Facilitator('https://facilitator.example', f), calls };
};
const keyAndAddress = () => { const sk = secp256k1.utils.randomSecretKey(); return { sk, address: addressFromPublicKey(secp256k1.getPublicKey(sk, false)) }; };

describe('thank what worked', () => {
  it('splits 70/20/10 along the lineage, caps the month, never thanks yourself, and pays from your wallet with a receipt', async () => {
    const home = mkdtempSync(join(tmpdir(), 'thanks-'));
    const me = new Hub({ signer: LocalSigner.generate(), preview: false });
    const thanks = new Thanks(me, home);
    const reporter = LocalSigner.generate(), author = LocalSigner.generate(), earlier = LocalSigner.generate();
    const failure = await signRecord({ kind: 'failure', context: ctx(), body: { approach: 'npm install', outcome: 'error', error_summary: 'EACCES', confidence: 0.6 } }, reporter);
    const base = await signRecord({ kind: 'answer', context: ctx(), body: { question: 'permissions?', answer: 'use a prefix', proof: { type: 'test', detail: 'ok' } } }, earlier);
    const fix = await signRecord({ kind: 'answer', context: ctx(), body: { question: 'EACCES on npm install?', answer: 'set npm prefix to ~/.npm-global', proof: { type: 'test', detail: 'ok' } }, refs: [failure.id, base.id] }, author);
    for (const r of [failure, base, fix]) me.node.ingest(r);

    expect(thanks.owed()).toEqual([]); // off by default: nothing accrues
    await me.tried(fix.id, { worked: true, error_before: 'EACCES', environment: 'node 22' }, { publish: true }); // before it was on: not counted
    thanks.set({ on: true });
    await new Promise((r) => setTimeout(r, 5));
    await me.tried(fix.id, { worked: true, error_before: 'EACCES', environment: 'node 22' }, { publish: true });
    await me.tried(fix.id, { worked: false, error_before: 'EACCES', error_after: 'still EACCES', environment: 'node 20' }, { publish: true }); // didn't work: nothing
    const owed = Object.fromEntries(thanks.owed().map((o) => [o.operator, o.owed_micro]));
    expect(owed).toEqual({ [author.agentId]: 14_000, [reporter.agentId]: 4_000, [earlier.agentId]: 2_000 }); // $0.02 split 70/20/10

    // The monthly cap holds; nothing is due until there's a payout address and enough owed.
    thanks.set({ per_fix_micro: 1_000_000, monthly_cap_micro: 2_500_000, pay_at_micro: 1_000_000 });
    for (let i = 0; i < 3; i++) await me.tried(fix.id, { worked: true, error_before: 'EACCES', environment: 'node 22' }, { publish: true });
    const total = thanks.owed().reduce((n, o) => n + o.owed_micro, 0);
    expect(total).toBe(2_500_000); // capped for the month
    expect(thanks.owed().every((o) => !o.due)).toBe(true); // no payout addresses yet
    const payout = keyAndAddress().address;
    me.node.ingest(await signRecord({ kind: 'payout_address', context: ctx(), body: { address: payout, chain: 'base' } }, author));
    const due = thanks.owed().find((o) => o.operator === author.agentId)!;
    expect(due).toMatchObject({ due: true, payout_address: payout });

    // Paid from the person's own wallet: one exact authorization, settled by their facilitator, then a receipt.
    const { f, calls } = fac();
    me.market.facilitator = f;
    const wallet = keyAndAddress();
    const q = thanks.quote(author.agentId, wallet.address);
    expect(q).toMatchObject({ amount_micro: due.owed_micro, to: payout, typed_data: { message: { to: payout, value: String(due.owed_micro) } } });
    const paid = await thanks.pay(q.id, signAuthorization(q.typed_data.message, wallet.sk));
    expect(calls).toEqual(['/verify', '/settle']);
    expect(me.node.store.get(paid.receipt)!.rec.body).toMatchObject({ type: 'thanks', payee: author.agentId, amount: due.owed_micro, network: 'base' });
    expect(thanks.owed().find((o) => o.operator === author.agentId)!.owed_micro).toBe(0);
    expect(thanks.received(author.agentId)).toEqual({ micro: due.owed_micro, from: 1 }); // on the author's record
  });
});

describe('agents’ spending wallet', () => {
  it('signs exact payments from its own key, within a daily cap, and Pause stops everything', () => {
    const home = mkdtempSync(join(tmpdir(), 'agent-wallet-'));
    const w = new AgentWallet({ home, vault: new KeyVault(join(home, 'keys.json')) });
    const addr = w.address();
    expect(new AgentWallet({ home, vault: new KeyVault(join(home, 'keys.json')) }).address()).toBe(addr); // one key, kept
    const req = requirements({ amount: 400_000n, payTo: '0x' + '22'.repeat(20), resource: 'skill:x', description: 'a review' });
    const now = new Date('2026-11-23T10:00:00Z');
    const p = w.pay(req, 'a second opinion', now);
    expect(recoverAuthorizer(p.payload.authorization, p.payload.signature).toLowerCase()).toBe(addr.toLowerCase());
    w.pay(req, 'another', now);
    expect(() => w.pay(req, 'one too many', now)).toThrow(/today’s cap of \$1\.00/); // $0.80 spent; $0.40 more would pass $1
    expect(w.spentToday(now)).toBe(800_000);
    expect(() => w.pay(req, 'tomorrow', new Date('2026-11-24T10:00:00Z'))).not.toThrow(); // a new day
    w.set({ paused: true });
    expect(() => w.pay(req, 'paused', new Date('2026-11-25T10:00:00Z'))).toThrow(/paused/);
    expect(() => w.sign({ ...p.payload.authorization, from: '0x' + '99'.repeat(20) }, 'not mine')).toThrow(/paused|isn’t from the agent wallet/);
    w.set({ paused: false });
    expect(() => w.sign({ ...p.payload.authorization, from: '0x' + '99'.repeat(20) }, 'not mine', new Date('2026-11-26T10:00:00Z'))).toThrow(/isn’t from the agent wallet/);
  });

  it('an agent stores through another computer with no wallet prompt, paid from the agent wallet', async () => {
    const home = mkdtempSync(join(tmpdir(), 'agent-store-'));
    const shared = new LocalArchive(join(home, 'autonomi'));
    const seller = new Hub({ signer: LocalSigner.generate(), preview: false, archive: shared });
    const buyer = new Hub({ signer: LocalSigner.generate(), preview: false, archive: shared });
    buyer.agentWallet = new AgentWallet({ home, vault: new KeyVault(join(home, 'keys.json')) });
    seller.market.facilitator = fac().f;
    const hubs = new Map([[seller.node.agentId, seller], [buyer.node.agentId, buyer]]);
    for (const [id, h] of hubs) h.market.transport = { send: async (to, msg) => { setTimeout(() => hubs.get(to)!.market.handle(id, Buffer.from(JSON.stringify(msg)).toString('base64')), 1); } };
    buyer.node.ingest(seller.node.store.get(await seller.market.offer({ price_micro_usdc_per_mb: 50_000, min_micro_usdc: 10_000, max_bytes: 65536, pay_to: '0x' + '22'.repeat(20), network: 'base' }))!.rec);
    await buyer.node.submit({ kind: 'failure', context: ctx(), body: { approach: 'x', outcome: 'error', error_summary: 'y', confidence: 0.5 } }, { publish: true });
    const r = await buyer.selfStore.marketViaAgent(seller.node.agentId);
    expect(r).toMatchObject({ stored: 1, archive: 'autonomi' });
    expect(buyer.agentWallet.spends()).toMatchObject([{ amount_micro: 10_000, pay_to: '0x' + '22'.repeat(20) }]);
  });

  it('the app shows both, only on this computer, and saves the cap and Pause', async () => {
    const home = mkdtempSync(join(tmpdir(), 'rewards-web-'));
    const hub = new Hub({ signer: LocalSigner.generate(), preview: false });
    hub.agentWallet = new AgentWallet({ home, vault: new KeyVault(join(home, 'keys.json')), fetchBalance: async () => 3_500_000n });
    const web = new WebServer(hub); registerAppRoutes(web); await web.listen(0);
    try {
      expect(await (await fetch(`${web.url}/api/agent-wallet`)).json()).toMatchObject({ balance_micro: '3500000', daily_cap_micro: 1_000_000, paused: false, spent_today_micro: 0 });
      await fetch(`${web.url}/api/agent-wallet`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ daily_cap_micro: 2_000_000, paused: true }) });
      expect(hub.agentWallet.settings()).toEqual({ daily_cap_micro: 2_000_000, paused: true });
      expect((await (await fetch(`${web.url}/api/thanks`)).json()).settings).toMatchObject({ on: false, per_fix_micro: 20_000, monthly_cap_micro: 2_000_000, pay_at_micro: 1_000_000 });
    } finally { await web.close(); }
  });
});
