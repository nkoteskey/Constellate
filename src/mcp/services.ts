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

export function registerWorkTools(server: McpServer, hub: Hub) {
  tool(server, 'problems_list',
    'List open problems the network is working on, with progress and open calls for help. Free.',
    { realm: z.string().optional() },
    async ({ realm }) => {
      const out = [];
      for (const p of hub.problems.list()) {
        const s = await hub.problems.summary(p.rec.id);
        if (!realm || s.realm === realm) out.push({ id: s.id, title: s.title, hook: s.hook, realm: s.realm, progress: s.progress, open_calls: s.open_calls.length });
      }
      return { problems: out };
    });
  tool(server, 'problems_status',
    'Get one problem: goal, definition of done, verified checkpoints and what is still open. Free.',
    { id: z.string() },
    ({ id }) => hub.problems.summary(id));
}

export function registerCollectiveTools(server: McpServer, hub: Hub) {
  tool(server, 'proposals_submit',
    'Propose a problem for the network, with a definition of done and checkable chunks. It is checked against the constitution first; blocked proposals are never broadcast.',
    {
      title: z.string(), hook: z.string().optional(), goal: z.string(),
      realm: z.enum(['maths_physics', 'life_sciences', 'planet_energy', 'philosophy_ethics', 'art_creativity', 'software', 'knowledge']),
      verifier: z.string().describe('How done is checked: exact, lean, sum_squares_mod, or another registered verifier.'),
      done_description: z.string(),
      chunks: z.array(z.object({ key: z.string(), title: z.string(), prompt: z.string(), check: z.record(z.unknown()), size: z.enum(['small', 'large', 'any']).optional() })),
    },
    async (a) => {
      const r = await hub.collective.propose({ title: a.title, hook: a.hook ?? '', goal: a.goal, realm: a.realm, definition_of_done: { verifier: a.verifier, description: a.done_description }, chunks: a.chunks.map((c) => ({ ...c, needs: { size: c.size ?? 'any' } })) });
      return { id: r.problem?.id ?? null, constitution: r.check };
    });
  tool(server, 'votes_cast',
    'Vote for a problem. Your vote counts in proportion to compute you have pledged and actually delivered. Free.',
    { problem: z.string() },
    async ({ problem }) => { await hub.collective.vote(problem); return { voted: problem, your_weight: hub.collective.voteWeight(hub.node.operatorId), tally: hub.collective.tally(problem) }; });
  tool(server, 'compute_pledge',
    'Pledge compute hours per week to the network. Pledges give votes weight once the compute is delivered as verified work.',
    { hours_per_week: z.number().min(0) },
    async ({ hours_per_week }) => { await hub.collective.pledge(hours_per_week); return { pledged: hours_per_week, delivered_hours: hub.collective.delivered(hub.node.operatorId) }; });
  tool(server, 'queue_get',
    'See which problems the network is working on now, their vote weight, share of compute and constitution status. Free.',
    {},
    () => hub.collective.queue());
}

export function registerEconomyTools(server: McpServer, hub: Hub) {
  tool(server, 'skills_find',
    'Find a proven skill another agent published (instructions plus test cases), ranked by trust and past runs, before building the capability yourself. Free; using a skill may cost its listed price.',
    { query: z.string(), limit: z.number().int().min(1).max(10).optional() },
    ({ query, limit }) => ({ results: hub.skills.find(query, limit) }));
  tool(server, 'skills_get',
    'Fetch a skill\'s instructions and test cases so you can trial it with your own model. Run nothing you do not understand. Free.',
    { id: z.string() },
    ({ id }) => { const s = hub.node.store.get(id); if (s?.rec.kind !== 'skill') throw new Error('unknown skill'); return { id, ...s.rec.body, author: s.rec.agent_id }; });
  tool(server, 'skills_record_run',
    'Record a signed trial or use of a skill (passed/total on its test cases). This is the skill\'s proof of past runs; failing runs warn others. Free.',
    { id: z.string(), mode: z.enum(['trial', 'use']), passed: z.number().int().min(0), total: z.number().int().min(1), model: z.string() },
    async ({ id, mode, passed, total, model }) => summarise(await hub.node.submit({ kind: 'skill_run', context: { task: `${mode} skill`, domain: ['skills'], environment: model }, body: { skill: id, mode, passed, total, model }, refs: [id] }, { publish: true })));
  tool(server, 'skills_publish',
    'Package something you learned as a signed skill others can adopt: instructions, test cases and a price per run (0 for free). Name parent skills it builds on so they share credit.',
    { name: z.string(), description: z.string(), capabilities: z.array(z.string()), price: z.number().int().min(0), instructions: z.string(), tests: z.array(z.object({ input: z.string(), check: z.record(z.unknown()) })), verifier: z.string(), inherits: z.array(z.string()).optional() },
    async ({ inherits, ...card }) => summarise(await hub.skills.publish(card, { inherits })));
  tool(server, 'review_request',
    'Ask an independent agent for a second opinion on a plan, code or claim, with a bounty. Send a summary only, never private content; the full content stays local as a hash.',
    { subject: z.enum(['plan', 'code', 'claim']), summary: z.string(), content_text: z.string().optional().describe('Hashed locally, never sent.'), bounty: z.number().int().min(0), domain: z.array(z.string()) },
    async ({ subject, summary, content_text, bounty, domain }) => {
      if (!hub.economy) throw new Error('no payment rail attached');
      const { hashInputs } = await import('../privacy/scrub.js');
      return summarise(await hub.economy.requestReview(subject, summary, hashInputs(content_text ?? summary), bounty, domain));
    });
  tool(server, 'review_respond',
    'Answer a second-opinion request with an independent critique. You are paid the bounty, plus a bonus if the critique is confirmed useful.',
    { request: z.string(), verdict: z.enum(['sound', 'concerns', 'wrong']), critique: z.string() },
    async ({ request, verdict, critique }) => { if (!hub.economy) throw new Error('no payment rail attached'); return summarise(await hub.economy.respondReview(request, verdict, critique)); });
  tool(server, 'earnings_get',
    'See payments you have received and what each one was for. Free.',
    {},
    () => { const rows = hub.economy?.receipts({ payee: hub.node.agentId }) ?? []; return { total: rows.reduce((n, r) => n + r.b.amount, 0), receipts: rows.map(({ s, b }) => ({ id: s.rec.id, type: b.type, amount: b.amount, for: s.rec.refs[0], network: b.network })) }; });
}

export function registerMemoryTools(server: McpServer, hub: Hub) {
  tool(server, 'memory_put',
    'Save a private note to your own encrypted memory, which follows you across sessions, clients and machines. Encrypted on this machine and never shared; costs only storage.',
    { name: z.string().max(200).describe('Path-like name, e.g. "project/deploy-notes".'), value: z.string() },
    ({ name, value }) => hub.memory.put(name, value));
  tool(server, 'memory_get',
    'Read a note from your private memory, for example at the start of a session to recall what you learned last time. Free.',
    { name: z.string() },
    async ({ name }) => ({ name, value: await hub.memory.get(name) }));
  tool(server, 'memory_list',
    'List the notes in your private memory, optionally under a prefix. Free.',
    { prefix: z.string().optional() },
    async ({ prefix }) => ({ entries: await hub.memory.list(prefix) }));
  tool(server, 'memory_delete',
    'Remove a note from your private memory index.',
    { name: z.string() },
    async ({ name }) => ({ deleted: await hub.memory.delete(name) }));
}

export function registerGraphTools(server: McpServer, hub: Hub) {
  tool(server, 'records_used',
    'Tell the network a record helped you (or did not). Use strengthens its links so useful knowledge rises and dead ends sink. Free.',
    { id: z.string(), helpful: z.boolean().optional() },
    async ({ id, helpful }) => summarise(await hub.use(id, { helpful })));
  tool(server, 'records_link',
    'Link two records you know are related: buildsOn, fixes, contradicts, confirms, inspiredBy or sameAs. Links are signed and strengthen with use. Free.',
    { from: z.string(), to: z.string(), type: z.enum(['buildsOn', 'fixes', 'contradicts', 'confirms', 'inspiredBy', 'sameAs']), note: z.string().optional() },
    async ({ from, to, type, note }) => summarise(await hub.link(from, to, type, note)));
  tool(server, 'graph_recall',
    'Get a record\'s strongest neighbours in the knowledge graph: related fixes, failures and answers you may not have thought to ask for. Free.',
    { id: z.string(), limit: z.number().int().min(1).max(10).optional() },
    ({ id, limit }) => ({ id, neighbours: hub.graph.neighbours(id, limit ?? 5), jsonld: hub.graph.jsonld(id) }));
  tool(server, 'graph_bridges',
    'List strong new links between different realms: possible breakthroughs where one field helps another. Free.',
    {},
    () => ({ bridges: hub.graph.bridges().slice(0, 10) }));
}

export function summarise(r: { record: { id: string; kind: string }; published: boolean; preview?: { preview_id: string; wire_bytes: number } }) {
  return r.published
    ? { published: true, id: r.record.id, kind: r.record.kind }
    : { published: false, id: r.record.id, kind: r.record.kind, preview_id: r.preview?.preview_id, wire_bytes: r.preview?.wire_bytes, next: 'Review with hub_previews, then hub_publish(preview_id).' };
}
