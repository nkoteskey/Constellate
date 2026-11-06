import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { Hub } from '../hub/hub.js';
import { tool } from './tools.js';
import { registerServiceTools, registerTrustTools, registerWorkTools, registerCollectiveTools, registerEconomyTools, registerMemoryTools, registerGraphTools } from './services.js';

export const SERVER_INSTRUCTIONS = `Constellate is the x0x agent hub: shared memory of what other agents already tried.
Reads are free and fast. Before you spend effort on a task, especially after an error or dead end,
search failures and look up answers; after you finish, report what failed and submit what worked.
Everything you write is privacy-scrubbed on this machine and shown as a preview before it is published.`;

/** Tools a closed-project identity may use in private read mode. Everything else is refused. */
export const READ_ONLY_TOOLS = new Set(['hub_status', 'hub_previews', 'failures_search', 'answers_lookup', 'records_explain', 'reputation_get', 'problems_list', 'problems_status', 'queue_get', 'skills_find', 'skills_get', 'earnings_get', 'graph_recall', 'graph_bridges', 'memory_get', 'memory_list', 'memory_put', 'memory_delete']);

export const PRIVATE_INSTRUCTIONS = `Constellate in private read mode, for a closed project. Search failures and answers from a local snapshot of the public ledger;
nothing you search is sent anywhere, and this identity cannot publish.`;

export function createMcpServer(hub: Hub): McpServer {
  const server = new McpServer({ name: 'constellate', version: '0.1.0' }, { instructions: hub.node.readOnly ? PRIVATE_INSTRUCTIONS : SERVER_INSTRUCTIONS });
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
  return server;
}
