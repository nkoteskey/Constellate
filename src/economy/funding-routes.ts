import type { IncomingMessage } from 'node:http';
import { WebServer, HttpReply } from '../web/server.js';
import { Hub } from '../hub/hub.js';
import { CreditLedger } from './credits.js';
import { FundingConfig, applyStripeEvent, claimUsdc, confirmPayout, stripeCheckout, verifyStripeSignature } from './funding.js';
import { AutonomiArchive } from '../store/autonomi.js';

const local = (req: IncomingMessage) => /^(127\.|::1$|::ffff:127\.)/.test(req.socket.remoteAddress ?? '');
const ownerOnly = () => new HttpReply(403, { error: 'only the machine running this hub can do that' });

/** The latest payout address an identity signed for itself (a `payout_address` record). */
export function payoutAddress(hub: Hub, account: string) {
  const r = hub.node.store.ofKind('payout_address').filter((s) => s.rec.agent_id === account || s.operatorId === account).sort((a, b) => b.rec.created.localeCompare(a.rec.created))[0];
  return r ? (r.rec.body as { address: string }).address : null;
}

/**
 * Money routes. Registered only when CONSTELLATE_PAYMENTS is test or live;
 * otherwise /api/funds/config answers { enabled: false } and nothing else exists.
 */
export function registerFundingRoutes(web: WebServer, hub: Hub, o: { ledger: CreditLedger | null; cfg: FundingConfig | null; autonomi?: AutonomiArchive | null; publicUrl?: string }) {
  const { ledger, cfg } = o;
  web.route('GET', /^\/api\/funds\/config$/, () => cfg && ledger ? {
    enabled: true, mode: cfg.mode, stripe: !!cfg.stripe, min_payout: cfg.minPayout,
    usdc: cfg.usdc ? { chain_id: cfg.usdc.chainId, network: cfg.usdc.network, token: cfg.usdc.token, deposit_address: cfg.usdc.depositAddress, explorer: cfg.usdc.explorer } : null,
  } : { enabled: false });
  if (!cfg || !ledger) return;

  web.route('GET', /^\/api\/funds\/account\/([0-9a-f]{64})$/, (_r, m) => ({ balance: ledger.balance(m[1]), history: ledger.history(m[1]).slice(-50), payout_address: payoutAddress(hub, m[1]) }));

  if (cfg.stripe) {
    const stripe = cfg.stripe;
    web.route('POST', /^\/api\/funds\/stripe\/checkout$/, async (req, _m, _u, body) => {
      const j = (await body()) as { account?: string; amount_cents?: number };
      const base = o.publicUrl ?? `http://${req.headers.host ?? '127.0.0.1:4747'}`;
      try { return await stripeCheckout(stripe, { account: String(j.account), amountCents: Number(j.amount_cents), successUrl: `${base}/#/me?funded=1`, cancelUrl: `${base}/#/me` }); }
      catch (e) { return new HttpReply(400, { error: (e as Error).message }); }
    });
    // Stripe calls this; the raw body is needed for the signature, so it's read here, not parsed.
    web.route('POST', /^\/api\/funds\/stripe\/webhook$/, async (req) => {
      const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!verifyStripeSignature(String(req.headers['stripe-signature'] ?? ''), raw, stripe.webhookSecret)) return new HttpReply(400, { error: 'bad signature' });
      const credited = applyStripeEvent(ledger, JSON.parse(raw));
      return { received: true, credited };
    });
  }

  if (cfg.usdc) {
    const usdc = cfg.usdc;
    web.route('POST', /^\/api\/funds\/usdc\/claim$/, async (_r, _m, _u, body) => {
      const j = (await body()) as { account?: string; tx?: string; signature?: string };
      try { return await claimUsdc(ledger, usdc, { account: String(j.account), tx: String(j.tx), signature: String(j.signature) }); }
      catch (e) { return new HttpReply(400, { error: (e as Error).message }); }
    });
    web.route('GET', /^\/api\/funds\/owed$/, (req) => local(req) ? ledger.owed(cfg.minPayout).map((x) => ({ ...x, payout_address: payoutAddress(hub, x.account) })) : ownerOnly());
    web.route('POST', /^\/api\/funds\/payout$/, async (req, _m, _u, body) => {
      if (!local(req)) return ownerOnly();
      const j = (await body()) as { account: string; tx: string; amount: number };
      const to = payoutAddress(hub, j.account);
      if (!to) return new HttpReply(400, { error: 'no payout address for that account' });
      try { return await confirmPayout(ledger, usdc, { account: j.account, to, tx: j.tx, amount: Number(j.amount) }); }
      catch (e) { return new HttpReply(400, { error: (e as Error).message }); }
    });
  }

  if (o.autonomi) {
    const a = o.autonomi;
    web.route('GET', /^\/api\/funds\/autonomi$/, async (req) => (local(req) ? a.status().catch((e) => ({ error: (e as Error).message })) : ownerOnly()));
    web.route('POST', /^\/api\/funds\/autonomi\/approve$/, async (req) => (local(req) ? a.approve() : ownerOnly()));
  }
}
