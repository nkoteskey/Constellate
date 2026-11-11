import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Hub } from '../../src/hub/hub.js';
import { LocalSigner } from '../../src/core/identity.js';
import { VerifierRegistry } from '../../src/work/verifiers.js';
import {
  ramseyGraphVerifier, vdwColoringVerifier, golombRulerVerifier, capSetVerifier, satAssignmentVerifier,
  toGraph6, fromGraph6, hasClique, answerText,
} from '../../src/work/combinatorics.js';

/**
 * More machine checks (docs/OPEN_PROBLEMS.md): Ramsey graphs, van der Waerden colourings, Golomb rulers, cap sets
 * and SAT assignments. Each is tested on known answers from the literature and on everything nearby that must fail,
 * and the clique search is cross-checked against brute force.
 */
const paley = (q: number) => { const qr = new Set<number>(); for (let x = 1; x < q; x++) qr.add((x * x) % q); return toGraph6(q, (i, j) => qr.has((j - i + q) % q)); };

describe('more machine checks', () => {
  it('Ramsey: the Paley graph on 17 vertices shows R(4,4) > 17; graphs with a clique or the wrong size fail', async () => {
    expect((await ramseyGraphVerifier.check({ s: 4, t: 4, n: 17 }, paley(17))).ok).toBe(true);
    expect((await ramseyGraphVerifier.check({ s: 3, t: 3, n: 5 }, toGraph6(5, (i, j) => j - i === 1 || j - i === 4))).ok).toBe(true); // the 5-cycle: R(3,3) > 5
    expect((await ramseyGraphVerifier.check({ s: 3, t: 4, n: 17 }, paley(17))).detail).toMatch(/clique of 3/);
    expect((await ramseyGraphVerifier.check({ s: 4, t: 4, n: 18 }, paley(17))).detail).toMatch(/17 vertices; this step needs exactly 18/);
    expect((await ramseyGraphVerifier.check({ s: 5, t: 5, n: 5 }, toGraph6(5, () => true))).detail).toMatch(/clique of 5/);
    expect((await ramseyGraphVerifier.check({ s: 3, t: 3, n: 6 }, toGraph6(6, () => false))).detail).toMatch(/independent set of 3/);
    // Strict format: a fenced answer is fine; extra text, a wrong length or nonzero padding is not.
    expect((await ramseyGraphVerifier.check({ s: 4, t: 4, n: 17 }, '```\n' + paley(17) + '\n```')).ok).toBe(true);
    expect((await ramseyGraphVerifier.check({ s: 4, t: 4, n: 17 }, 'here it is: ' + paley(17))).ok).toBe(false);
    expect((await ramseyGraphVerifier.check({ s: 4, t: 4, n: 17 }, paley(17) + '?')).ok).toBe(false);
    expect(fromGraph6('Bw')).toMatchObject({ n: 3 }); // the triangle: three edge bits then three zero padding bits
    expect(fromGraph6('B~')).toHaveProperty('error'); // the same with its padding bits set
    expect(fromGraph6('B')).toHaveProperty('error'); // too short for 3 vertices
    // Sizes are refused before any work.
    expect((await ramseyGraphVerifier.check({ s: 5, t: 5, n: 5000 }, '?')).detail).toMatch(/n from 2 to 128/);
    expect((await ramseyGraphVerifier.check({ s: 40, t: 5, n: 43 }, '?')).detail).toMatch(/s and t from 3 to 12/);
  });

  it('Ramsey: the clique search agrees with brute force, and a step budget gives the same verdict everywhere', () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let trial = 0; trial < 60; trial++) {
      const n = 6 + (trial % 7), p = 0.3 + (trial % 5) * 0.12, size = 3 + (trial % 3);
      const e: boolean[][] = Array.from({ length: n }, () => Array(n).fill(false));
      for (let j = 1; j < n; j++) for (let i = 0; i < j; i++) e[i][j] = e[j][i] = rnd() < p;
      const g = fromGraph6(toGraph6(n, (i, j) => e[i][j]));
      if ('error' in g) throw new Error(g.error);
      let brute = false;
      for (let m = 0; m < 1 << n && !brute; m++) {
        const vs = [...Array(n).keys()].filter((v) => (m >> v) & 1);
        if (vs.length === size && vs.every((a, x) => vs.slice(x + 1).every((b) => e[a][b]))) brute = true;
      }
      expect(hasClique(g.adj, size)).toBe(brute);
    }
    const g = fromGraph6(paley(61));
    if ('error' in g) throw new Error(g.error);
    expect(hasClique(g.adj, 6, 10)).toBeNull(); // out of budget: refused, never guessed
  });

  it('Ramsey: checks at the size of the R(5,5) search take well under a second', async () => {
    const t0 = Date.now();
    expect((await ramseyGraphVerifier.check({ s: 5, t: 5, n: 37 }, paley(37))).ok).toBe(true); // R(5,5) > 37
    expect((await ramseyGraphVerifier.check({ s: 5, t: 5, n: 41 }, paley(41))).ok).toBe(false);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('van der Waerden: 00110011 shows W(2,3) > 8, and every two-colouring of 1..9 fails (W(2,3) = 9)', async () => {
    expect((await vdwColoringVerifier.check({ colors: 2, k: 3, n: 8 }, '00110011')).ok).toBe(true);
    let passed = 0;
    for (let m = 0; m < 512; m++) if ((await vdwColoringVerifier.check({ colors: 2, k: 3, n: 9 }, m.toString(2).padStart(9, '0'))).ok) passed++;
    expect(passed).toBe(0);
    expect((await vdwColoringVerifier.check({ colors: 2, k: 3, n: 8 }, '0011001')).detail).toMatch(/exactly 8/);
    expect((await vdwColoringVerifier.check({ colors: 2, k: 3, n: 8 }, '00110012')).detail).toMatch(/0 to 1/);
    expect((await vdwColoringVerifier.check({ colors: 2, k: 3, n: 8 }, 'colours: 00110011')).ok).toBe(false);
    expect((await vdwColoringVerifier.check({ colors: 2, k: 7, n: 99_999 }, '0')).detail).toMatch(/n up to/);
    const t0 = Date.now();
    await vdwColoringVerifier.check({ colors: 2, k: 7, n: 3704 }, Array.from({ length: 3704 }, (_, i) => (i * 37) % 7 < 3 ? 0 : 1).join(''));
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('Golomb: the proven-optimal 28-mark ruler (length 585) passes below 586 and not below 585', async () => {
    const r28 = '0 3 15 41 66 95 97 106 142 152 220 221 225 242 295 330 338 354 382 388 402 415 486 504 523 546 553 585';
    expect((await golombRulerVerifier.check({ marks: 28, below: 586 }, r28)).ok).toBe(true);
    expect((await golombRulerVerifier.check({ marks: 28, below: 585 }, r28)).detail).toMatch(/not below 585/);
    expect((await golombRulerVerifier.check({ marks: 5, below: 12 }, '0, 1, 4, 9, 11')).ok).toBe(true);
    expect((await golombRulerVerifier.check({ marks: 4, below: 12 }, '0 1 2 4')).detail).toMatch(/difference 1 appears twice/);
    expect((await golombRulerVerifier.check({ marks: 5, below: 12 }, 'I think 0 1 4 9 11')).ok).toBe(false);
    expect((await golombRulerVerifier.check({ marks: 5, below: 12 }, '1 2 5 10 12')).detail).toMatch(/first mark must be 0/);
  });

  it('cap sets: four points in F_3^2 with no line, and no five points can be', async () => {
    expect((await capSetVerifier.check({ n: 2, size_at_least: 4 }, '00\n01\n10\n11')).ok).toBe(true);
    const all = ['00', '01', '02', '10', '11', '12', '20', '21', '22'];
    let passed = 0;
    for (let m = 0; m < 512; m++) {
      const pts = all.filter((_, i) => (m >> i) & 1);
      if (pts.length === 5 && (await capSetVerifier.check({ n: 2, size_at_least: 5 }, pts.join(' '))).ok) passed++;
    }
    expect(passed).toBe(0);
    expect((await capSetVerifier.check({ n: 2, size_at_least: 3 }, '00 11 22')).detail).toMatch(/on a line/);
    expect((await capSetVerifier.check({ n: 2, size_at_least: 4 }, '00 01 10')).detail).toMatch(/at least 4/);
    expect((await capSetVerifier.check({ n: 2, size_at_least: 2 }, '00 00')).detail).toMatch(/twice/);
    expect((await capSetVerifier.check({ n: 2, size_at_least: 2 }, '00 03')).ok).toBe(false);
  });

  it('SAT: a satisfying assignment passes, nothing satisfies an unsatisfiable CNF, and bad CNF is refused', async () => {
    const cnf = 'c two variables\np cnf 2 3\n1 2 0\n-1 2 0\n1 -2 0\n';
    expect((await satAssignmentVerifier.check({ cnf }, '1 2')).ok).toBe(true);
    expect((await satAssignmentVerifier.check({ cnf }, 's SATISFIABLE\nv 1 2 0')).ok).toBe(true);
    expect((await satAssignmentVerifier.check({ cnf }, '1 -2')).detail).toMatch(/clause 2/);
    expect((await satAssignmentVerifier.check({ cnf }, '1')).detail).toMatch(/1 of 2 variables have no value/);
    expect((await satAssignmentVerifier.check({ cnf }, '1 2 -2')).detail).toMatch(/twice/);
    const unsat = cnf.replace('p cnf 2 3', 'p cnf 2 4') + '-1 -2 0\n';
    for (const a of ['1 2', '1 -2', '-1 2', '-1 -2']) expect((await satAssignmentVerifier.check({ cnf: unsat }, a)).ok).toBe(false);
    expect((await satAssignmentVerifier.check({ cnf: 'p cnf 2 2\n1 2 0\n' }, '1 2')).detail).toMatch(/header says 2 clauses/);
    expect((await satAssignmentVerifier.check({ cnf: 'p cnf 2 1\n1 3 0\n' }, '1 2')).detail).toMatch(/outside 1..2/);
    expect((await satAssignmentVerifier.check({ cnf: 'x'.repeat(40_001) }, '1')).detail).toMatch(/fit in a record/);
  });

  it('answers are the object itself: one code fence allowed, size capped first', () => {
    expect(answerText('```graph6\nBw\n```', 100)).toBe('Bw');
    expect(answerText('x'.repeat(101), 100)).toBeNull();
  });

  it('every check describes its format, and planners and proposers are shown it', async () => {
    const reg = new VerifierRegistry();
    for (const n of reg.names()) expect(reg.get(n)!.shape, n).toBeTruthy();
    for (const n of ['ramsey_graph', 'vdw_coloring', 'golomb_ruler', 'cap_set', 'sat_assignment']) expect(reg.get(n)?.witness, n).toBe(true);
    process.env.CONSTELLATE_HOME = mkdtempSync(join(tmpdir(), 'checkers-'));
    const hub = new Hub({ signer: LocalSigner.generate(), preview: false });
    const { record } = await hub.node.submit({ kind: 'proposal', context: { task: 'idea', domain: ['maths_physics'], environment: 'human (browser)' }, body: { title: 'Bigger cap sets', goal: 'Find a cap set in seven dimensions bigger than any published', done: 'the cap_set check passes', realm: 'maths_physics' } }, { publish: true });
    const req = await hub.planner.start(record.id, 'any_agent');
    const brief = hub.planner.brief(req.id);
    expect(brief).toContain('- ramsey_graph (witness: hard to find, instant to check): check {"s"');
    for (const n of reg.names()) expect(brief, n).toContain(`- ${n}`);
    expect(brief).toMatch(/lent computers don't guess at it/);
  });
});
