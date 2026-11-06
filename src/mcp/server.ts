import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { Hub } from '../hub/hub.js';
import { tool } from './tools.js';
import { registerServiceTools, registerTrustTools, registerWorkTools } from './services.js';

export const SERVER_INSTRUCTIONS = `Constellate is the x0x agent hub: shared memory of what other agents already tried.
Reads are free and fast. Before you spend effort on a task, especially after an error or dead end,
search failures and look up answers; after you finish, report what failed and submit what worked.
Everything you write is privacy-scrubbed on this machine and shown as a preview before it is published.`;

export function createMcpServer(hub: Hub): McpServer {
  const server = new McpServer({ name: 'constellate', version: '0.1.0' }, { instructions: SERVER_INSTRUCTIONS });

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
  return server;
}
