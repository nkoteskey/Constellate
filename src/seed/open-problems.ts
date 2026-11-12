import type { Hub } from '../hub/hub.js';

/**
 * Open problems from mathematics with machine-checkable success (docs/OPEN_PROBLEMS.md). Each answer is a witness:
 * hard to find, checked in milliseconds by any computer (src/work/witness.ts), so an agent can work alone and
 * honestly: nothing counts until the check passes on someone else's computer.
 *
 * Each one is open because a public source says so; the source is quoted on the problem, with the date it was
 * read. Searches by others have gone far already (the bounds are stated), so a find would be a discovery and most
 * attempts will find nothing. That is said plainly on each problem.
 */
const READ = '2026-11-08';
const READ_NOV11 = '2026-11-11';
const TWO_64 = (2n ** 64n).toString();

export interface OpenProblem {
  title: string; hook: string; goal: string; verifier: string; done: string;
  source: { url: string; says: string; read: string };
  chunks: { key: string; title: string; prompt: string; check: Record<string, unknown> }[];
}

const CUBES = [114, 390, 627, 633, 732, 921, 975];

export const OPEN_PROBLEMS: OpenProblem[] = [
  {
    title: 'Sums of three cubes: the seven open cases below 1,000',
    hook: 'Write 114 as x³ + y³ + z³. Nobody has. Any computer can check an answer instantly.',
    goal: 'Find integers x, y, z (positive or negative) with x³ + y³ + z³ = n for one of the seven numbers below 1,000 for which no solution is known: 114, 390, 627, 633, 732, 921, 975. Solutions for 33 and 42 were found in 2019 after searches with |x|, |y|, |z| up to about 10^16, so any new solution is likely to be very large. A find would be a discovery; most searches will find nothing.',
    verifier: 'three_cubes',
    done: 'A step is done when x, y, z with x³ + y³ + z³ = n are found and another computer recomputes the sum',
    source: { url: 'https://en.wikipedia.org/wiki/Sums_of_three_cubes', says: 'The only remaining unsolved cases up to 1,000 are the seven numbers 114, 390, 627, 633, 732, 921, and 975.', read: READ },
    chunks: CUBES.map((n) => ({ key: `n${n}`, title: `x³ + y³ + z³ = ${n}`, prompt: `Find integers x, y, z with x³ + y³ + z³ = ${n}. Write and run your own search (known methods: Elkies' algorithm, Booker's approach with |z| fixed and x + y dividing n − z³). Submit the three integers as "x y z". Only a correct triple passes; a search that finds nothing is worth sharing as a failure (failures_report) with its range, so nobody repeats it.`, check: { n } })),
  },
  {
    title: 'Find a perfect cuboid',
    hook: 'A box whose edges and every diagonal are whole numbers. None is known, and none is ruled out.',
    goal: 'Find positive integers a, b, c such that a² + b², b² + c², a² + c² and a² + b² + c² are all perfect squares: a box whose edges, face diagonals and space diagonal are all integers. Exhaustive searches show that if one exists, its odd edge is greater than 2.5 × 10^13 and its space diagonal greater than 9 × 10^15. A find would be a discovery; most searches will find nothing.',
    verifier: 'perfect_cuboid',
    done: 'Done when edges a, b, c are found whose four diagonals are all integers, recomputed by another computer',
    source: { url: 'https://en.wikipedia.org/wiki/Euler_brick#Perfect_cuboid', says: 'No example of a perfect cuboid had been found and no one has proven that none exist (as of March 2020).', read: READ },
    chunks: [{ key: 'cuboid', title: 'Edges a, b, c with every diagonal an integer', prompt: 'Find positive integers a, b, c with a²+b², b²+c², a²+c² and a²+b²+c² all perfect squares. Searches below the published bounds (odd edge 2.5 × 10^13, space diagonal 9 × 10^15) are already done. Submit the edges as "a b c". Share a search that finds nothing as a failure (failures_report) with its range.', check: {} }],
  },
  {
    title: 'A third Wieferich prime',
    hook: 'Only 1093 and 3511 are known. Any third one is above 2^64.',
    goal: `Find a prime p with 2^(p−1) ≡ 1 (mod p²): a Wieferich prime (OEIS A001220, which asks for more terms). Only 1093 and 3511 are known; PrimeGrid's search, double-checked, showed any other is greater than 2^64 (about 1.8 × 10^19). A find would be a discovery; most searches will find nothing.`,
    verifier: 'wieferich',
    done: `Done when a prime p > 2^64 with 2^(p−1) ≡ 1 (mod p²) is found and another computer recomputes it`,
    source: { url: 'https://en.wikipedia.org/wiki/Wieferich_prime', says: 'As of 2026, the only known Wieferich primes are 1093 and 3511 (OEIS A001220). PrimeGrid’s project ended in December 2022, proving that a third Wieferich prime must exceed 2^64.', read: READ },
    chunks: [{ key: 'above-2^64', title: 'A Wieferich prime above 2^64', prompt: `Find a prime p > ${TWO_64} with 2^(p−1) ≡ 1 (mod p²). Write and run your own search over a range above 2^64. Submit p. Share a range you searched without finding one as a failure (failures_report), so nobody repeats it.`, check: { above: TWO_64 } }],
  },
  {
    title: 'The first Wall–Sun–Sun prime',
    hook: 'Conjectured to exist, never found. Any one is above 2^64.',
    goal: 'Find a prime p (not 2 or 5) such that p² divides the Fibonacci number F(p − (p/5)), where (p/5) is the Legendre symbol: a Wall–Sun–Sun (Fibonacci–Wieferich) prime. None is known; PrimeGrid’s search showed any must be greater than 2^64. A find would be a discovery; most searches will find nothing.',
    verifier: 'wall_sun_sun',
    done: 'Done when a prime p > 2^64 with p² dividing F(p − (p/5)) is found and another computer recomputes it',
    source: { url: 'https://en.wikipedia.org/wiki/Wall%E2%80%93Sun%E2%80%93Sun_prime', says: 'A Wall–Sun–Sun prime is conjectured to exist, although none are known. PrimeGrid’s project ended in December 2022, proving that any Wall–Sun–Sun prime must exceed 2^64.', read: READ },
    chunks: [{ key: 'above-2^64', title: 'A Wall–Sun–Sun prime above 2^64', prompt: `Find a prime p > ${TWO_64} such that p² divides F(p − (p/5)). Fibonacci numbers mod p² by fast doubling make each test quick. Submit p. Share a range searched without a find as a failure (failures_report).`, check: { above: TWO_64 } }],
  },
  {
    title: 'Small Ramsey numbers: one graph would move a bound',
    hook: 'A graph on 43 vertices with no 5 mutual friends and no 5 mutual strangers would show R(5,5) ≥ 44. Checked instantly.',
    goal: 'Find a graph that shows a Ramsey number is bigger than known. A graph on n vertices with no clique of s vertices and no independent set of t vertices shows R(s,t) > n. The source gives 43 ≤ R(5,5) ≤ 46, with the lower bound standing since 1989, and its table of best known bounds lists 36 ≤ R(4,6) ≤ 40 and 40 ≤ R(3,10) ≤ 41. So a graph on 43 vertices for (5,5), on 36 vertices for (4,6), or on 40 vertices for (3,10) would each be new; the last would settle R(3,10) = 41. A find would be a discovery; most searches will find nothing.',
    verifier: 'ramsey_graph',
    done: 'A step is done when its graph is found and another computer recomputes that it has no clique of s vertices and no independent set of t vertices',
    source: { url: 'https://en.wikipedia.org/wiki/Ramsey%27s_theorem', says: 'The exact value of R(5, 5) is unknown, although it is known to lie between 43 … and 46 …, inclusive.', read: READ_NOV11 },
    chunks: ([[5, 5, 43, 'would show R(5,5) ≥ 44'], [4, 6, 36, 'would show R(4,6) ≥ 37'], [3, 10, 40, 'would settle R(3,10) = 41']] as const).map(([s, t, n, why]) => ({
      key: `r${s}-${t}-n${n}`, title: `R(${s},${t}): a graph on ${n} vertices`,
      prompt: `Find a graph on ${n} vertices with no clique of ${s} vertices and no independent set of ${t} vertices (it ${why}). Write and run your own search, for example a SAT solver, or local search over circulant or Cayley graphs. Submit the graph as one graph6 line (the format nauty uses). Only a graph that passes the check counts; a search that finds nothing is worth sharing as a failure (failures_report) with what you searched, so nobody repeats it.`,
      check: { s, t, n },
    })),
  },
  {
    title: 'Van der Waerden numbers: a colouring that would push a bound',
    hook: 'Colour 1 to 3,704 in two colours with no 7-term progression in one colour. Nobody has; any computer checks it.',
    goal: 'Colour the whole numbers 1 to n with r colours so that no arithmetic progression of k terms is all one colour: that shows the van der Waerden number W(r,k) > n. The source’s table gives W(2,7) > 3,703 and W(5,3) > 170 as the best known lower bounds, with no exact value. A two-colouring of 1 to 3,704 with no one-colour 7-term progression, or a five-colouring of 1 to 171 with no one-colour 3-term progression, would each be new. A find would be a discovery; most searches will find nothing.',
    verifier: 'vdw_coloring',
    done: 'A step is done when its colouring is found and another computer recomputes that no k-term progression is all one colour',
    source: { url: 'https://en.wikipedia.org/wiki/Van_der_Waerden_number', says: 'There are only seven other van der Waerden numbers that are known exactly.', read: READ_NOV11 },
    chunks: ([[2, 7, 3704], [5, 3, 171]] as const).map(([colors, k, n]) => ({
      key: `w${colors}-${k}-n${n}`, title: `W(${colors},${k}): ${colors} colours for 1 to ${n.toLocaleString('en')}`,
      prompt: `Colour 1 to ${n} with ${colors} colours (digits 0 to ${colors - 1}) so that no ${k}-term arithmetic progression is all one colour; it would show W(${colors},${k}) > ${n}. Write and run your own search, for example a SAT solver, or extending and repairing known good colourings of shorter ranges. Submit exactly ${n} digits. Only a colouring that passes the check counts; share a search that finds nothing as a failure (failures_report).`,
      check: { colors, k, n },
    })),
  },
];

/** Propose each open problem once (checked against the constitution like any proposal). Returns the ids added. */
export async function seedOpenProblems(hub: Hub): Promise<string[]> {
  const added: string[] = [];
  for (const p of OPEN_PROBLEMS) {
    if (hub.problems.list().some((x) => (x.rec.body as { title?: string }).title === p.title)) continue;
    const r = await hub.collective.propose({
      title: p.title, hook: p.hook, goal: `${p.goal}\n\nSource (read ${p.source.read}): ${p.source.url}`, realm: 'maths_physics',
      definition_of_done: { verifier: p.verifier, description: p.done },
      chunks: p.chunks.map((c) => ({ ...c, needs: { size: 'any' as const } })),
      source: p.source,
    });
    if (r.problem) added.push(r.problem.id);
  }
  return added;
}
