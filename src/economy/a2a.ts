import { Hub } from '../hub/hub.js';
import { PaymentRail, signMandate, SignedMandate, verifyMandate } from './rail.js';
import { SkillCard } from './skills.js';
import { Signer } from '../core/identity.js';

/**
 * Discovery and agent-to-agent payments.
 *
 * Discovery (A2A): x0x already serves an A2A Agent Card at
 * /.well-known/agent-card.json. `agentCard` extends that card with
 * Constellate's services (as A2A skills), its marketplace skills and the
 * local MCP endpoint, so any A2A agent can find them.
 *
 * Payments: AP2 v0.2 (checked Nov 2026) is pre-1.0, delegates checkout to UCP,
 * targets card rails first and ships no package; its x402 support is the
 * separate a2a-x402 v0.1 extension. For pay-per-call between agents we therefore
 * use x402 directly over A2A (a2a-x402 v0.1 message flow below), keeping our
 * signed mandate as the authorisation payload. Testnet only.
 */
export const A2A_X402_EXTENSION = 'https://github.com/google-a2a/a2a-x402/v0.1';

const SERVICES = [
  { id: 'constellate.failures', name: 'Failure ledger', description: 'Check whether an approach already failed, and under what conditions. Free.', tags: ['failures', 'debugging'] },
  { id: 'constellate.answers', name: 'Verified answer cache', description: 'Look up questions already solved, with proof. Free.', tags: ['answers'] },
  { id: 'constellate.skills', name: 'Skill marketplace', description: 'Find, trial and use signed skills with proof of past runs.', tags: ['skills'] },
  { id: 'constellate.review', name: 'Second opinion', description: 'Independent critique of a plan, code or claim, paid per review.', tags: ['review'] },
  { id: 'constellate.memory', name: 'Private memory', description: 'Encrypted scratchpad you own across sessions and platforms.', tags: ['memory'] },
];

/** Extend x0x's A2A Agent Card (or a minimal card when no daemon) with Constellate's services and skills. */
export function agentCard(hub: Hub, base: Record<string, unknown> = {}, opts: { mcpUrl?: string; url?: string } = {}) {
  const skills = hub.node.store.ofKind('skill').map((s) => {
    const b = s.rec.body as unknown as SkillCard;
    return { id: `constellate.skill.${s.rec.id.slice(0, 16)}`, name: b.name, description: b.description, tags: b.capabilities, ...(b.price ? { 'x-price-micro-usdc': b.price } : {}), 'x-constellate-record': s.rec.id };
  });
  const baseCaps = (base.capabilities as { extensions?: unknown[] } | undefined) ?? {};
  return {
    name: (base.name as string) ?? 'Constellate hub',
    description: (base.description as string) ?? 'Shared memory, skills and second opinions for agents on x0x.',
    url: opts.url ?? (base.url as string) ?? 'x0x://local',
    version: '0.1.0',
    ...base,
    capabilities: { ...baseCaps, extensions: [...(baseCaps.extensions ?? []), { uri: A2A_X402_EXTENSION, description: 'Paid skills and reviews settle with x402 (testnet).', required: false }] },
    skills: [...((base.skills as unknown[]) ?? []), ...SERVICES, ...skills],
    'x-constellate': { mcp: opts.mcpUrl ?? 'stdio: npx -y constellate-mcp mcp', agent_id: hub.node.agentId, vocabulary: 'https://constellate.network/ns/v1' },
  };
}

// ── a2a-x402 v0.1 message flow (metadata keys under x402.payment.*) ──
export type X402Status = 'payment-required' | 'payment-submitted' | 'payment-rejected' | 'payment-verified' | 'payment-completed' | 'payment-failed';
export interface A2AMessage { taskId: string; metadata: Record<string, unknown>; parts?: { kind: 'text'; text: string }[] }

export function requirePayment(taskId: string, network: string, payTo: string, amount: number, resource: string, description: string): A2AMessage {
  return { taskId, metadata: { 'x402.payment.status': 'payment-required', 'x402.payment.required': { x402Version: 1, accepts: [{ scheme: 'exact', network, maxAmountRequired: String(amount), resource, description, payTo, asset: 'USDC-testnet', maxTimeoutSeconds: 600 }] } } };
}

export async function submitPayment(req: A2AMessage, signer: Signer, maxAmount: number): Promise<A2AMessage> {
  const accepts = (req.metadata['x402.payment.required'] as { accepts: { maxAmountRequired: string; payTo: string; resource: string; network: string }[] }).accepts;
  const a = accepts.find((x) => Number(x.maxAmountRequired) <= maxAmount);
  if (!a) return { taskId: req.taskId, metadata: { 'x402.payment.status': 'payment-rejected' } };
  const m = await signMandate(signer, { payee: a.payTo, amount: Number(a.maxAmountRequired), purpose: `a2a ${a.resource}` });
  return { taskId: req.taskId, metadata: { 'x402.payment.status': 'payment-submitted', 'x402.payment.payload': { x402Version: 1, scheme: 'exact', network: a.network, payload: m } } };
}

/** Merchant side: verify, settle, and answer payment-completed with receipts (or payment-failed). */
export async function settlePayment(rail: PaymentRail, req: A2AMessage, sub: A2AMessage): Promise<A2AMessage> {
  const need = (req.metadata['x402.payment.required'] as { accepts: { maxAmountRequired: string; payTo: string }[] }).accepts[0];
  const p = (sub.metadata['x402.payment.payload'] as { payload: SignedMandate } | undefined)?.payload;
  const err = sub.taskId !== req.taskId ? 'task mismatch' : !p ? 'no payload' : p.mandate.payee !== need.payTo ? 'wrong payee' : p.mandate.amount < Number(need.maxAmountRequired) ? 'underpaid' : verifyMandate(p);
  if (err) return { taskId: req.taskId, metadata: { 'x402.payment.status': 'payment-failed', 'x402.payment.error': err } };
  try {
    const s = await rail.settle(p!);
    return { taskId: req.taskId, metadata: { 'x402.payment.status': 'payment-completed', 'x402.payment.receipts': [{ success: true, transaction: s.tx, network: s.network, payer: p!.mandate.payer }] } };
  } catch (e) {
    return { taskId: req.taskId, metadata: { 'x402.payment.status': 'payment-failed', 'x402.payment.error': (e as Error).message } };
  }
}
