import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Hub } from '../../src/hub/hub.js';
import { LocalSigner } from '../../src/core/identity.js';
import { RecordStore } from '../../src/store/records.js';
import { ProblemBody } from '../../src/work/problems.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { graveyard, obstacles } from '../../src/work/graveyard.js';
import { openSteps } from '../../src/work/agent-step.js';
import { WebServer } from '../../src/web/server.js';
import { registerAppRoutes } from '../../src/web/app.js';

/**
 * In memoriam and known obstacles (src/work/graveyard.ts): dead ends, rejected answers, overturned results and
 * struck searches stay on the problem's page. A confirmed refutation earns what a checked step does, and confirmed
 * dead ends are handed to every agent taking a step, with the obstacles the problem was posted with.
 */
describe('in memoriam', () => {
  it('a dead end is listed, credited once someone else confirms it, and becomes a known obstacle', async () => {
    process.env.CONSTELLATE_HOME = mkdtempSync(join(tmpdir(), 'grave-'));
    const store = new RecordStore();
    const me = new Hub({ signer: LocalSigner.generate(), store, preview: false });
    const other = new Hub({ signer: LocalSigner.generate(), store, preview: false });
    const out = await me.collective.propose(ProblemBody.parse({
      title: 'A small fact', hook: 'One step', goal: 'Answer one small question exactly, checked by machine.', realm: 'maths_physics',
      definition_of_done: { verifier: 'exact', description: 'The answer matches exactly.' },
      chunks: [{ key: 'one', title: 'Six times seven', prompt: 'What is 6 × 7?', check: { expected: '42' }, needs: { size: 'any' } }],
      obstacles: [{ says: 'Adding six seven times by hand is slow; multiply.', source: 'https://example.org/notes' }],
    }));
    const problem = out.problem!.id;

    const server = createMcpServer(me);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'claude-code', version: '1' });
    await Promise.all([server.connect(a), client.connect(b)]);
    const call = async (args: Record<string, unknown>) => {
      const r = await client.callTool({ name: 'work_step', arguments: args });
      const text = (r.content as { text: string }[])[0].text;
      return r.isError ? { error: text } : JSON.parse(text);
    };
    expect((await call({ problem, dead_end: 'x', answer: 'y' })).error).toMatch(/say what the approach was/);
    const r = await call({ problem, step: 'one', dead_end: 'Guess a random number near forty', answer: 'Guessing gives the wrong number almost every time; the check is exact.', model: 'claude-sonnet-4.5' });
    expect(r.reported).toMatch(/^[0-9a-f]{64}$/);

    let g = graveyard(me, problem);
    expect(g).toEqual([expect.objectContaining({ kind: 'dead_end', step: 'one', what: 'Guess a random number near forty', credited: false })]);
    expect(obstacles(me, problem).map((o) => o.from)).toEqual(['posted']); // not confirmed yet
    await other.collective.pledge(10); await me.collective.pledge(10);
    const before = me.collective.refuted(me.node.operatorId);
    expect(before).toBe(0);

    await other.confirm(r.reported, { note: 'Tried it: wrong every time.' }, { publish: true });
    g = graveyard(me, problem);
    expect(g[0]).toMatchObject({ credited: true, confirmed_by: 1 });
    expect(me.collective.refuted(me.node.operatorId)).toBe(0.25); // same as a verified result
    expect(me.collective.voteWeight(me.node.operatorId)).toBeGreaterThan(0);
    const known = obstacles(me, problem);
    expect(known.map((o) => o.from)).toEqual(['posted', 'dead_end']);
    const steps = await openSteps(other, { by: 'here:Cursor' });
    expect(steps[0].known_obstacles).toEqual([expect.stringMatching(/multiply/), expect.stringMatching(/^Guess a random number near forty: Guessing/)]);

    // A rejected answer is kept too, with its reason.
    const res = await other.node.submit({ kind: 'task_result', context: { task: 't', domain: ['maths_physics'], environment: 'm' }, body: { problem, chunk: 'one', output: '41', model: 'm', family: 'gemini' }, refs: [problem] }, { publish: true });
    await me.node.submit({ kind: 'verification', context: { task: 'v', domain: ['maths_physics'], environment: 'm' }, body: { problem, chunk: 'one', result: res.record.id, ok: false, reason: 'expected 42', verifier_family: 'claude' }, refs: [problem, res.record.id] }, { publish: true });
    expect(graveyard(me, problem).find((x) => x.kind === 'rejected')).toMatchObject({ step: 'one', what: '41', why: 'expected 42' });

    // On the problem's page.
    const web = new WebServer(me); registerAppRoutes(web); await web.listen(0);
    try {
      const page = await (await fetch(`${web.url}/api/problems/${problem}/page`)).json();
      expect(page.obstacles).toHaveLength(2);
      expect(page.graveyard.map((x: { kind: string }) => x.kind).sort()).toEqual(['dead_end', 'rejected']);
    } finally { await web.close(); }
  });
});
