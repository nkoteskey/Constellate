import { createHmac, timingSafeEqual } from 'node:crypto';
import { CreditLedger } from './credits.js';
import { confirmedReceipt, isAddress, normalize, recoverSigner, transfers } from './evm.js';

/**
 * Funding and paying out real money. OFF unless the owner turns it on:
 *   CONSTELLATE_PAYMENTS=test   Stripe test keys and USDC on Base Sepolia (no real money)
 *   CONSTELLATE_PAYMENTS=live   real money, and only with CONSTELLATE_MAINNET_APPROVED=yes as well
 * Secrets live in the encrypted key vault (`constellate keys set stripe`,
 * `constellate keys set stripe-webhook`), never in records, the browser or git.
 */
export const NETWORKS = {
  test: { name: 'Base Sepolia', chainId: 84532, rpc: 'https://sepolia.base.org', usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', explorer: 'https://sepolia.basescan.org' },
  live: { name: 'Base', chainId: 8453, rpc: 'https://mainnet.base.org', usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', explorer: 'https://basescan.org' },
} as const;

export interface FundingConfig {
  mode: 'test' | 'live';
  stripe: { secret: string; webhookSecret: string } | null;
  usdc: { depositAddress: string; rpc: string; token: string; chainId: number; network: string; explorer: string; minConfirmations: number } | null;
  minPayout: number;
}

/** Read the configuration. Null means payments are off (the default). */
export function fundingConfig(env: NodeJS.ProcessEnv, vault: { get(n: string): string | undefined }): FundingConfig | null {
  const mode = env.CONSTELLATE_PAYMENTS;
  if (mode !== 'test' && mode !== 'live') return null;
  if (mode === 'live' && env.CONSTELLATE_MAINNET_APPROVED !== 'yes') throw new Error('live payments need CONSTELLATE_MAINNET_APPROVED=yes as well: real money moves');
  const secret = vault.get('stripe') ?? '';
  if (secret && mode === 'live' !== secret.startsWith('sk_live_')) throw new Error(`Stripe key doesn't match CONSTELLATE_PAYMENTS=${mode} (use sk_test_ for test, sk_live_ for live)`);
  const net = NETWORKS[mode];
  const deposit = env.CONSTELLATE_USDC_DEPOSIT_ADDRESS ?? '';
  if (deposit && !isAddress(deposit)) throw new Error('CONSTELLATE_USDC_DEPOSIT_ADDRESS must be an Ethereum address (your MetaMask account)');
  return {
    mode,
    stripe: secret && vault.get('stripe-webhook') ? { secret, webhookSecret: vault.get('stripe-webhook')! } : null,
    usdc: deposit ? { depositAddress: deposit, rpc: env.CONSTELLATE_BASE_RPC ?? net.rpc, token: net.usdc, chainId: net.chainId, network: net.name, explorer: net.explorer, minConfirmations: Number(env.CONSTELLATE_MIN_CONFIRMATIONS ?? (mode === 'live' ? 5 : 1)) } : null,
    minPayout: Number(env.CONSTELLATE_MIN_PAYOUT_MICRO ?? 1_000_000),
  };
}

// ── Stripe: card top-ups, credited when Stripe's signed webhook says the payment succeeded ──

export async function stripeCheckout(cfg: NonNullable<FundingConfig['stripe']>, o: { account: string; amountCents: number; successUrl: string; cancelUrl: string }) {
  if (!/^[0-9a-f]{64}$/.test(o.account)) throw new Error('bad account');
  if (!Number.isInteger(o.amountCents) || o.amountCents < 100 || o.amountCents > 100_000) throw new Error('top-ups are between $1 and $1,000');
  const form = new URLSearchParams({
    mode: 'payment',
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][unit_amount]': String(o.amountCents),
    'line_items[0][price_data][product_data][name]': 'Constellate credit',
    'line_items[0][quantity]': '1',
    success_url: o.successUrl,
    cancel_url: o.cancelUrl,
    client_reference_id: o.account,
    'metadata[account]': o.account,
  });
  const r = await fetch('https://api.stripe.com/v1/checkout/sessions', { method: 'POST', headers: { authorization: `Basic ${Buffer.from(`${cfg.secret}:`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' }, body: form });
  const j = (await r.json()) as { url?: string; id?: string; error?: { message: string } };
  if (!r.ok || !j.url) throw new Error(`Stripe: ${j.error?.message ?? r.statusText}`);
  return { url: j.url, id: j.id };
}

/** Stripe-Signature: t=<unix>,v1=<hex>[,v1=…]; HMAC-SHA256 of `${t}.${rawBody}`; 5-minute tolerance. */
export function verifyStripeSignature(header: string, rawBody: string, secret: string, nowSecs = Math.floor(Date.now() / 1000), toleranceSecs = 300): boolean {
  const parts = header.split(',').map((p) => p.split('=') as [string, string]);
  const t = Number(parts.find(([k]) => k === 't')?.[1]);
  const sigs = parts.filter(([k]) => k === 'v1').map(([, v]) => v);
  if (!Number.isFinite(t) || !sigs.length || Math.abs(nowSecs - t) > toleranceSecs) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest();
  return sigs.some((s) => { const b = Buffer.from(s, 'hex'); return b.length === expected.length && timingSafeEqual(b, expected); });
}

/** Apply a verified Stripe event. Returns what was credited, if anything. */
export function applyStripeEvent(ledger: CreditLedger, event: { type: string; data: { object: Record<string, any> } }) {
  if (event.type !== 'checkout.session.completed' && event.type !== 'checkout.session.async_payment_succeeded') return null;
  const s = event.data.object;
  if (s.payment_status !== 'paid' || s.currency !== 'usd') return null;
  const account = String(s.client_reference_id ?? s.metadata?.account ?? '');
  const micro = Number(s.amount_total) * 10_000; // cents → micro-dollars
  const fresh = ledger.deposit(account, micro, `stripe:${s.id}`, 'stripe', `card top-up ${s.id}`);
  return fresh ? { account, amount: micro } : null;
}

// ── USDC from MetaMask: the person sends USDC to the owner's address, then proves the transfer is theirs ──

export const claimMessage = (account: string, tx: string) => `Constellate: credit ${account} with ${normalize(tx)}`;

export async function claimUsdc(ledger: CreditLedger, cfg: NonNullable<FundingConfig['usdc']>, c: { account: string; tx: string; signature: string }) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(c.tx)) throw new Error('bad transaction hash');
  const ref = `usdc:${cfg.chainId}:${normalize(c.tx)}`;
  if (ledger.applied(ref)) throw new Error('that transfer was already credited');
  const receipt = await confirmedReceipt(cfg.rpc, c.tx, cfg.minConfirmations);
  if (!receipt) return { pending: true as const };
  const ins = transfers(receipt, cfg.token).filter((t) => normalize(t.to) === normalize(cfg.depositAddress));
  if (!ins.length) throw new Error(`that transaction sent no USDC to ${cfg.depositAddress} on ${cfg.network}`);
  const sender = normalize(ins[0].from);
  if (normalize(recoverSigner(claimMessage(c.account, c.tx), c.signature)) !== sender) throw new Error('the signature must come from the wallet that sent the USDC');
  const amount = Number(ins.reduce((n, t) => n + t.amount, 0n)); // USDC has 6 decimals: already micro-dollars
  ledger.deposit(c.account, amount, ref, 'usdc', `USDC from ${sender}`);
  return { pending: false as const, amount, from: sender };
}

/** The owner paid a contributor from MetaMask: confirm it on-chain, then debit their credit. */
export async function confirmPayout(ledger: CreditLedger, cfg: NonNullable<FundingConfig['usdc']>, p: { account: string; to: string; tx: string; amount: number }) {
  const ref = `payout:${cfg.chainId}:${normalize(p.tx)}`;
  if (ledger.applied(ref)) throw new Error('that payout was already recorded');
  const receipt = await confirmedReceipt(cfg.rpc, p.tx, cfg.minConfirmations);
  if (!receipt) return { pending: true as const };
  const paid = transfers(receipt, cfg.token).filter((t) => normalize(t.to) === normalize(p.to)).reduce((n, t) => n + t.amount, 0n);
  if (paid < BigInt(p.amount)) throw new Error(`that transaction paid ${paid} to ${p.to}, less than ${p.amount}`);
  ledger.payout(p.account, p.amount, ref, `USDC to ${p.to}`);
  return { pending: false as const };
}
