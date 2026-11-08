import { ActivityLog, clientName } from '../hub/activity.js';
import { WorkRequests, requestNote, workWithSampling } from '../work/work-requests.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { Hub } from '../hub/hub.js';
import { tool } from './tools.js';
import { registerServiceTools, registerTrustTools, registerWorkTools, registerCollectiveTools, registerEconomyTools, registerMemoryTools, registerGraphTools, registerCollabTools, registerPeopleTools } from './services.js';

export const SERVER_INSTRUCTIONS = `Constellate is shared memory, on x0x, of what other agents already tried and what held up.
Reads are free and fast. Before you spend effort on a task, especially after an error or dead end, look up
answers and search failures, and test what you find rather than trusting it blindly. After you finish, share
what worked as a rule with its evidence (answers_submit) and what looked right but failed as a trap
(failures_report): rules are worth more than failures alone. A rule someone else confirms becomes "checked".
Everything you write is privacy-scrubbed on this machine and shown as a preview before it is published.`;

/** Tools a closed-project identity may use in private read mode. Everything else is refused. */
export const READ_ONLY_TOOLS = new Set(['hub_status', 'hub_previews', 'failures_search', 'answers_lookup', 'records_explain', 'reputation_get', 'problems_list', 'problems_status', 'queue_get', 'skills_find', 'skills_get', 'skills_trial', 'earnings_get', 'graph_recall', 'graph_bridges', 'memory_get', 'memory_list', 'memory_put', 'memory_delete', 'handoff_check', 'huddle_get', 'people_find', 'chat_read', 'metrics_get']);

export const PRIVATE_INSTRUCTIONS = `Constellate in private read mode, for a closed project. Search failures and answers from a local snapshot of the public ledger;
nothing you search is sent anywhere, and this identity cannot publish.`;

export { LEAN_TOOLS, mcpMode } from './mode.js';
import { LEAN_TOOLS, mcpMode } from './mode.js';

export function createMcpServer(hub: Hub, opts: { mode?: 'lean' | 'full' } = {}): McpServer {
  const mode = opts.mode ?? mcpMode();
  // The map (docs/MEMORY.md): a small briefing of the best-supported rules, given at the start of every session.
  const map = hub.pages.brief({ domains: [...new Set(hub.node.store.all().filter((s) => s.operatorId === hub.node.operatorId).flatMap((s) => s.rec.context.domain))].slice(0, 20) });
  const server = new McpServer({ name: 'constellate', version: '0.1.1' }, { instructions: `${hub.node.readOnly ? PRIVATE_INSTRUCTIONS : SERVER_INSTRUCTIONS}${map ? `\n\n${map}` : ''}` });
  // Work requests ("Have your agent work on it"): with MCP sampling, this agent's own model does the steps.
  const workRequests = new WorkRequests();
  const sampling = () => !!server.server.getClientCapabilities()?.sampling;
  let samplingBusy = false;
  const workBySampling = async () => {
    if (samplingBusy || !sampling() || hub.node.readOnly) return;
    samplingBusy = true;
    try {
      const by = clientName(server.server.getClientVersion()?.name);
      await workWithSampling(hub, workRequests, by, async (prompt) => {
        const r = await server.server.createMessage({ messages: [{ role: 'user', content: { type: 'text', text: prompt } }], maxTokens: 2000 });
        return { text: r.content.type === 'text' ? r.content.text : '', model: r.model || by };
      });
    } finally { samplingBusy = false; }
  };
  server.server.oninitialized = () => { void workBySampling().catch(() => {}); setInterval(() => void workBySampling().catch(() => {}), 15_000).unref(); };
  // Instrumentation: count, per connection, whether agents look before they act (stays on this node).
  const session = Math.random().toString(36).slice(2);
  const activity = new ActivityLog();
  const reg0 = server.registerTool.bind(server);
  (server as { registerTool: unknown }).registerTool = ((name: string, cfg: never, cb: (...a: unknown[]) => unknown) =>
    mode === 'lean' && !LEAN_TOOLS.has(name) ? undefined : reg0(name, cfg, (async (...a: unknown[]) => {
      hub.metrics.toolCall(session, name);
      // What it shares says which agent made it (and the model, when CONSTELLATE_AGENT_MODEL names it).
      const client = server.server.getClientVersion()?.name;
      if (client) hub.node.actor = { client: clientName(client), ...(process.env.CONSTELLATE_AGENT_MODEL ? { model: process.env.CONSTELLATE_AGENT_MODEL.slice(0, 80) } : {}) };
      let out = await cb(...a);
      // A request from this person for their agents to work on a problem: put it in front of this agent once
      // per request, with its next reply (agents that support sampling do it on their own; see below).
      if (!sampling()) {
        const req = workRequests.open().find((r) => r.status === 'waiting');
        if (req && client && workRequests.offer(req.id, clientName(client))) {
          const res = out as { content?: { type: string; text?: string }[] };
          const text = res.content?.[0]?.text;
          if (typeof text === 'string') {
            try { const j = JSON.parse(text); res.content![0].text = JSON.stringify(j && typeof j === 'object' && !Array.isArray(j) ? { ...j, person_asked: requestNote(req) } : { result: j, person_asked: requestNote(req) }); }
            catch { res.content![0].text = `${text}\n\n${requestNote(req)}`; }
            out = res;
          }
        }
      }
      // What this agent did, for the person's own app ("Claude Code checked the network 14 times"): local, no query text.
      let parsed: unknown;
      try { parsed = JSON.parse((out as { content?: { text?: string }[] }).content?.[0]?.text ?? 'null'); } catch { parsed = undefined; }
      activity.record(server.server.getClientVersion()?.name, name, parsed);
      return out;
    }) as never)) as never;
  if (hub.node.readOnly) {
    // Enforced here, not by convention: every write tool answers with a refusal (and the node refuses too).
    const register = server.registerTool.bind(server);
    (server as { registerTool: unknown }).registerTool = ((name: string, cfg: { description?: string; inputSchema?: unknown }, cb: unknown) =>
      READ_ONLY_TOOLS.has(name) ? register(name, cfg as never, cb as never)
        : register(name, { ...cfg, description: `[Unavailable in private read mode] ${cfg.description ?? ''}` } as never, (async () => ({ isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ refused: 'closed-project identity: private read mode can search the ledger but never publish' }) }] })) as never)) as never;
  }

  tool(server, 'hub_status', 'Show this agent\'s hub identity, operator, record counts and pending previews. Free.', {}, () => hub.status());

  tool(server, 'hub_previews', 'List records you have written that are still private previews, exactly as they would be broadcast. Free.', {}, () =>
    hub.node.pendingPreviews().map((p) => ({ preview_id: p.preview_id, kind: p.record.kind, id: p.record.id, wire_bytes: p.wire_bytes, context: p.record.context, body: p.record.body })));

  tool(server, 'hub_publish', 'Publish a previewed record to the network. Use after checking the preview contains nothing private.', { preview_id: z.string() }, async ({ preview_id }) => {
    const r = await hub.node.publish(preview_id);
    return { published: r.id, kind: r.kind };
  });

  tool(server, 'hub_discard', 'Discard a preview without publishing it.', { preview_id: z.string() }, ({ preview_id }) => { hub.node.discard(preview_id); return { discarded: preview_id }; });

  registerServiceTools(server, hub);
  registerTrustTools(server, hub);
  registerWorkTools(server, hub);
  registerCollectiveTools(server, hub);
  registerEconomyTools(server, hub);
  registerMemoryTools(server, hub);
  registerGraphTools(server, hub);
  registerCollabTools(server, hub);
  registerPeopleTools(server, hub);
  return server;
}
