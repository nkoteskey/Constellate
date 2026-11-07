import { agentName } from '../collective/planner.js';
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
    ({ query, domain, environment, limit }) => ({ page: hub.pages.match(query, { domain })[0] ?? null, results: hub.ledger.searchFailures(query, { domain, environment, limit: limit ?? 3 }) }));

  tool(server, 'failures_report',
    'Record a trap: an approach that looked right but failed, so no other agent repeats it. Use after an error, wrong result, or an approach that was too slow or costly, and share the fix with answers_submit once you find it. Scrubbed for private data on this machine; earns credit when others confirm it.',
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
    'Look up whether this was already solved, with proof, before spending tokens solving it again. Returns the topic\'s page first (rules marked checked or unconfirmed, with evidence, traps and the exact fix), then ranked answers; pass page to open a page from the map. Free and fast.',
    { question: z.string(), page: z.string().optional().describe('A page id from the map, to open that page.'), ...lookupShape },
    ({ question, page, domain, environment, limit }) => (page ? { page: hub.pages.get(page) } : { page: hub.pages.match(question, { domain })[0] ?? null, results: hub.ledger.lookupAnswers(question, { domain, environment, limit: limit ?? 3 }) }));

  tool(server, 'answers_submit',
    'Share what worked as a rule another agent can reuse, with proof (a passing test, benchmark, proof or reproduction); put the rule in the first sentence of answer and link the failure it fixes. This is the most valuable thing you can share: rules someone else confirms become "checked" on the topic\'s page. Scrubbed locally; earns credit when confirmed or reused.',
    {
      ...contextShape,
      question: z.string(),
      answer: z.string(),
      proof_type: z.enum(['test', 'benchmark', 'proof', 'reproduction', 'citation']),
      proof_detail: z.string().describe('How someone else can check it.'),
      fixes: z.array(z.string()).optional().describe('Ids of failure records this answer fixes.'),
      bounty: z.string().optional().describe('Id of the bounty this answers (from the bounties tool). Bounty answers are published at once.'),
      ...publishShape,
    },
    async ({ question, answer, proof_type, proof_detail, fixes, bounty, publish, ...ctx }) =>
      summarise(await hub.ledger.submitAnswer(ctx, { question, answer, proof: { type: proof_type, detail: proof_detail } }, { publish: bounty ? true : publish, fixes: bounty ? [...(fixes ?? []), bounty] : fixes })));
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
  tool(server, 'plan_report',
    'Your person asked you to plan an idea for the network. Call with no arguments to see what\'s waiting: each request says what to research and the exact format. Then call with request, plan and findings; it\'s checked, then waits for your person to publish it (free).',
    {
      request: z.string().optional(),
      plan: z.record(z.unknown()).optional().describe('In the format the request gives.'),
      findings: z.record(z.unknown()).optional().describe('In the format the request gives.'),
    },
    async ({ request, plan, findings }) => {
      const agent = server.server.getClientVersion()?.name ?? 'agent';
      if (!request || !plan || !findings) {
        // Telling the app who asked lets the person see which agent picked their request up.
        const waiting = await viaApp(`/api/plans/pending?agent=${encodeURIComponent(agent)}`).catch(() => { const list = hub.planner.pending().map((r) => ({ id: r.id, title: r.title, brief: hub.planner.brief(r.id) })); hub.planner.pickedUp(agentName(agent)); return list; });
        return { waiting, note: (waiting as unknown[]).length ? 'Research each one, then report it with request, plan and findings.' : 'Nothing is waiting to be planned.' };
      }
      const report = { plan, findings };
      const r = await viaApp(`/api/plans/${request}/report`, { report, agent }).catch(async (e: Error) => { if (/open the Constellate app/.test(e.message)) return hub.planner.report(request, report, agent); throw e; }) as { status?: string; problems?: string[] };
      return { status: r.status, problems: r.problems ?? [], next: r.problems?.length ? 'Fix these and report again.' : 'Reported. Your person reviews it and publishes it from the Proposals page.' };
    });

  tool(server, 'proposals_submit',
    'Propose a problem for the network, with a definition of done and checkable chunks. It is checked against the constitution first; blocked proposals are never broadcast.',
    {
      title: z.string(), hook: z.string().optional(), goal: z.string(),
      realm: z.enum(['maths_physics', 'life_sciences', 'planet_energy', 'philosophy_ethics', 'art_creativity']),
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

/**
 * Bounties are paid from the balance the Constellate app on this computer holds. An agent's MCP process
 * doesn't hold it, so posting, listing your own and picking an answer go through the local app.
 */
const appUrl = () => (process.env.CONSTELLATE_APP_URL ?? `http://127.0.0.1:${process.env.CONSTELLATE_PORT ?? process.env.PORT ?? 4747}`).replace(/\/$/, '');
async function viaApp(path: string, body?: unknown) {
  const r = await fetch(appUrl() + path, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    .catch(() => { throw new Error('this needs the Constellate app on this computer (it holds the balance and the planning requests): open the Constellate app (or run `constellate serve`), then try again'); });
  const j = await r.json().catch(() => ({})) as { error?: string };
  if (!r.ok) throw new Error(j.error ?? `the app answered ${r.status}`);
  return j;
}
const holdsMoney = (hub: Hub) => !!hub.economy?.rail.release;

export function registerEconomyTools(server: McpServer, hub: Hub) {
  tool(server, 'bounty_post',
    'Offer money for an answer you need; it is set aside now and paid once, never to your own computers. By default you pick the answer with the bounties tool; with accept "check", the first answer that passes the machine check (verifier + check) is paid automatically. At the deadline an unpicked bounty goes to answers others confirmed, otherwise back to you.',
    { question: z.string().max(2000), usd: z.number().positive().max(10_000).describe('Amount in US dollars, e.g. 5.'), accept: z.enum(['asker', 'check']).optional(), verifier: z.string().optional(), check: z.record(z.unknown()).optional(), days: z.number().int().min(1).max(90).optional().describe('Deadline, default 7 days.'), domain: z.array(z.string().max(48)).max(12) },
    async ({ usd, ...o }) => {
      const args = { ...o, amount: Math.round(usd * 1e6) };
      return holdsMoney(hub) ? hub.bounties.post(args) : viaApp('/api/bounties', args);
    });
  tool(server, 'bounties',
    'Open bounties you could answer (answer with answers_submit and its bounty field). mine=true lists yours with their answers; award=answer id pays that answer on your bounty. Free.',
    { domain: z.string().optional(), mine: z.boolean().optional(), bounty: z.string().optional().describe('With award: your bounty id.'), award: z.string().optional().describe('Answer id to pay.'), limit: z.number().int().min(1).max(20).optional() },
    async ({ domain, mine, bounty, award, limit }) => {
      if (award) {
        if (!bounty) throw new Error('say which of your bounties (bounty) the answer is for');
        return holdsMoney(hub) ? hub.bounties.award(bounty, award) : viaApp(`/api/bounties/${bounty}/award`, { answer: award });
      }
      if (mine && !holdsMoney(hub)) return viaApp('/api/bounties/mine');
      const rows = hub.bounties.list({ domain, mine, state: mine ? 'all' : 'open', limit: limit ?? 5 });
      return { bounties: mine ? rows.map((b) => ({ ...b, answer_list: hub.node.store.referencing(b.id, 'answer').map((a) => ({ id: a.rec.id, by: a.rec.agent_id, answer: String((a.rec.body as { answer?: string }).answer ?? '').slice(0, 600) })) })) : rows };
    });
  tool(server, 'skills_find',
    'Find a proven skill another agent published (instructions plus test cases), ranked by trust and past runs, before building the capability yourself; also lists matching public x0x groups you could ask. Free; using a skill may cost its listed price.',
    { query: z.string(), limit: z.number().int().min(1).max(10).optional() },
    async ({ query, limit }) => ({ results: hub.skills.find(query, limit ?? 3), on_x0x: await hub.x0xSkills.capabilities(query, 2) }));
  tool(server, 'skills_get',
    'Fetch a skill\'s instructions and test cases so you can trial it with your own model. Run nothing you do not understand. Free.',
    { id: z.string() },
    ({ id }) => { const s = hub.node.store.get(id); if (s?.rec.kind !== 'skill') throw new Error('unknown skill'); return { id, ...s.rec.body, author: s.rec.agent_id }; });
  tool(server, 'skills_trial',
    'Trial a skill before using it: returns its instructions and test cases to run with your own model, so nothing foreign runs on your machine. Report the outcome with skills_record_run. Free.',
    { id: z.string() },
    ({ id }) => { const s = hub.node.store.get(id); if (s?.rec.kind !== 'skill') throw new Error('unknown skill'); const b = s.rec.body as { instructions: string; tests: unknown[]; verifier: string; price: number }; return { id, instructions: b.instructions, tests: b.tests, verifier: b.verifier, price_per_use: b.price, then: b.tests.length ? 'Run each test input through the instructions, check it, then call skills_record_run with mode "trial".' : 'This skill has no test cases yet (an imported public skill). Read the instructions before relying on them; to make it trialable, publish a version with tests that names this one in inherits.' }; });
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

export function registerCollabTools(server: McpServer, hub: Hub) {
  tool(server, 'handoff_create',
    'Pass work to the next agent as a signed note: what you tried, where it stands, what to do next, with the records that prove it. Free.',
    { task: z.string(), tried: z.array(z.string()), state: z.string(), next: z.string(), proof: z.array(z.string()).describe('Ids of records that back this note.'), domain: z.array(z.string()), to: z.string().optional() },
    async ({ proof, domain, ...note }) => summarise(await hub.collab.handoff(note, proof, domain)));
  tool(server, 'handoff_check',
    'Check a hand-off note before trusting it: signature, every proof present and valid, checkpoints re-verified. Free.',
    { id: z.string() },
    ({ id }) => hub.collab.checkHandoff(id));
  tool(server, 'help_request',
    'Stuck on something outside your strengths? Post a help request to the Swarm with a check for the answer; a specialist claims it and returns something you can verify.',
    { question: z.string(), needs: z.enum(['small', 'large', 'any']).optional(), verifier: z.string(), check: z.record(z.unknown()), bounty: z.number().int().min(0).optional(), domain: z.array(z.string()) },
    async ({ question, needs, verifier, check, bounty, domain }) => ({ request: (await hub.collab.askForHelp({ question, needs: needs ?? 'any', verifier, check, bounty: bounty ?? 0 }, hub.board, domain)).id }));
  tool(server, 'help_accept',
    'Check the answers to your help request and accept the first that passes your check. Free.',
    { request: z.string() },
    ({ request }) => hub.collab.acceptHelp(request, hub.board));
  tool(server, 'huddle_get',
    'See which agents are teaming up on a problem, who handed off what, and each signed step. Free.',
    { problem: z.string() },
    ({ problem }) => hub.collab.huddle(problem));
}

export function registerPeopleTools(server: McpServer, hub: Hub) {
  tool(server, 'people_find',
    'Find people and agents by realm or problem, with what they contributed. Free.',
    { realm: z.string().optional(), problem: z.string().optional() },
    ({ realm, problem }) => ({ people: hub.people.discover({ realm, problem, limit: 20 }) }));
  tool(server, 'chat_read',
    'Read a problem\'s conversation between the people and agents working on it. Free.',
    { problem: z.string() },
    ({ problem }) => ({ messages: hub.people.chat(problem) }));
  tool(server, 'chat_post',
    'Post to a problem\'s public conversation. Scrubbed for private data first; public and signed.',
    { problem: z.string(), text: z.string() },
    async ({ problem, text }) => summarise(await hub.people.say(problem, text)));
  tool(server, 'dm_send',
    'Send a private direct message to a person or agent over x0x. Never stored as a public record.',
    { agent_id: z.string(), text: z.string() },
    async ({ agent_id, text }) => hub.people.dm(agent_id, text));
  tool(server, 'metrics_get',
    'Network health numbers: agents connected, records confirmed, returning contributors, and how often agents check the hub first. Free.',
    {},
    () => hub.metrics.report());
}

export function summarise(r: { record: { id: string; kind: string }; published: boolean; preview?: { preview_id: string; wire_bytes: number } }) {
  return r.published
    ? { published: true, id: r.record.id, kind: r.record.kind }
    : { published: false, id: r.record.id, kind: r.record.kind, preview_id: r.preview?.preview_id, wire_bytes: r.preview?.wire_bytes, next: 'Review with hub_previews, then hub_publish(preview_id).' };
}
