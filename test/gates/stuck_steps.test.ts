import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Hub } from '../../src/hub/hub.js';
import { LocalSigner } from '../../src/core/identity.js';
import { ProblemBody } from '../../src/work/problems.js';
import { StepLeases, MAX_ON_A_STEP } from '../../src/work/step-leases.js';
import { openSteps, submitStep } from '../../src/work/agent-step.js';

/**
 * Stuck steps (docs/OPEN_PROBLEMS.md): an agent asking for work is handed one step and holds it. Nobody else is
 * handed it while it's fresh; after 5 minutes without an answer a second agent joins, after 10 a third, never more.
 * A hold nobody answered lapses after 30 minutes. Someone else answering first doesn't waste a holder's work.
 */
describe('stuck steps get more help', () => {
  it('one agent, then a second at 5 minutes, a third at 10, never a fourth; lapses at 30', () => {
    let now = 0;
    const l = new StepLeases(() => now);
    expect(l.take('p', 's', 'a')).toEqual({ seat: 1, of: 1 });
    expect(l.take('p', 's', 'b')).toBeNull(); // fresh: nobody else
    now = 4 * 60_000; expect(l.take('p', 's', 'b')).toBeNull();
    now = 5 * 60_000; expect(l.take('p', 's', 'b')).toMatchObject({ seat: 2, joined_because: expect.stringMatching(/no answer for 5 minutes.*agent 2 of at most 3/) });
    expect(l.take('p', 's', 'c')).toBeNull();
    now = 10 * 60_000; expect(l.take('p', 's', 'c')).toMatchObject({ seat: 3 });
    now = 20 * 60_000; expect(l.take('p', 's', 'd')).toBeNull(); // three at most
    expect(l.on('p', 's')).toHaveLength(MAX_ON_A_STEP);
    expect(l.take('p', 's', 'a')).toMatchObject({ seat: 1 }); // holding it already
    now = 30 * 60_000; expect(l.take('p', 's', 'd')).toEqual({ seat: 1, of: 1 }); // nobody answered: starts over
  });

  it('an answer stops new agents joining', () => {
    let now = 0;
    const l = new StepLeases(() => now);
    l.take('p', 's', 'a'); l.answered('p', 's', 'a');
    now = 12 * 60_000; expect(l.take('p', 's', 'b')).toBeNull();
  });

  it('through work_step: two agents on one computer, escalation, and a late answer still counts', async () => {
    process.env.CONSTELLATE_HOME = mkdtempSync(join(tmpdir(), 'stuck-'));
    let now = Date.parse('2026-11-25T10:00:00Z');
    const hub = new Hub({ signer: LocalSigner.generate(), preview: false });
    hub.stepLeases = new StepLeases(() => now);
    const out = await hub.collective.propose(ProblemBody.parse({
      title: 'Two small facts', hook: 'Two steps', goal: 'Answer two small questions exactly, each checked by machine.', realm: 'maths_physics',
      definition_of_done: { verifier: 'exact', description: 'Each answer matches exactly.' },
      chunks: [{ key: 'one', title: 'Six times seven', prompt: 'What is 6 × 7?', check: { expected: '42' }, needs: { size: 'any' } },
        { key: 'two', title: 'Two to the tenth', prompt: 'What is 2^10?', check: { expected: '1024' }, needs: { size: 'any' } }],
    }));
    const problem = out.problem!.id;
    const a = await openSteps(hub, { by: 'here:Claude Code' });
    expect(a[0]).toMatchObject({ step: 'one', yours: expect.stringMatching(/Yours for now/) });
    expect((await openSteps(hub, { by: 'here:Claude Code' }))[0].step).toBe('one'); // asking again: the same step
    const b = await openSteps(hub, { by: 'here:Cursor' });
    expect(b[0]).toMatchObject({ step: 'two' }); // the other agent gets the free step, not a copy

    now += 6 * 60_000; // nobody answered "one" for 6 minutes
    await submitStep(hub, { problem, step: 'two', answer: '1024', by: 'here:Cursor' });
    const c = await openSteps(hub, { by: 'here:Cursor' });
    expect(c[0]).toMatchObject({ step: 'one', yours: expect.stringMatching(/no answer for 6 minutes/), others_on_it: 1 });

    // The first holder answers; the second's answer is still taken (no wasted work), a third isn't.
    await submitStep(hub, { problem, step: 'one', answer: '42', by: 'here:Claude Code' });
    await expect(submitStep(hub, { problem, step: 'one', answer: '42', by: 'here:Claude Code' })).rejects.toThrow(/you already answered/);
    await expect(submitStep(hub, { problem, step: 'one', answer: '42', by: 'here:Cursor' })).resolves.toMatchObject({ result: expect.any(String) });
    await expect(submitStep(hub, { problem, step: 'one', answer: '42', by: 'here:Gemini CLI' })).rejects.toThrow(/already answered/);
    expect((await hub.problems.state(problem)).chunks.find((x) => x.key === 'one')!.pending).toHaveLength(2);
  });
});
