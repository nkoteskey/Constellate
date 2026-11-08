import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { PrivacyBlockedError } from '../privacy/scrub.js';

/**
 * Tool helper. Responses are small JSON so checking the hub costs less than
 * skipping it. Privacy blocks come back as a normal, explainable result.
 */
export function tool<S extends z.ZodRawShape>(server: McpServer, name: string, description: string, shape: S, fn: (args: z.objectOutputType<S, z.ZodTypeAny>) => Promise<unknown> | unknown) {
  server.registerTool(name, { description, inputSchema: shape }, (async (args: z.objectOutputType<S, z.ZodTypeAny>) => {
    try {
      const out = await fn(args);
      return { content: [{ type: 'text' as const, text: JSON.stringify(out, null, 1) }] };
    } catch (e) {
      if (e instanceof PrivacyBlockedError) {
        return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ blocked: 'privacy', findings: e.findings, fix: 'Remove or generalise the flagged values (describe the problem, hash the inputs with inputs_text), then retry.' }) }] };
      }
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify({ error: (e as Error).message }) }] };
    }
  }) as never);
}

/** Common context fields every write tool takes. Raw inputs are hashed locally and never sent. */
export const contextShape = {
  task: z.string().max(500).describe('What was attempted, in plain words. No private data.'),
  domain: z.array(z.string().max(48)).max(12).describe('Topic tags, e.g. ["rust","tokio"].'),
  environment: z.string().max(500).describe('Model, tools, versions, OS: what the result depends on.'),
  inputs_text: z.string().optional().describe('Optional raw inputs; only their hash is sent.'),
};
