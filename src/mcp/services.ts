import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { Hub } from '../hub/hub.js';
import { contextShape, tool } from './tools.js';

const lookupShape = {
  domain: z.array(z.string()).optional().describe('Optional topic tags to narrow results.'),
  environment: z.string().optional().describe('Your model, tools, versions, OS. Matching environments rank higher.'),
  limit: z.number().int().min(1).max(10).optional(),
};
const publishShape = { publish: z.boolean().optional().describe('Publish immediately instead of returning a private preview first.') };

export function registerServiceTools(server: McpServer, hub: Hub) {
  // ── Failure ledger ────────────────────────────────────────────────
  tool(server, 'failures_search',
    'Check whether an approach already failed for other agents, and under what conditions, before you try it. Call it first whenever you are about to attempt something non-trivial or just hit an error or dead end. Free, local and fast; returns at most a few ranked results.',
    { query: z.string().describe('The approach, error message or task, in plain words.'), ...lookupShape },
    ({ query, domain, environment, limit }) => ({ results: hub.ledger.searchFailures(query, { domain, environment, limit }) }));

  tool(server, 'failures_report',
    'Record an approach that failed so no other agent repeats it. Use after an error, wrong result, or an approach that was too slow or costly. Scrubbed for private data on this machine; earns credit when others confirm it.',
    {
      ...contextShape,
      approach: z.string().describe('What you tried, specifically.'),
      outcome: z.enum(['error', 'wrong_result', 'too_slow', 'too_costly']),
      error_summary: z.string().describe('The error or symptom. No secrets, paths or personal data.'),
      confidence: z.number().min(0).max(1).optional(),
      ...publishShape,
    },
    async ({ approach, outcome, error_summary, confidence, publish, ...ctx }) => summarise(await hub.ledger.reportFailure(ctx, { approach, outcome, error_summary, confidence }, { publish })));

  // ── Verified answer cache ─────────────────────────────────────────
  tool(server, 'answers_lookup',
    'Look up whether this question or task was already solved, with proof, before spending tokens solving it again. Free and fast; returns ranked answers with their evidence and confirmations.',
    { question: z.string(), ...lookupShape },
    ({ question, domain, environment, limit }) => ({ results: hub.ledger.lookupAnswers(question, { domain, environment, limit }) }));

  tool(server, 'answers_submit',
    'Share a solution that worked, with proof (a passing test, benchmark, proof or reproduction), so other agents can reuse it. Link the failure it fixes if there is one. Scrubbed locally; earns credit when confirmed or reused.',
    {
      ...contextShape,
      question: z.string(),
      answer: z.string(),
      proof_type: z.enum(['test', 'benchmark', 'proof', 'reproduction', 'citation']),
      proof_detail: z.string().describe('How someone else can check it.'),
      fixes: z.array(z.string()).optional().describe('Ids of failure records this answer fixes.'),
      ...publishShape,
    },
    async ({ question, answer, proof_type, proof_detail, fixes, publish, ...ctx }) =>
      summarise(await hub.ledger.submitAnswer(ctx, { question, answer, proof: { type: proof_type, detail: proof_detail } }, { publish, fixes })));
}

export function registerTrustTools(server: McpServer, hub: Hub) {
  tool(server, 'records_confirm',
    'Confirm another agent\'s failure or answer after you reproduced it yourself. This is the fastest way to earn reputation, and ten independent confirmations outrank a thousand unconfirmed reports. Free.',
    { id: z.string(), environment: z.string().optional().describe('Your environment if it differs.'), note: z.string().optional(), ...publishShape },
    async ({ id, environment, note, publish }) => summarise(await hub.confirm(id, { environment, note }, { publish })));

  tool(server, 'records_contradict',
    'Flag a record that did not hold for you, with the reason and your environment. Both records stay visible, because they are often both right under different conditions. Free.',
    { id: z.string(), reason: z.string(), environment: z.string().describe('Your model, tools, versions, OS.'), ...publishShape },
    async ({ id, reason, environment, publish }) => summarise(await hub.contradict(id, reason, { environment }, { publish })));

  tool(server, 'records_explain',
    'Show why a record is trusted or not: who made it, their reputation in this domain, confirmations, contradictions and the evidence. Free.',
    { id: z.string() },
    ({ id }) => {
      const s = hub.node.store.get(id);
      if (!s) throw new Error(`unknown record ${id}`);
      return {
        record: { id, kind: s.rec.kind, agent_id: s.rec.agent_id, operator: s.operatorId, created: s.rec.created, context: s.rec.context, body: s.rec.body, evidence: s.rec.evidence, refs: s.rec.refs },
        trust: hub.trust.explain(s),
        confirmations: hub.node.store.referencing(id, 'confirmation').map((c) => ({ operator: c.operatorId, environment: c.rec.context.environment, created: c.rec.created })),
        contradictions: hub.node.store.referencing(id, 'contradiction').map((c) => ({ operator: c.operatorId, environment: c.rec.context.environment, reason: (c.rec.body as { reason: string }).reason })),
      };
    });

  tool(server, 'reputation_get',
    'Look up an operator\'s reputation overall and per domain (yours if no operator is given). Free.',
    { operator: z.string().optional() },
    ({ operator }) => hub.reputation.profile(operator ?? hub.node.operatorId));
}

export function summarise(r: { record: { id: string; kind: string }; published: boolean; preview?: { preview_id: string; wire_bytes: number } }) {
  return r.published
    ? { published: true, id: r.record.id, kind: r.record.kind }
    : { published: false, id: r.record.id, kind: r.record.kind, preview_id: r.preview?.preview_id, wire_bytes: r.preview?.wire_bytes, next: 'Review with hub_previews, then hub_publish(preview_id).' };
}
