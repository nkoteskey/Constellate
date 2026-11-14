import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Hub } from '../../src/hub/hub.js';
import { LocalSigner } from '../../src/core/identity.js';
import { Planner, CLAUDE_NEEDS_KEY } from '../../src/collective/planner.js';
import { KeyVault } from '../../src/contributor/keyvault.js';
import { createMcpServer } from '../../src/mcp/server.js';
import type { ModelRunner } from '../../src/contributor/models.js';

/**
 * Plan it with your agent: the idea goes to an agent, which reports a plan in the network's format; the plan is
 * validated on arrival and waits for the person, who publishes it. Not a copy-paste prompt.
 */
const tmp = () => mkdtempSync(join(tmpdir(), 'plan-'));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function withIdea() {
  const home = tmp();
  process.env.CONSTELLATE_HOME = home;
  const hub = new Hub({ signer: LocalSigner.generate(), preview: false });
  const { record } = await hub.node.submit({ kind: 'proposal', context: { task: 'idea', domain: ['maths_physics'], environment: 'human (browser)' }, body: { title: 'Sum of squares, checked', goal: 'Compute sums of squares mod a prime for many ranges, each checked by recomputation', done: 'every range has a recomputed answer', realm: 'maths_physics', check: 'recompute' } }, { publish: true });
  return { hub, idea: record.id, home };
}
const good = {
  plan: { title: 'Sums of squares mod 97', hook: 'Small checkable sums', goal: 'Compute the sum of squares from 1 to n, mod 97, for several n.', realm: 'maths_physics', verifier: 'sum_squares_mod', done_description: 'Every step is recomputed by the verifier and matches.', steps: [{ key: 'n-100', title: 'Sum to 100', prompt: 'Sum of squares 1..100 mod 97? End with the number.', check: { from: 1, to: 100, mod: 97 } }, { key: 'n-200', title: 'Sum to 200', prompt: 'Sum of squares 1..200 mod 97? End with the number.', check: { from: 1, to: 200, mod: 97 } }] },
  findings: { related: [{ title: 'Phase 3 toy problem', why: 'Same verifier' }], risks: ['Too easy to be interesting'], open_questions: [], why_checkable: 'The verifier recomputes each sum exactly.' },
};

describe('plan it with your agent', () => {
  it('a report must match the format; a good one waits for the person, who publishes it as a live problem', async () => {
    const { hub, idea } = await withIdea();
    try {
      const p = hub.planner;
      const r = await p.start(idea, 'any_agent');
      expect(r.status).toBe('waiting');
      expect(p.brief(r.id)).toContain('plan_report');
      expect(p.brief(r.id)).toContain('sum_squares_mod');
      await expect(p.report(r.id, { plan: { title: 'x' } })).rejects.toThrow(/doesn't match the format: plan\./);
      const bad = await p.report(r.id, { ...good, plan: { ...good.plan, verifier: 'vibes', steps: [good.plan.steps[0], good.plan.steps[0]] } });
      expect(bad.status).toBe('reported');
      expect(bad.problems!.join(' ')).toMatch(/"vibes" isn't a registered check.*used twice/);
      await expect(p.publish(r.id)).rejects.toThrow(/fix these first/);
      const ok = await p.report(r.id, good, 'claude-code');
      expect(ok).toMatchObject({ status: 'reported', problems: [], agent: 'Claude Code' });
      expect(hub.problems.list()).toHaveLength(0); // nothing goes live on the agent's say-so
      const id = await p.publish(r.id);
      expect(hub.problems.get(id)).toBeTruthy();
      expect(p.get(r.id)).toMatchObject({ status: 'published', published: id });
    } finally { delete process.env.CONSTELLATE_HOME; }
  });

  it('the app\'s own model writes a plan that is validated like any report', async () => {
    const { hub, idea } = await withIdea();
    try {
      const model: ModelRunner = { id: 'test:planner', family: 'test', size: 'small', costPerCall: 0, run: async (prompt) => (prompt.includes('ONLY the JSON') ? `Here you go:\n${JSON.stringify(good)}\n` : '') };
      const p = hub.usePlanner(new Planner(hub, model));
      expect(p.options().model).toBe('test:planner');
      const r = await p.start(idea, 'model');
      for (let i = 0; i < 20 && p.get(r.id)?.status === 'running'; i++) await wait(20);
      expect(p.get(r.id)).toMatchObject({ status: 'reported', agent: 'test:planner', problems: [] });
    } finally { delete process.env.CONSTELLATE_HOME; }
  });

  it('a connected agent finds the waiting request with plan_report and reports through it', async () => {
    const { hub, idea } = await withIdea();
    process.env.CONSTELLATE_APP_URL = 'http://127.0.0.1:9'; // no app running: the tool falls back to this process
    try {
      const r = await hub.planner.start(idea, 'any_agent');
      const server = createMcpServer(hub);
      const [a, b] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'cursor', version: '1' });
      await Promise.all([server.connect(a), client.connect(b)]);
      expect((await client.listTools()).tools.map((t) => t.name)).toContain('plan_report');
      const call = async (args: Record<string, unknown>) => JSON.parse(((await client.callTool({ name: 'plan_report', arguments: args })).content as { text: string }[])[0].text);
      const waiting = await call({});
      expect(waiting.waiting[0]).toMatchObject({ id: r.id, title: 'Sum of squares, checked' });
      expect(waiting.waiting[0].brief).toContain('Research first');
      const done = await call({ request: r.id, ...good });
      expect(done).toMatchObject({ status: 'reported', problems: [] });
      expect(hub.planner.get(r.id)?.agent).toBe('Cursor'); // the MCP client's name, as people know it
      expect((await call({})).waiting).toEqual([]);
      await client.close();
    } finally { delete process.env.CONSTELLATE_HOME; delete process.env.CONSTELLATE_APP_URL; }
  });

  it('Claude Code is started headless with only Constellate\'s tools, and a run that reports nothing says so', async () => {
    const { hub, idea, home } = await withIdea();
    const fake = join(home, 'claude');
    const argsFile = join(home, 'args.json');
    writeFileSync(fake, `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));\n`);
    chmodSync(fake, 0o755);
    process.env.CONSTELLATE_CLAUDE = fake;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    try {
      expect(hub.planner.options().claude_code).toBe(true);
      const r = await hub.planner.start(idea, 'claude_code');
      for (let i = 0; i < 100 && hub.planner.get(r.id)?.status === 'running'; i++) await wait(30);
      const args = JSON.parse(readFileSync(argsFile, 'utf8')) as string[];
      expect(args[0]).toBe('-p');
      expect(args[1]).toContain(`request "${r.id}"`);
      expect(args).toContain('--strict-mcp-config');
      expect(args[args.indexOf('--allowedTools') + 1].split(',')).toEqual(['mcp__constellate__plan_report', 'mcp__constellate__failures_search', 'mcp__constellate__answers_lookup', 'mcp__constellate__skills_find', 'WebSearch', 'WebFetch']); // web research is on by default (src/work/claude-tools.ts)
      expect(JSON.parse(args[args.indexOf('--mcp-config') + 1]).mcpServers.constellate.args.at(-1)).toBe('mcp');
      expect(hub.planner.get(r.id)).toMatchObject({ status: 'failed', error: 'Claude Code finished without reporting a plan.' });
      expect(args.slice(args.indexOf('--output-format'), args.indexOf('--output-format') + 3)).toEqual(['--output-format', 'stream-json', '--verbose']);
    } finally { delete process.env.CONSTELLATE_HOME; delete process.env.ANTHROPIC_API_KEY; process.env.CONSTELLATE_CLAUDE = 'off'; }
  });

  it('Claude Code runs only on a Claude API key, never on a Claude plan', async () => {
    const { hub, idea, home } = await withIdea();
    const fake = join(home, 'claude');
    const seen = join(home, 'env.json');
    writeFileSync(fake, `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(seen)}, JSON.stringify({ key: process.env.ANTHROPIC_API_KEY ?? null, plan: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null }));\n`);
    chmodSync(fake, 0o755);
    process.env.CONSTELLATE_CLAUDE = fake;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'plan-token'; // a Claude plan login handed down from the environment
    try {
      // Installed, but no key: not offered, and asking for it says how to add one.
      expect(hub.planner.options().claude_code).toBe(false);
      expect(hub.agentRuns.available()).toBe(false);
      const none = await hub.planner.start(idea, 'claude_code');
      expect(hub.planner.get(none.id)).toMatchObject({ status: 'failed', error: CLAUDE_NEEDS_KEY });
      expect(existsSync(seen)).toBe(false); // never started

      // A key saved in the encrypted key store: it runs on that key, and the plan login isn't passed down.
      new KeyVault(join(home, 'keys.json')).set('anthropic', 'sk-ant-saved');
      expect(hub.planner.options().claude_code).toBe(true);
      const r = await hub.planner.start(idea, 'claude_code');
      for (let i = 0; i < 100 && hub.planner.get(r.id)?.status === 'running'; i++) await wait(30);
      expect(JSON.parse(readFileSync(seen, 'utf8'))).toEqual({ key: 'sk-ant-saved', plan: null });
    } finally { delete process.env.CONSTELLATE_HOME; delete process.env.CLAUDE_CODE_OAUTH_TOKEN; process.env.CONSTELLATE_CLAUDE = 'off'; }
  });

  it('the person can see what actually happened: who picked the request up, each search, and how it ended', async () => {
    const { hub, idea, home } = await withIdea();
    process.env.CONSTELLATE_APP_URL = 'http://127.0.0.1:9';
    try {
      // Claude Desktop (MCP client name "claude-ai") reads the waiting request, then reports.
      const r = await hub.planner.start(idea, 'any_agent');
      expect(hub.planner.get(r.id)!.log![0].text).toMatch(/check Constellate for planning requests/);
      const server = createMcpServer(hub);
      const [a, b] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'claude-ai', version: '1' });
      await Promise.all([server.connect(a), client.connect(b)]);
      await client.callTool({ name: 'plan_report', arguments: {} });
      expect(hub.planner.get(r.id)!.log!.map((l) => l.text)).toContain('Claude Desktop picked this up and is researching it.');
      await client.callTool({ name: 'plan_report', arguments: { request: r.id, ...good } });
      expect(hub.planner.get(r.id)!.log!.at(-1)!.text).toMatch(/^Claude Desktop reported a plan: 2 steps, 1 related item found\. Ready for you to review\.$/);
      await client.close();

      // Claude Code streams its progress; each Constellate tool it uses becomes a line.
      const fake = join(home, 'claude');
      const lines = [
        { type: 'system', subtype: 'init', model: 'claude-sonnet' },
        { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__constellate__failures_search', input: { query: 'Ramsey lower bounds' } }] } },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'thinking' }, { type: 'tool_use', name: 'mcp__constellate__answers_lookup', input: { question: 'best known R(5,5) lower bound' } }] } },
        { type: 'result', duration_ms: 3200, total_cost_usd: 0.04 },
      ];
      writeFileSync(fake, `#!/usr/bin/env node\nfor (const l of ${JSON.stringify(lines.map((x) => JSON.stringify(x)))}) console.log(l);\n`);
      chmodSync(fake, 0o755);
      process.env.CONSTELLATE_CLAUDE = fake;
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
      const c = await hub.planner.start(idea, 'claude_code');
      for (let i = 0; i < 100 && hub.planner.get(c.id)?.status === 'running'; i++) await wait(30);
      expect(hub.planner.get(c.id)!.log!.map((l) => l.text)).toEqual([
        'Starting Claude Code on this computer…',
        'It may use Constellate\'s tools, web search and web fetch.',
        'Claude Code started (claude-sonnet) with Constellate connected.',
        'Searched what already failed: “Ramsey lower bounds”',
        'Looked for solved answers: “best known R(5,5) lower bound”',
        'Claude Code finished in 3 s (about $0.04, billed to your Claude API key).',
        'Stopped: Claude Code finished without reporting a plan. Its last words: “thinking”',
      ]);
    } finally { delete process.env.CONSTELLATE_HOME; delete process.env.CONSTELLATE_APP_URL; delete process.env.ANTHROPIC_API_KEY; process.env.CONSTELLATE_CLAUDE = 'off'; }
  });

  it('when Claude Code ends without plan_report, it says why, and a plan written in its reply still counts', async () => {
    const { hub, idea, home } = await withIdea();
    const fake = join(home, 'claude');
    const run = async (lines: unknown[]) => {
      writeFileSync(fake, `#!/usr/bin/env node\nfor (const l of ${JSON.stringify(lines.map((x) => JSON.stringify(x)))}) console.log(l);\n`);
      chmodSync(fake, 0o755);
      const r = await hub.planner.start(idea, 'claude_code');
      for (let i = 0; i < 100 && hub.planner.get(r.id)?.status === 'running'; i++) await wait(30);
      return hub.planner.get(r.id)!;
    };
    process.env.CONSTELLATE_CLAUDE = fake;
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    try {
      // Constellate's tools didn't connect, a tool call failed, and it gave up: each is said, with its last words.
      const failed = await run([
        { type: 'system', subtype: 'init', mcp_servers: [{ name: 'constellate', status: 'failed' }] },
        { type: 'user', message: { content: [{ type: 'tool_result', is_error: true, content: [{ type: 'text', text: 'No such tool available: mcp__constellate__plan_report' }] }] } },
        { type: 'result', duration_ms: 1000, result: 'I could not reach the plan_report tool.' },
      ]);
      expect(failed.status).toBe('failed');
      expect(failed.log!.map((l) => l.text)).toEqual(expect.arrayContaining([
        "Claude Code started, but Constellate's tools didn't connect (failed), so it can't search or report back.",
        'A tool call failed: No such tool available: mcp__constellate__plan_report',
      ]));
      expect(failed.error).toBe('Claude Code finished without reporting a plan. Its last words: “I could not reach the plan_report tool.”');

      // It wrote the plan out instead of calling plan_report: that's taken, and checked like any report.
      const written = await run([{ type: 'result', duration_ms: 1000, result: `Here is the plan:\n${JSON.stringify(good)}` }]);
      expect(written).toMatchObject({ status: 'reported', problems: [], agent: 'Claude Code' });
      expect(written.log!.at(-1)!.text).toMatch(/Took the plan from Claude Code’s reply/);
    } finally { delete process.env.CONSTELLATE_HOME; delete process.env.ANTHROPIC_API_KEY; process.env.CONSTELLATE_CLAUDE = 'off'; }
  });

  it('plan_report accepts the plan as JSON text as well as an object (models often send it that way)', async () => {
    const { hub, idea } = await withIdea();
    process.env.CONSTELLATE_APP_URL = 'http://127.0.0.1:9';
    try {
      const r = await hub.planner.start(idea, 'any_agent');
      const server = createMcpServer(hub);
      const [a, b] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'claude-code', version: '1' });
      await Promise.all([server.connect(a), client.connect(b)]);
      const out = JSON.parse(((await client.callTool({ name: 'plan_report', arguments: { request: r.id, plan: JSON.stringify(good.plan), findings: JSON.stringify(good.findings) } })).content as { text: string }[])[0].text);
      expect(out).toMatchObject({ status: 'reported', problems: [] });
      await client.close();
    } finally { delete process.env.CONSTELLATE_HOME; delete process.env.CONSTELLATE_APP_URL; }
  });
});
