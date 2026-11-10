import { describe, it, expect } from 'vitest';
import { Hub } from '../../src/hub/hub.js';
import { LocalSigner } from '../../src/core/identity.js';
import { RecordStore } from '../../src/store/records.js';
import { LocalArchive } from '../../src/store/archive.js';
import { MemoryNetwork } from '../../src/transport/bus.js';
import { Problems, ProblemBody, TaskResultBody, CheckpointBody, orderProblem } from '../../src/work/problems.js';
import { MemoryBoard } from '../../src/work/board.js';
import { Worker, runSwarm, LEASE_MS } from '../../src/work/worker.js';
import { MockRunner } from '../../src/contributor/models.js';
import { openSteps, submitStep } from '../../src/work/agent-step.js';

/**
 * Many computers on one problem, with no one in charge: steps open in the order the problem gives (a step waits
 * for the steps it needs), computers that start together spread across the open steps instead of all taking the
 * first one, and a claim that goes quiet (a laptop that slept) reopens after its lease.
 */
const MOD = 1_000_000_007;
const sumSq = (a: number, b: number) => { let s = 0n; for (let i = BigInt(a); i <= BigInt(b); i++) s = (s + i * i) % BigInt(MOD); return s.toString(); };
const solve = (p: string) => { const m = p.match(/from (\d+) to (\d+)/)!; return `The answer is ${sumSq(+m[1], +m[2])}`; };
const answer = (p: string) => (p.includes('You are verifying') ? 'YES' : solve(p));
const step = (i: number, after: string[] = []) => ({ key: `s${i}`, title: `Block ${i}`, prompt: `Compute the sum of i^2 for i from ${i * 100 + 1} to ${(i + 1) * 100}, modulo ${MOD}. End with the number.`, check: { from: i * 100 + 1, to: (i + 1) * 100, mod: MOD }, after });
const problem = (chunks: ReturnType<typeof step>[]) => ({ title: 'Ordered sums', goal: 'Sums of squares, block by block', realm: 'maths_physics' as const, definition_of_done: { verifier: 'sum_squares_mod', description: 'Each block recomputed' }, chunks });

describe('step order', () => {
  it('a problem\'s order must be possible: known steps, no step waiting for itself, no circles', async () => {
    expect(orderProblem([{ key: 'a' }, { key: 'b', after: ['a'] }, { key: 'c', after: ['a', 'b'] }])).toBeNull();
    expect(orderProblem([{ key: 'a', after: ['a'] }])).toMatch(/waits for itself/);
    expect(orderProblem([{ key: 'a', after: ['z'] }])).toMatch(/isn't a step/);
    expect(orderProblem([{ key: 'a', after: ['c'] }, { key: 'b', after: ['a'] }, { key: 'c', after: ['b'] }])).toMatch(/circle: a → c → b → a/);
    const hub = new Hub({ signer: LocalSigner.generate(), store: new RecordStore(), preview: false });
    await expect(new Problems(hub).propose(problem([step(0, ['s1']), step(1, ['s0'])]))).rejects.toThrow(/can't all open/);
  });

  it('a step opens only once the steps it waits for are verified; workers and agents both respect it', async () => {
    const net = new MemoryNetwork(), archive = new LocalArchive(), board = new MemoryBoard();
    const mk = () => new Hub({ signer: LocalSigner.generate(), bus: net.bus(), archive, store: new RecordStore(), preview: false });
    const proposer = mk(), A = mk(), B = mk();
    // Proposed the usual way, through the constitution check, so agents are offered its steps.
    const out = await proposer.collective.propose(ProblemBody.parse(problem([step(0), step(1, ['s0']), step(2, ['s1']), step(3)])));
    const record = out.problem!;
    await new Promise((r) => setTimeout(r, 50));

    const st = await new Problems(A).state(record.id);
    expect(st.chunks.map((c) => [c.key, c.waiting_on])).toEqual([['s0', []], ['s1', ['s0']], ['s2', ['s1']], ['s3', []]]);
    const sum = await new Problems(A).summary(record.id);
    expect(sum.open_calls.find((c) => c.chunk === 's1')).toMatchObject({ waiting_for: 'steps s0 first', after: ['s0'] });
    // An agent sees only open steps, and can't answer a waiting one.
    expect((await openSteps(A, { problem: record.id, limit: 10 })).map((s) => s.step)).toEqual(['s0']); // one per problem, and never a waiting one
    await expect(submitStep(A, { problem: record.id, step: 's2', answer: '1', model: 'm' })).rejects.toThrow(/opens once steps s1 are verified/);

    const wA = new Worker(A, new MockRunner('llama', 'llama', 'small', answer), new Problems(A), board);
    const wB = new Worker(B, new MockRunner('qwen', 'qwen', 'small', answer), new Problems(B), board);
    await runSwarm(record.id, [wA, wB], { maxSteps: 80 });
    const store = A.node.store;
    expect((await new Problems(A).state(record.id)).done).toBe(4);
    const at = (kind: string, chunk: string) => store.referencing(record.id, kind).filter((r) => (r.rec.body as unknown as TaskResultBody | CheckpointBody).chunk === chunk).map((r) => Date.parse(r.rec.created));
    // Every answer to a waiting step came after the step it waits for was verified.
    expect(Math.min(...at('task_result', 's1'))).toBeGreaterThanOrEqual(Math.min(...at('checkpoint', 's0')));
    expect(Math.min(...at('task_result', 's2'))).toBeGreaterThanOrEqual(Math.min(...at('checkpoint', 's1')));
  });
});

describe('many computers at once', () => {
  // Each computer on its own network: they share only the board, as computers do in the moment before
  // each other's results arrive. That's when everyone used to take the first step.
  const isolated = async (n: number, chunks: ReturnType<typeof step>[], opts: { clock?: () => number } = {}) => {
    const board = new MemoryBoard();
    const proposer = new Hub({ signer: LocalSigner.generate(), store: new RecordStore(), preview: false });
    const { record } = await new Problems(proposer).propose(problem(chunks), { publish: true });
    const workers = Array.from({ length: n }, (_, i) => {
      const h = new Hub({ signer: LocalSigner.generate(), store: new RecordStore(), preview: false });
      h.node.ingest(record);
      return new Worker(h, new MockRunner(`m${i}`, `family${i}`, 'small', answer), new Problems(h), board, { random: () => 0, ...opts });
    });
    const took = (w: Worker) => w.hub.node.store.ofKind('task_result').map((r) => (r.rec.body as unknown as TaskResultBody).chunk);
    return { id: record.id, workers, took, board };
  };

  it('computers that start together spread across the open steps instead of all taking the first', async () => {
    const { id, workers, took } = await isolated(4, [step(0), step(1), step(2), step(3)]);
    for (const w of workers) expect(await w.step(id)).toBe('worked');
    expect(workers.map((w) => took(w)[0]).sort()).toEqual(['s0', 's1', 's2', 's3']); // four computers, four steps, no duplicates
  });

  it('a claim that goes quiet reopens after its lease; until then, the step is left to its claimer', async () => {
    let now = 1_000_000;
    const { id, workers, took } = await isolated(2, [step(0)], { clock: () => now });
    const [sleeper, other] = workers;
    expect(await sleeper.step(id)).toBe('worked'); // claims s0, and its result never reaches the other computer
    expect(await other.step(id)).toBe('idle'); // the claim holds
    now += LEASE_MS - 1;
    expect(await other.step(id)).toBe('idle');
    now += 2;
    expect(await other.step(id)).toBe('worked'); // the lease ran out: s0 reopens
    expect(took(other)).toEqual(['s0']);
  });

  it('a restarted computer picks up its own claim at once', async () => {
    const { id, workers, took, board } = await isolated(2, [step(0)]);
    const [me, other] = workers;
    const t = await board.ensure(`[${id.slice(0, 12)}] Block 0`, { problem: id, chunk: 's0', size: 'any' });
    await board.claim(t, me.hub.node.agentId); // claimed before a restart; no result yet
    const restarted = new Worker(me.hub, me.runner, me.problems, board, { random: () => 0 });
    expect(await other.step(id)).toBe('idle'); // someone else's claim holds
    expect(await restarted.step(id)).toBe('worked'); // its own doesn't make it wait
    expect(took(restarted)).toEqual(['s0']);
  });

  it('a rejected answer releases the claim: the claimant had its try', async () => {
    const { id, workers, took, board } = await isolated(2, [step(0)]);
    const [claimant, other] = workers;
    const t = await board.ensure(`[${id.slice(0, 12)}] Block 0`, { problem: id, chunk: 's0', size: 'any' });
    await board.claim(t, claimant.hub.node.agentId);
    expect(await other.step(id)).toBe('idle');
    // The claimant's answer was checked and rejected (as the other computer learns from the network).
    await other.hub.node.submit({ kind: 'verification', context: { task: 'verify', domain: ['maths_physics'], environment: 'm' }, body: { problem: id, chunk: 's0', result: 'f'.repeat(64), ok: false, reason: 'wrong', verifier_family: 'x' }, refs: [id] }, { publish: true });
    expect(await other.step(id)).toBe('worked');
    expect(took(other)).toEqual(['s0']);
  });

  it('random choice: different computers pick different open steps', async () => {
    const picks = new Set<string>();
    for (const r of [0, 0.3, 0.6, 0.9]) {
      const { id, workers, took } = await isolated(1, [step(0), step(1), step(2), step(3)]);
      (workers[0] as unknown as { opts: { random: () => number } }).opts.random = () => r;
      await workers[0].step(id);
      picks.add(took(workers[0])[0]);
    }
    expect(picks.size).toBe(4);
  });
});
