import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Hub } from '../../src/hub/hub.js';
import { LocalSigner } from '../../src/core/identity.js';
import { RecordStore } from '../../src/store/records.js';
import { MemoryBoard } from '../../src/work/board.js';
import { Worker } from '../../src/work/worker.js';
import { MockRunner } from '../../src/contributor/models.js';
import { ProblemBody } from '../../src/work/problems.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { agentFamily } from '../../src/work/agent-step.js';

/**
 * A connected agent takes a step of a live problem (work_step): it sees the step's prompt and how it's checked,
 * never the check itself; its answer is published like a lent computer's, and only a computer running a
 * different model family can verify it into a checkpoint.
 */
describe('a connected agent works on a step', () => {
  it('finds an open step, answers it, and a different model family verifies it', async () => {
    process.env.CONSTELLATE_HOME = mkdtempSync(join(tmpdir(), 'step-'));
    try {
      const store = new RecordStore();
      const agentHub = new Hub({ signer: LocalSigner.generate(), store, preview: false }); // the agent's computer
      const lent = new Hub({ signer: LocalSigner.generate(), store, preview: false }); // someone's lent computer
      const out = await agentHub.collective.propose(ProblemBody.parse({
        title: 'Small facts, checked', hook: 'Two tiny steps', goal: 'Answer two small questions exactly, each checked by machine.', realm: 'maths_physics',
        definition_of_done: { verifier: 'exact', description: 'Each answer matches exactly.' },
        chunks: [{ key: 'first', title: 'Six times seven', prompt: 'What is 6 × 7? Reply with the number only.', check: { expected: '42' }, needs: { size: 'any' } },
          { key: 'second', title: 'Two to the tenth', prompt: 'What is 2^10? Reply with the number only.', check: { expected: '1024' }, needs: { size: 'any' } }],
      }));
      const problem = out.problem!.id;

      const server = createMcpServer(agentHub);
      const [a, b] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'claude-code', version: '1' });
      await Promise.all([server.connect(a), client.connect(b)]);
      expect((await client.listTools()).tools.map((t) => t.name)).toContain('work_step'); // in the default, lean set
      const call = async (args: Record<string, unknown>) => {
        const r = await client.callTool({ name: 'work_step', arguments: args });
        const text = (r.content as { text: string }[])[0].text;
        return r.isError ? { error: text } : JSON.parse(text);
      };

      const open = await call({});
      expect(open.open).toHaveLength(1);
      expect(open.open[0]).toMatchObject({ problem, step: 'first', title: 'Six times seven', prompt: 'What is 6 × 7? Reply with the number only.' });
      expect(JSON.stringify(open)).not.toMatch(/"42"|expected/); // the check (it holds the answer) is never shown

      const sent = await call({ problem, step: 'first', answer: '42', model: 'claude-sonnet-4.5' });
      expect(sent.submitted).toMatch(/^[0-9a-f]{64}$/);
      expect(store.get(sent.submitted)!.rec.body).toMatchObject({ chunk: 'first', output: '42', family: 'claude' });
      expect((await call({ problem, step: 'first', answer: '42' })).error).toMatch(/already answered/);
      expect((await call({})).open[0].step).toBe('second'); // the next open step
      expect((await call({})).yours[0]).toMatchObject({ step: 'first', status: 'waiting for a check' });

      // A second answer, this one wrong.
      const second = await call({ problem, step: 'second', answer: '1000', model: 'claude-sonnet-4.5' });
      expect(second).toMatchObject({ submitted: expect.any(String) });

      // Another Claude can't verify either answer; a different family can, and the wrong one is rejected.
      const sameFamily = new Worker(lent, new MockRunner('claude-haiku', 'claude', 'small', () => 'YES'), lent.problems, new MemoryBoard());
      expect(await sameFamily.step(problem)).toBe('idle');
      const other = new Worker(lent, new MockRunner('qwen3', 'qwen', 'small', () => 'YES'), lent.problems, new MemoryBoard());
      expect(await other.step(problem)).toBe('verified');
      expect(await other.step(problem)).toBe('rejected');
      const mine = (await call({})).yours as { step: string; status: string; reason?: string }[];
      expect(mine.find((y) => y.step === 'first')).toMatchObject({ status: 'verified' });
      expect(mine.find((y) => y.step === 'second')).toMatchObject({ status: 'rejected', reason: expect.any(String) });
      await client.close();
    } finally { delete process.env.CONSTELLATE_HOME; }
  });

  it('an answer counts as the family of the model that wrote it', () => {
    expect(agentFamily('claude-opus-4', 'cursor')).toBe('claude');
    expect(agentFamily('gpt-5', 'claude-code')).toBe('openai');
    expect(agentFamily(undefined, 'claude-code')).toBe('claude');
    expect(agentFamily(undefined, 'some-tool')).toBe('agent');
  });
});
