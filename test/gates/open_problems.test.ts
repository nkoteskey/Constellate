import { describe, it, expect } from 'vitest';
import { Hub } from '../../src/hub/hub.js';
import { LocalSigner } from '../../src/core/identity.js';
import { MockRunner } from '../../src/contributor/models.js';
import { Worker } from '../../src/work/worker.js';
import { MemoryBoard } from '../../src/work/board.js';
import { openSteps, submitStep } from '../../src/work/agent-step.js';
import { OPEN_PROBLEMS, seedOpenProblems } from '../../src/seed/open-problems.js';
import { threeCubesVerifier, perfectCuboidVerifier, wieferichVerifier, wallSunSunVerifier, isPrime, fibMod, integers } from '../../src/work/witness.js';

/**
 * Problems from science and maths (docs/OPEN_PROBLEMS.md): open problems whose answer is a witness any computer
 * checks in milliseconds, each with its public source, definition of done and verifier, so agents can work on them
 * alone and honestly.
 */
const TWO_64 = (2n ** 64n).toString();

describe('open problems with machine-checkable answers', () => {
  it('the checks accept real witnesses and refuse everything else', async () => {
    // 42 = x³ + y³ + z³ (Booker and Sutherland, 2019): the kind of answer the open cases need.
    expect((await threeCubesVerifier.check({ n: 42 }, 'x y z = -80538738812075974 80435758145817515 12602123297335631')).ok).toBe(true);
    expect((await threeCubesVerifier.check({ n: 114 }, '-80538738812075974 80435758145817515 12602123297335631')).ok).toBe(false);
    expect((await threeCubesVerifier.check({ n: 114 }, 'no solution found')).ok).toBe(false);
    // The smallest Euler brick has integer face diagonals but not an integer space diagonal: not perfect.
    const brick = await perfectCuboidVerifier.check({}, '44 117 240');
    expect(brick).toEqual({ ok: false, detail: 'not a square: a²+b²+c²' });
    expect((await perfectCuboidVerifier.check({}, '0 117 240')).ok).toBe(false);
    // The two known Wieferich primes pass the arithmetic; the open problem asks for one above 2^64.
    expect((await wieferichVerifier.check({ above: 0 }, '1093')).ok).toBe(true);
    expect((await wieferichVerifier.check({ above: 0 }, '3511')).ok).toBe(true);
    expect((await wieferichVerifier.check({ above: 0 }, '1091')).ok).toBe(false);
    expect((await wieferichVerifier.check({ above: TWO_64 }, '3511')).detail).toMatch(/greater than/);
    expect((await wieferichVerifier.check({ above: TWO_64 }, '18446744073709551617')).detail).toMatch(/not prime/); // 2^64 + 1 = 274177 × …
    expect((await wallSunSunVerifier.check({ above: 0 }, '7')).ok).toBe(false);
    expect((await wallSunSunVerifier.check({ above: TWO_64 }, '18446744073709551629')).ok).toBe(false); // a prime above 2^64 that isn't one
  });

  it('the arithmetic underneath is right', () => {
    expect(fibMod(10n, 1000n)).toBe(55n);
    expect(fibMod(100n, 10n ** 30n)).toBe(354224848179261915075n);
    expect(isPrime(2n ** 61n - 1n)).toEqual({ prime: true, proven: true });
    expect(isPrime(2n ** 64n + 1n).prime).toBe(false);
    expect(isPrime(18446744073709551629n)).toEqual({ prime: true, proven: true });
    expect(integers('x = 1,000, y = -2_000 and 3')).toEqual([1000n, -2000n, 3n]);
  });

  it('each problem says why it is open, quoting a public source, with its definition of done and verifier', async () => {
    const hub = new Hub({ signer: LocalSigner.generate(), preview: false });
    const ids = await seedOpenProblems(hub);
    expect(ids).toHaveLength(OPEN_PROBLEMS.length);
    expect(await seedOpenProblems(hub)).toEqual([]); // once
    for (const id of ids) {
      const b = hub.problems.body(id) as ReturnType<Hub['problems']['body']> & { source?: { url: string; says: string; read: string } };
      expect(b.source?.url).toMatch(/^https:\/\/en\.wikipedia\.org\/wiki\//);
      expect(b.source?.says.length).toBeGreaterThan(40);
      expect(b.source?.read).toMatch(/^2026-\d\d-\d\d$/); // each problem carries the date its source was read
      expect(b.source?.read).toBe(OPEN_PROBLEMS.find((p) => p.title === b.title)!.source.read);
      expect(b.goal).toContain(b.source!.url);
      expect(b.goal).toMatch(/A find would be a discovery; most searches will find nothing/);
      expect(hub.problems.verifiers.get(b.definition_of_done.verifier)?.witness).toBe(true);
      expect(hub.collective.constitution.status(id).state).toBe('cleared');
    }
    const cubes = hub.problems.body(ids[0]);
    expect(cubes.chunks.map((c) => c.check.n)).toEqual([114, 390, 627, 633, 732, 921, 975]);
  });

  it('agents take them with work_step and only a passing witness becomes a checkpoint; lent computers don\'t guess', async () => {
    const asker = new Hub({ signer: LocalSigner.generate(), preview: false });
    const [cubes] = await seedOpenProblems(asker);
    const agent = new Hub({ signer: LocalSigner.generate(), preview: false });
    const lender = new Hub({ signer: LocalSigner.generate(), preview: false });
    for (const h of [agent, lender]) for (const s of asker.node.store.all()) h.node.ingest(s.rec);
    expect((await openSteps(agent, { problem: cubes, limit: 7 })).map((s) => s.step)).toContain('n114');

    // A lent computer never spends model calls guessing at an open search.
    let calls = 0;
    const runner = new MockRunner('mock:qwen', 'qwen', 'small', () => { calls++; return '1 2 3'; });
    const worker = new Worker(lender, runner, lender.problems, new MemoryBoard());
    expect(await worker.step(cubes)).toBe('idle');
    expect(calls).toBe(0);

    // An agent's wrong answer is rejected by the machine check on another computer; nothing is accepted on trust.
    const wrong = await submitStep(agent, { problem: cubes, step: 'n114', answer: 'I think 1 2 3', model: 'claude-sonnet-4.5', client: 'claude-code' });
    lender.node.ingest(agent.node.store.get(wrong.result)!.rec);
    expect(await worker.step(cubes)).toBe('rejected');
    expect(lender.node.store.ofKind('checkpoint')).toHaveLength(0);
    expect(calls).toBe(0); // the check is the machine's alone
  });

  it('is documented', async () => {
    const { readFileSync } = await import('node:fs');
    const doc = readFileSync(new URL('../../docs/OPEN_PROBLEMS.md', import.meta.url), 'utf8');
    for (const p of OPEN_PROBLEMS) expect(doc).toContain(p.title);
  });
});
