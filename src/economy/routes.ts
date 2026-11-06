import { HttpReply, WebServer } from '../web/server.js';
import { Economy } from './economy.js';
import { verifyAndSettle } from './x402.js';
import { lineage } from './lineage.js';

/**
 * Human payments over x402: sponsoring a problem. The hub's agent receives the
 * payment and becomes a sponsor that pays contributors per verified checkpoint.
 */
export function registerEconomyRoutes(web: WebServer, economy: Economy) {
  web.route('POST', /^\/api\/problems\/([0-9a-f]{64})\/sponsor$/, async (req, m, url) => {
    const amount = Math.floor(Number(url.searchParams.get('amount') ?? 1_000_000));
    const perCheckpoint = Math.floor(Number(url.searchParams.get('per_checkpoint') ?? amount / 8));
    if (!web.hub.problems.get(m[1])) throw Object.assign(new Error('unknown problem'), { status: 404 });
    const r = await verifyAndSettle(economy.rail, req.headers['x-payment'] as string | undefined, {
      scheme: 'exact', asset: 'USDC-testnet', maxTimeoutSeconds: 600, network: economy.rail.network, maxAmountRequired: String(amount), resource: url.pathname, description: 'Sponsor this problem: contributors are paid per verified checkpoint', payTo: economy.me,
    });
    if (!r.ok) return new HttpReply(r.status, r.body);
    const receipt = await economy.hub.node.submit({ kind: 'receipt', context: { task: 'x402 sponsorship received', domain: ['payments'], environment: r.settlement.network }, body: { type: 'x402', payer: r.mandate.mandate.payer, payee: economy.me, amount, tx: r.settlement.tx, rail: r.settlement.rail, network: r.settlement.network, mandate: r.mandate }, refs: [m[1]] }, { publish: true });
    await economy.sponsor(m[1], perCheckpoint);
    return new HttpReply(200, { sponsored: m[1], amount, per_checkpoint: perCheckpoint, receipt: receipt.record.id }, { 'X-PAYMENT-RESPONSE': r.responseHeader });
  });

  web.route('GET', /^\/api\/lineage\/([0-9a-f]{64})$/, (_r, m) => ({ record: m[1], contributors: lineage(web.hub.node.store, m[1]) }));

  web.route('GET', /^\/api\/earnings\/([0-9a-f]{64})$/, (_r, m) => {
    const rows = economy.receipts({ payee: m[1] }).map(({ s, b }) => ({ receipt: s.rec.id, type: b.type, amount: b.amount, from: b.payer, for: s.rec.refs[0], tx: b.tx, network: b.network }));
    return { agent: m[1], total: rows.reduce((n, r) => n + r.amount, 0), receipts: rows };
  });
}
