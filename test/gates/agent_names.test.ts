import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Hub } from '../../src/hub/hub.js';
import { LocalSigner } from '../../src/core/identity.js';
import { verifyRecord } from '../../src/core/record.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { Profiles } from '../../src/collab/profiles.js';
import { ProblemBody } from '../../src/work/problems.js';

/**
 * Who made what: a record an agent shares says which agent (and model, when known) made it, and still verifies;
 * a computer's agent can be given a name that survives restarts; and "Have your agent work on it" starts
 * Claude Code on a problem and shows what it did.
 */
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('names, and which agent made what', () => {
  it('a record shared through an agent says which agent made it, and the model when it is set', async () => {
    process.env.CONSTELLATE_HOME = mkdtempSync(join(tmpdir(), 'names-'));
    process.env.CONSTELLATE_AGENT_MODEL = 'claude-sonnet-4.5';
    try {
      const hub = new Hub({ signer: LocalSigner.generate(), preview: false });
      const server = createMcpServer(hub);
      const [a, b] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'claude-code', version: '1' });
      await Promise.all([server.connect(a), client.connect(b)]);
      const out = JSON.parse(((await client.callTool({ name: 'failures_report', arguments: { task: 'Build the docs site', approach: 'Upgrading the bundler to the next major version', outcome: 'error', error_summary: 'Config format changed; build fails on load', environment: 'node 22', domain: ['software'] } })).content as { text: string }[])[0].text);
      const rec = hub.node.store.get(out.id)!.rec;
      expect(rec.context.agent).toEqual({ client: 'Claude Code', model: 'claude-sonnet-4.5' });
      expect(verifyRecord(rec).ok).toBe(true);
      // An older node that doesn't know the field still accepts the record as it was signed.
      expect(verifyRecord(JSON.parse(JSON.stringify(rec))).ok).toBe(true);
      await client.close();
    } finally { delete process.env.CONSTELLATE_HOME; delete process.env.CONSTELLATE_AGENT_MODEL; }
  });

  it('a computer’s agent keeps the name its person gave it when the app restarts', async () => {
    process.env.CONSTELLATE_HOME = mkdtempSync(join(tmpdir(), 'names-'));
    try {
      const hub = new Hub({ signer: LocalSigner.generate(), preview: false });
      const p = new Profiles(hub);
      await p.publishAgent({ handle: 'nicks-lab' });
      await p.publishAgent({ open_to: { messages: true } }); // what the app does on every start
      expect(p.ownAgent()).toMatchObject({ kind: 'agent', handle: 'nicks-lab', open_to: { messages: true } });
      expect((await p.list()).find((x) => x.id === hub.node.agentId)?.handle).toBe('nicks-lab');
      await p.publishAgent({ handle: '' });
      expect(p.ownAgent()?.handle).toBeUndefined(); // cleared
    } finally { delete process.env.CONSTELLATE_HOME; }
  });

  it('"Have your agent work on it" starts Claude Code on the problem and shows each step it answered', async () => {
    const home = mkdtempSync(join(tmpdir(), 'names-'));
    process.env.CONSTELLATE_HOME = home;
    const fake = join(home, 'claude');
    const lines = [
      { type: 'system', subtype: 'init', model: 'claude-sonnet', mcp_servers: [{ name: 'constellate', status: 'connected' }] },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__constellate__work_step', input: { problem: 'x' } }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__constellate__work_step', input: { problem: 'x', step: 'first', answer: '42' } }] } },
      { type: 'result', duration_ms: 4000, total_cost_usd: 0.03 },
    ];
    writeFileSync(fake, `#!/usr/bin/env node\nfor (const l of ${JSON.stringify(lines.map((x) => JSON.stringify(x)))}) console.log(l);\n`);
    chmodSync(fake, 0o755);
    process.env.CONSTELLATE_CLAUDE = fake;
    try {
      const hub = new Hub({ signer: LocalSigner.generate(), preview: false });
      const out = await hub.collective.propose(ProblemBody.parse({ title: 'Small facts', hook: 'Tiny', goal: 'Answer a small question exactly, checked by machine.', realm: 'maths_physics', definition_of_done: { verifier: 'exact', description: 'Matches exactly.' }, chunks: [{ key: 'first', title: 'Six times seven', prompt: 'What is 6 × 7?', check: { expected: '42' }, needs: { size: 'any' } }] }));
      const id = out.problem!.id;
      expect(hub.agentRuns.prompt(id)).toMatch(new RegExp(`work_step.*problem "${id}"`));
      const run = hub.agentRuns.start(id);
      expect(hub.agentRuns.start(id).id).toBe(run.id); // one at a time per problem
      for (let i = 0; i < 100 && hub.agentRuns.get(run.id)!.status === 'running'; i++) await wait(30);
      const r = hub.agentRuns.get(run.id)!;
      expect(r).toMatchObject({ status: 'done', steps: 1 });
      expect(r.log.map((l) => l.text)).toEqual([
        'Starting Claude Code on this computer…',
        'Claude Code started (claude-sonnet) with Constellate connected.',
        'Looked at the open steps.',
        'Answered step “first”; it now waits for a different model family to check it.',
        'Claude Code finished in 4 s (about $0.03 of your Claude usage).',
        'Answered 1 step. Each waits for a computer running a different model family to check it.',
      ]);
    } finally { delete process.env.CONSTELLATE_HOME; delete process.env.CONSTELLATE_CLAUDE; }
  });
});
