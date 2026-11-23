import { createHash } from 'node:crypto';
import type { Verifier } from './verifiers.js';
import { SECOND_CHECKERS, type Check } from './second-checkers.js';

/**
 * Testing the checkers themselves (docs/RESULTS.md). Before a check is trusted on an open problem it must accept
 * answers known to be right and reject planted errors: one changed digit, a wrong size, a near miss. Both checkers
 * (the first and the separately written second) run on every control, in the gate test and in `constellate
 * checkers`, and must give the same verdict.
 *
 * Versions: every checker has a version, and each problem records the version it was posted with
 * (definition_of_done.checker, e.g. "three_cubes@1"); every checkpoint records the one that passed it. Changing a
 * check's code means raising its version (the gate test compares a fingerprint of the code), and every control,
 * old and new, must still give the same verdict, so a past verdict can't silently flip. If a later checker rejects
 * an earlier answer anyway, the result says the checkers disagree instead of quietly dropping it.
 */
export interface Control { check: Record<string, unknown>; answer: string; why: string }
export interface Controls { good: Control[]; planted: Control[]; /** A tool the check runs (its good controls are skipped where it isn't installed). */ requires?: string; /** Said plainly when no correct answer is known to test with. */ no_known_answer?: string }

/** Raise when a check's verdict-affecting code changes (the gate test catches a change without a raise). */
export const CHECKER_VERSIONS: Record<string, number> = {
  exact: 1, sum_squares_mod: 1, lean: 1, lean_project: 1,
  three_cubes: 1, perfect_cuboid: 1, wieferich: 1, wall_sun_sun: 1,
  ramsey_graph: 1, vdw_coloring: 1, golomb_ruler: 1, cap_set: 1, sat_assignment: 1, hadamard_gs: 1, unsat_drat: 1,
};
export const checkerId = (name: string) => `${name}@${CHECKER_VERSIONS[name] ?? 1}`;
/** A fingerprint of a check's code, compared with the pinned one in the gate test. */
export const fingerprint = (f: (...a: never[]) => unknown) => createHash('sha256').update(f.toString().replace(/\s+/g, ' ')).digest('hex').slice(0, 16);

const paley17 = 'PzlXWmJpZDeJEJbDgp\\EJsWk'; // the Paley graph on 17 vertices: R(4,4) > 17
const cycle5 = 'Dhc'; // the 5-cycle: R(3,3) > 5
const k5 = 'D~{'; // the complete graph on 5 vertices
const tiny = 'p cnf 3 2\n1 -2 0\n2 3 0\n';

export const CONTROLS: Record<string, Controls> = {
  exact: {
    good: [{ check: { expected: '42' }, answer: 'The answer is 42', why: 'ends with the value' }],
    planted: [{ check: { expected: '42' }, answer: '41', why: 'one digit off' }, { check: { expected: '42' }, answer: '42 is it? no, 24', why: 'right value, not last' }],
  },
  lean: {
    requires: 'lean',
    good: [{ check: { statement: 'theorem two : 1 + 1 = 2' }, answer: 'theorem two : 1 + 1 = 2 := rfl', why: 'a one-line proof' }],
    planted: [{ check: { statement: 'theorem two : 1 + 1 = 2' }, answer: 'theorem two : 1 + 1 = 2 := by sorry', why: 'sorry' }, { check: { statement: 'theorem two : 1 + 1 = 2' }, answer: 'theorem one : 1 = 1 := rfl', why: 'proves something else' }],
  },
  lean_project: {
    requires: 'lake',
    good: [],
    planted: [{ check: { repo: 'https://example.com/not-reviewed', commit: 'abc', module: 'X', theorems: ['t'] }, answer: '{}', why: 'not a reviewed project' }],
    no_known_answer: 'Its known answers are full Lean builds of reviewed projects (test/gates/lean_project.test.ts); here only a planted request is tested.',
  },
  sum_squares_mod: {
    good: [{ check: { from: 1, to: 10, mod: 7 }, answer: '385 mod 7 is 0', why: '1² + … + 10² = 385' }],
    planted: [{ check: { from: 1, to: 10, mod: 7 }, answer: '385', why: 'not reduced' }],
  },
  three_cubes: {
    good: [
      { check: { n: 42 }, answer: '-80538738812075974 80435758145817515 12602123297335631', why: 'Booker and Sutherland, 2019' },
      { check: { n: 33 }, answer: '8866128975287528 -8778405442862239 -2736111468807040', why: 'Booker, 2019' },
      { check: { n: 3 }, answer: '4 4 -5', why: 'the small classical solution' },
    ],
    planted: [
      { check: { n: 42 }, answer: '-80538738812075974 80435758145817515 12602123297335632', why: 'one digit changed' },
      { check: { n: 114 }, answer: '-80538738812075974 80435758145817515 12602123297335631', why: 'right triple, wrong n' },
      { check: { n: 3 }, answer: '4 4', why: 'two numbers only' },
    ],
  },
  perfect_cuboid: {
    good: [],
    planted: [
      { check: {}, answer: '44 117 240', why: 'the smallest Euler brick: face diagonals whole, space diagonal not' },
      { check: {}, answer: '3 4 12', why: 'two face diagonals not whole' },
      { check: {}, answer: '0 3 4', why: 'an edge of 0' },
    ],
    no_known_answer: 'No perfect cuboid is known, so only planted near misses test this check.',
  },
  wieferich: {
    good: [{ check: { above: 0 }, answer: '1093', why: 'the first Wieferich prime' }, { check: { above: 1093 }, answer: '3511', why: 'the second' }],
    planted: [
      { check: { above: 0 }, answer: '1097', why: 'prime, not Wieferich' },
      { check: { above: 2000 }, answer: '1093', why: 'Wieferich, but below the bound' },
      { check: { above: 0 }, answer: '3837523', why: '1093 · 3511: composite' },
    ],
  },
  wall_sun_sun: {
    good: [],
    planted: [
      { check: { above: 0 }, answer: '1093', why: 'prime, not Wall–Sun–Sun' },
      { check: { above: 0 }, answer: '5', why: 'excluded' },
      { check: { above: 0 }, answer: '1001', why: 'composite' },
    ],
    no_known_answer: 'No Wall–Sun–Sun prime is known, so only planted errors test this check.',
  },
  ramsey_graph: {
    good: [{ check: { s: 4, t: 4, n: 17 }, answer: paley17, why: 'the Paley graph on 17 vertices' }, { check: { s: 3, t: 3, n: 5 }, answer: cycle5, why: 'the 5-cycle' }],
    planted: [
      { check: { s: 3, t: 4, n: 17 }, answer: paley17, why: 'it has triangles' },
      { check: { s: 4, t: 4, n: 18 }, answer: paley17, why: 'wrong number of vertices' },
      { check: { s: 3, t: 3, n: 5 }, answer: k5, why: 'complete: has a triangle' },
    ],
  },
  vdw_coloring: {
    good: [{ check: { colors: 2, k: 3, n: 8 }, answer: '00110011', why: 'W(2,3) = 9' }],
    planted: [
      { check: { colors: 2, k: 3, n: 9 }, answer: '001100110', why: 'no colouring of 1..9 avoids it' },
      { check: { colors: 2, k: 3, n: 8 }, answer: '00010011', why: '2, 3, 4 one colour' },
      { check: { colors: 2, k: 3, n: 8 }, answer: '00120011', why: 'a third colour' },
    ],
  },
  golomb_ruler: {
    good: [{ check: { marks: 5, below: 12 }, answer: '0 1 4 9 11', why: 'an optimal 5-mark ruler' }],
    planted: [
      { check: { marks: 4, below: 10 }, answer: '0 1 2 4', why: 'difference 1 twice' },
      { check: { marks: 5, below: 11 }, answer: '0 1 4 9 11', why: 'too long' },
      { check: { marks: 5, below: 12 }, answer: '1 2 5 10 12', why: 'does not start at 0' },
    ],
  },
  cap_set: {
    good: [{ check: { n: 2, size_at_least: 4 }, answer: '00 01 10 11', why: 'a largest cap in F_3^2' }],
    planted: [
      { check: { n: 2, size_at_least: 3 }, answer: '00 01 02', why: 'three on a line' },
      { check: { n: 2, size_at_least: 5 }, answer: '00 01 10 11', why: 'too few points' },
      { check: { n: 2, size_at_least: 2 }, answer: '00 00', why: 'a repeated point' },
    ],
  },
  sat_assignment: {
    good: [{ check: { cnf: tiny }, answer: 'v 1 2 -3 0', why: 'satisfies both clauses' }],
    planted: [
      { check: { cnf: tiny }, answer: '-1 2 3', why: 'clause 1 false' },
      { check: { cnf: tiny }, answer: '1 2', why: 'a variable missing' },
    ],
  },
  unsat_drat: {
    good: [
      { check: { cnf: 'p cnf 2 4\n1 2 0\n1 -2 0\n-1 2 0\n-1 -2 0\n' }, answer: '1 0\n0', why: 'all four clauses on two variables' },
      { check: { cnf: 'p cnf 6 9\n1 2 0\n3 4 0\n5 6 0\n-1 -3 0\n-1 -5 0\n-3 -5 0\n-2 -4 0\n-2 -6 0\n-4 -6 0\n' }, answer: '-1 0\n-2 0\n0', why: 'three pigeons, two holes' },
    ],
    planted: [
      { check: { cnf: 'p cnf 6 9\n1 2 0\n3 4 0\n5 6 0\n-1 -3 0\n-1 -5 0\n-3 -5 0\n-2 -4 0\n-2 -6 0\n-4 -6 0\n' }, answer: '0', why: 'the empty clause straight away' },
      { check: { cnf: 'p cnf 6 9\n1 2 0\n3 4 0\n5 6 0\n-1 -3 0\n-1 -5 0\n-3 -5 0\n-2 -4 0\n-2 -6 0\n-4 -6 0\n' }, answer: 'd 1 2 0\n-1 0\n-2 0\n0', why: 'deletes a clause the proof needs' },
      { check: { cnf: 'p cnf 6 8\n1 2 0\n3 4 0\n5 6 0\n-1 -3 0\n-1 -5 0\n-3 -5 0\n-2 -4 0\n-2 -6 0\n' }, answer: '-1 0\n-2 0\n0', why: 'a satisfiable formula' },
      { check: { cnf: 'p cnf 6 9\n1 2 0\n3 4 0\n5 6 0\n-1 -3 0\n-1 -5 0\n-3 -5 0\n-2 -4 0\n-2 -6 0\n-4 -6 0\n' }, answer: '-7 0\n0', why: 'a variable outside the formula' },
    ],
  },
  hadamard_gs: {
    good: [
      { check: { n: 4 }, answer: '+\n+\n+\n-', why: 'order 4' },
      { check: { n: 12 }, answer: '+++\n+--\n+--\n+--', why: 'Williamson, order 12' },
      { check: { n: 20 }, answer: '-++++\n-++++\n--+++\n-+-++', why: 'order 20, found by exhaustive search' },
      { check: { n: 28 }, answer: '-++++++\n---++++\n--++-++\n-+-+-++', why: 'order 28, found by exhaustive search' },
    ],
    planted: [
      { check: { n: 28 }, answer: '+++++++\n---++++\n--++-++\n-+-+-++', why: 'one sign flipped' },
      { check: { n: 24 }, answer: '-++++++\n---++++\n--++-++\n-+-+-++', why: 'wrong length' },
      { check: { n: 20 }, answer: '-++++\n-++++\n--+++', why: 'three lines' },
    ],
  },
};

export interface ControlReport { name: string; version: string; second: boolean; passed: number; failures: string[]; no_known_answer?: string; skipped?: string }

/** Runs a checker's controls through it and its second checker (if any): good must pass, planted must fail, both alike. */
export async function runControls(v: Verifier, controls = CONTROLS[v.name], second: Check | undefined = SECOND_CHECKERS[v.name], opts: { hasTool?: (t: string) => boolean } = {}): Promise<ControlReport> {
  const failures: string[] = [];
  let passed = 0;
  if (!controls) return { name: v.name, version: checkerId(v.name), second: !!second, passed, failures: ['no controls yet'] };
  const skipGood = !!controls.requires && !opts.hasTool?.(controls.requires);
  for (const [want, list] of [[true, skipGood ? [] : controls.good], [false, controls.planted]] as const) for (const c of list) {
    const a = await v.check(c.check, c.answer);
    const b = second ? await second(c.check, c.answer) : null;
    if (a.ok !== want) failures.push(`${v.name}: ${want ? 'rejected a known answer' : 'accepted a planted error'} (${c.why}): ${a.detail}`);
    else if (b && b.ok !== want) failures.push(`second ${v.name}: ${want ? 'rejected a known answer' : 'accepted a planted error'} (${c.why}): ${b.detail}`);
    else passed++;
  }
  return { name: v.name, version: checkerId(v.name), second: !!second, passed, failures, ...(skipGood ? { skipped: `known answers need ${controls.requires}, not installed here` } : {}), ...(controls.no_known_answer ? { no_known_answer: controls.no_known_answer } : {}) };
}
