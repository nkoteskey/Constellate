/**
 * GATE 1 behavioural eval — READY FOR HUMAN TESTING (needs ANTHROPIC_API_KEY).
 *
 * Question: do agents check the ledger before acting, without being told to?
 * Claude gets the hub's real MCP tools (names, descriptions, schemas) next to an
 * ordinary "edit/run" tool, a coding task, and NO system prompt about the hub.
 * Pass if, in most trials, it calls failures_search or answers_lookup before
 * its first action. Run: npx tsx evals/gate1.ts [trials]
 */
import Anthropic from '@anthropic-ai/sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Hub } from '../src/hub/hub.js';
import { LocalSigner } from '../src/core/identity.js';
import { createMcpServer } from '../src/mcp/server.js';

const TASKS = [
  'Our Rust service needs to compile for wasm32-unknown-unknown but the build fails with "mio does not support wasm32". Fix it.',
  'pip install torch==2.1 fails on Python 3.13 in CI. Get the install working.',
  'Lean 4 `lake build` on a Mathlib project takes hours on CI. Make it fast.',
  'Write a function that parses ISO 8601 durations like P3DT4H in TypeScript.',
];
const LOOKUPS = new Set(['failures_search', 'answers_lookup']);

async function main() {
  const trials = Number(process.argv[2] ?? 3);
  const hub = new Hub({ signer: LocalSigner.generate(), preview: false });
  const server = createMcpServer(hub);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const mcp = new Client({ name: 'gate1', version: '0' });
  await mcp.connect(b);
  const { tools } = await mcp.listTools();

  const anthropicTools: Anthropic.Tool[] = [
    ...tools.map((t) => ({ name: t.name, description: t.description ?? '', input_schema: t.inputSchema as Anthropic.Tool.InputSchema })),
    { name: 'bash', description: 'Run a shell command in the project and return its output.', input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
    { name: 'edit_file', description: 'Replace the contents of a file in the project.', input_schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
  ];

  const client = new Anthropic();
  let checked = 0, total = 0;
  for (const task of TASKS) {
    for (let i = 0; i < trials; i++) {
      const response = await client.messages.create({
        model: 'claude-opus-5-5',
        max_tokens: 16000,
        tools: anthropicTools,
        tool_choice: { type: 'auto' },
        messages: [{ role: 'user', content: task }],
      });
      if (response.stop_reason === 'refusal') { console.log(`refusal on: ${task}`); continue; }
      const first = response.content.find((c): c is Anthropic.ToolUseBlock => c.type === 'tool_use');
      const ok = !!first && LOOKUPS.has(first.name);
      total++; if (ok) checked++;
      console.log(`${ok ? 'CHECKED' : 'skipped'}  first=${first?.name ?? '(no tool)'}  ${task.slice(0, 60)}`);
    }
  }
  const rate = checked / Math.max(1, total);
  console.log(`\nchecked the hub first in ${checked}/${total} trials (${Math.round(rate * 100)}%) — gate threshold 75%`);
  process.exit(rate >= 0.75 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(2); });
