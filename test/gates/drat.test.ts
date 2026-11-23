import { describe, it, expect } from 'vitest';
import { unsatDratVerifier, parseDrat } from '../../src/work/drat.js';
import { SECOND_CHECKERS } from '../../src/work/second-checkers.js';
import { CONTROLS, runControls } from '../../src/work/checker-controls.js';

/**
 * Proofs that nothing exists (#31): a DRAT proof that a formula has no satisfying assignment, checked forward with a
 * fixed budget by two separately written checkers. A small unsatisfiable formula with its proof passes; a tampered
 * proof, a satisfiable formula or a proof that deletes what it needs fails; the two checkers agree on random cases.
 */
const cnf = (vars: number, cls: number[][]) => `p cnf ${vars} ${cls.length}\n${cls.map((c) => `${c.join(' ')} 0`).join('\n')}\n`;

describe('proofs that nothing exists (DRAT)', () => {
  it('a small unsatisfiable formula with its proof passes; tampered proofs fail; both checkers agree', async () => {
    const r = await runControls(unsatDratVerifier);
    expect(r.failures).toEqual([]);
    expect(r.second).toBe(true);
    expect(CONTROLS.unsat_drat.good.length).toBeGreaterThan(1);
    // Format errors are refused before any work.
    expect(parseDrat('1 2')).toHaveProperty('error');
    expect(parseDrat('1 d 2 0')).toHaveProperty('error');
    expect((await unsatDratVerifier.check({ cnf: 'nope' }, '0')).ok).toBe(false);
  });

  it('the two checkers give the same verdict on random formulas and random proofs', async () => {
    let seed = 5;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % n; };
    const lit = (v: number) => (1 + rnd(v)) * (rnd(2) ? 1 : -1);
    let proved = 0;
    for (let t = 0; t < 300; t++) {
      const v = 2 + rnd(3);
      const cls = Array.from({ length: 8 + rnd(16) }, () => [...new Set(Array.from({ length: 1 + rnd(3) }, () => lit(v)))]);
      const lines = Array.from({ length: rnd(5) }, () => `${rnd(5) === 0 ? 'd ' : ''}${[...new Set(Array.from({ length: 1 + rnd(2) }, () => lit(v)))].join(' ')} 0`);
      const proof = [...lines, '0'].join('\n');
      const spec = { cnf: cnf(v, cls) };
      const a = await unsatDratVerifier.check(spec, proof), b = await SECOND_CHECKERS.unsat_drat(spec, proof);
      expect(b.ok, `${spec.cnf}\n---\n${proof}\nfirst: ${a.detail} / second: ${b.detail}`).toBe(a.ok);
      if (a.ok) proved++;
    }
    expect(proved).toBeGreaterThanOrEqual(5); // the random cases include real proofs, not only failures (fixed seed)
  });
});
