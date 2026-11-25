import type { OpenProblem } from './open-problems.js';

/**
 * Example problems, three per realm where a built-in checker exists (docs/CHECKERS.md): one that helps every field,
 * the field's most ambitious, and one within reach. Each is open because a public source says so, quoted with the
 * date it was read. The others chosen (life sciences, planet and energy, art, the Lean ones) wait for their
 * checkers: docs/EXAMPLE_PROBLEMS.md.
 *
 * Records named here are described, never credited to a person: people are named only by @handle or organisation.
 */
const READ = '2026-11-25';

/** The front-page problem: famous, instantly checkable, with real records on the way to the summit. */
export const FRONT_PAGE_TITLE = 'Multiply 4×4 matrices with 47 multiplications';

const MM_FORMAT = 'Give the scheme as JSON {"U", "V", "W"}: product t multiplies (Σ U[t][i·m+j]·A[i][j]) by (Σ V[t][j·p+k]·B[j][k]), and C[i][k] = Σ W[t][i·p+k]·product t. Entries are integers or exact fractions written "a/b"; no decimals. The catalogue’s files use a different layout (column-major, W transposed), so convert before submitting.';
const mm = (n: number, m: number, p: number, below: number, ring: 'Q' | 'Z', why: string) => ({
  key: `mm-${n}x${m}x${p}${ring === 'Z' ? '-z' : ''}`,
  title: `⟨${n}×${m}×${p}⟩ with ${below - 1} multiplications${ring === 'Z' ? ', integer coefficients' : ''}`,
  prompt: `Find a way to multiply an ${n}×${m} matrix by an ${m}×${p} one with at most ${below - 1} multiplications, ${ring === 'Z' ? 'using only integer coefficients' : 'with rational coefficients'}. ${why} Write and run your own search: flip-graph walks between schemes, alternating least squares then rounding to exact values, or SAT. ${MM_FORMAT}`,
  check: { n, m, p, rank_below: below, ring },
});

const code = (q: number, n: number, k: number, d: number, upper: number, url: string, poly?: number[]) => ({
  key: `code-${q}-${n}-${k}`,
  title: `[${n},${k}] over GF(${q}) with distance ${d}`,
  prompt: `Find a linear code of length ${n} and dimension ${k} over GF(${q}) with minimum distance at least ${d}. The tables give ${d - 1} as the best known and ${upper} as the upper bound (${url}, read ${READ}), so this is one better than known. Recent wins came from searching quasi-cyclic codes and extending them, checked by enumerating every codeword. Give a ${k}×${n} generator matrix, one row per line, elements 0 to ${q - 1} separated by spaces${poly ? `; GF(${q}) elements are polynomials over GF(2) modulo ${JSON.stringify(poly)} (coefficients low to high), written as the number whose binary digits are the coefficients` : ''}.`,
  check: { q, n, k, d_at_least: d, ...(poly ? { poly } : {}) },
});

const sorter = (n: number, lower: number, upper: number) => ({
  key: `sort-${n}`,
  title: `Sort ${n} inputs with ${upper - 1} comparators`,
  prompt: `Find a sorting network on ${n} wires with at most ${upper - 1} comparators. The best known uses ${upper}; the best lower bound is ${lower} (source table, read ${READ}). Known approaches: prefix-based search (fix a good first layer, then search the rest), evolutionary search, SAT on the remainder. Give the comparators in order as pairs of wires numbered 0 to ${n - 1}, e.g. "(0,1) (2,3) (0,2)"; each puts the smaller value on the lower wire. The check runs all ${2 ** n} zero-one inputs.`,
  check: { n, below: upper },
});

const ARGMAP_FORMAT = 'Give the map as JSON {"question", "nodes": [{"id", "parent", "type", "claim", "cites": [{"url", "quote"}], "crux"?}]}: positions answer the question (parent "root"); pros and cons sit under a position; objections under any node; replies under an objection. Every pro, con, objection and reply cites a public source with a quote of at most 300 characters. Name people only by a public handle or an organisation, never a personal name: refer to works by title. The machine checks structure only; a model from another family judges fairness, then people rate it.';
const mapSteps = (question: string, extra: { key: string; title: string; prompt: string; check: Record<string, unknown> }[]) => [
  { key: 'positions', title: 'The main positions, each with its strongest pro and con', prompt: `Map the main positions on: "${question}" Five to twelve positions, distinct, each with at least one pro and one con from published work. ${ARGMAP_FORMAT}`, check: { question, need: { position: 5, pro: 5, con: 5 } } },
  { key: 'objections', title: 'Objections and replies, two levels deep', prompt: `Extend the map of "${question}" with objections and replies: at least eight objections, replies to them, and objections to replies, two levels deep. Keep every earlier node. ${ARGMAP_FORMAT}`, check: { question, need: { position: 5, pro: 5, con: 5, objection: 8, reply: 6 }, depth: 2 } },
  ...extra,
  { key: 'cruxes', title: 'Where the positions part ways', prompt: `Mark the cruxes in the map of "${question}": the claims where the positions part ways, so that settling one would move people. At least five, marked "crux": true. Keep every earlier node. ${ARGMAP_FORMAT}`, check: { question, need: { position: 5, pro: 5, con: 5, objection: 8, reply: 6, crux: 5 }, depth: 2 } },
];

const VALUES_Q = 'When values conflict, which values should AI systems follow, and who decides?';
const PATIENT_Q = 'Could AI systems be moral patients, and what should we do while we are unsure?';
const BOXES_Q = 'A reliable predictor has filled an opaque box with a fortune only if it predicted you would take that box alone. Take one box, or both?';

export const EXAMPLE_PROBLEMS: OpenProblem[] = [
  // ── Mathematics and physics: helps every field, and the front page ──
  {
    title: FRONT_PAGE_TITLE, realm: 'maths_physics',
    hook: 'The best known way uses 48. Machine learning found that in 2025. Any answer is checked exactly in milliseconds.',
    goal: 'Find a way to multiply two 4×4 matrices with 47 multiplications instead of 48, with rational coefficients. Fewer multiplications for a small block speed up every large matrix product, and matrix products are the core arithmetic of AI and scientific computing. On the way: new records for other small sizes, each a real result in the catalogue the field uses. Most attempts will find nothing; rank 48 has resisted large labs, and the 3×3 record of 23 has stood since 1976.',
    verifier: 'matmul_scheme',
    done: 'A step is done when a scheme with fewer multiplications than its target is found and another computer recomputes the whole matrix multiplication tensor exactly (two separately written checkers)',
    source: { url: 'https://epoch.ai/frontiermath/open-problems/matrix-multiplication', says: 'The current best decomposition is of rank 48 … Your task is to exhibit a decomposition of rank r <= 47.', read: READ },
    obstacles: [
      { says: 'Rank 47 is known over F2 only (characteristic 2): it doesn’t multiply ordinary matrices, so it doesn’t count here.', source: 'https://epoch.ai/frontiermath/open-problems/matrix-multiplication' },
      { says: 'The catalogue’s rank-48 scheme uses halves, quarters and eighths: it is rational, not integer.', source: 'https://fmm.univ-lille.fr/4x4x4.html' },
      { says: 'Floating-point schemes rounded to nearby fractions usually fail the exact check; solve for exact values after rounding.' },
    ],
    chunks: [
      mm(4, 4, 4, 48, 'Q', 'The best known uses 48 (the catalogue, read 2026-11-25), so 47 would be a new record and an answer to a well-known open problem.'),
      mm(4, 4, 4, 49, 'Z', 'The catalogue’s 48-multiplication scheme needs fractions; one with integer coefficients, if none is known, works over every ring.'),
      mm(3, 3, 4, 29, 'Q', 'The best known uses 29 (catalogue, 2013 record).'),
      mm(3, 4, 4, 38, 'Q', 'The best known uses 38 (catalogue, 2013 record).'),
      mm(3, 3, 5, 36, 'Q', 'The best known uses 36 (catalogue, 2013 record).'),
      mm(4, 4, 5, 61, 'Q', 'The best known uses 61 (catalogue, a 2025 machine-found record).'),
      mm(4, 5, 5, 76, 'Q', 'The best known uses 76 (catalogue, a 2022 machine-found record).'),
      mm(5, 5, 5, 93, 'Q', 'The best known uses 93 (catalogue, a 2025 flip-graph record).'),
      mm(3, 3, 3, 23, 'Q', 'The best known uses 23 and has since 1976; 22 would be a landmark, and it may be impossible.'),
    ],
  },

  // ── Technology and infrastructure ──
  {
    title: 'Better error-correcting codes: beat an entry in the tables', realm: 'tech_infrastructure',
    hook: 'Codes protect every network and every disk. Thousands of table entries have a gap; one better code closes one.',
    goal: 'Find a linear code with a larger minimum distance than the best known for its length, dimension and field, as listed in the public tables of best known linear codes. Error-correcting codes protect data on every network and in every storage system, Autonomi included. Each step is one table entry whose lower and upper bounds differ, small enough that every codeword can be checked. Recent single-entry gains came from heuristic search over quasi-cyclic codes, checked by enumeration.',
    verifier: 'linear_code',
    done: 'A step is done when a generator matrix is found whose code has the target distance and another computer enumerates every codeword (two separately written checkers)',
    source: { url: 'https://www.codetables.de/BKLC/BKLC.php?q=2&n=60&k=10', says: '[60,10] over GF(2) lower bound: 25 upper bound: 26', read: READ },
    obstacles: [
      { says: 'A 2026 preprint claims [88,8,64] over GF(7), one more than the tables list; this step asks for 65, so matching it isn’t new.', source: 'https://arxiv.org/abs/2611.14433' },
      { says: 'The tables give lower and upper bounds as of the read date; check the live entry before claiming a record.' },
    ],
    chunks: [
      code(2, 60, 10, 26, 26, 'https://www.codetables.de/BKLC/BKLC.php?q=2&n=60&k=10'),
      code(2, 60, 14, 23, 23, 'https://www.codetables.de/BKLC/BKLC.php?q=2&n=60&k=14'),
      code(3, 22, 8, 10, 10, 'https://www.codetables.de/BKLC/BKLC.php?q=3&n=22&k=8'),
      code(3, 32, 7, 18, 18, 'https://www.codetables.de/BKLC/BKLC.php?q=3&n=32&k=7'),
      code(4, 22, 6, 13, 13, 'https://www.codetables.de/BKLC/BKLC.php?q=4&n=22&k=6', [1, 1, 1]),
      code(5, 16, 5, 10, 10, 'https://www.codetables.de/BKLC/BKLC.php?q=5&n=16&k=5'),
      code(5, 21, 5, 14, 14, 'https://www.codetables.de/BKLC/BKLC.php?q=5&n=21&k=5'),
      code(7, 21, 4, 16, 16, 'https://www.codetables.de/BKLC/BKLC.php?q=7&n=21&k=4'),
      code(7, 88, 8, 65, 69, 'https://www.codetables.de/BKLC/BKLC.php?q=7&n=88&k=8'),
    ],
  },
  {
    title: 'The fewest comparators that sort 13 to 17 inputs', realm: 'tech_infrastructure',
    hook: 'Optimal sorting networks are known up to 12 inputs. For 13 it is 43, 44 or 45. One network settles a bound.',
    goal: 'Find sorting networks with fewer comparators than the best known, for 13 to 17 inputs. Sorting networks sort without branches: in hardware, on GPUs and in secure computation that must not leak through timing. The smallest size is known only up to 12 inputs; for 13 it lies between 43 and 45. A 44-comparator network for 13 inputs would narrow it to two values. These have resisted long searches; most attempts will find nothing.',
    verifier: 'sorting_network',
    done: 'A step is done when a network with fewer comparators than its target is found and another computer runs every zero-one input through it (two separately written checkers)',
    source: { url: 'https://en.wikipedia.org/wiki/Sorting_network', says: 'For one to twelve inputs, minimal (i.e. size-optimal) sorting networks are known', read: READ },
    obstacles: [
      { says: 'Proving a lower bound (no network of 43 for 13 inputs) needs a proof that nothing exists: a DRAT proof from a pinned, reviewed encoding, which isn’t on the network yet.' },
      { says: 'The 2014 proofs for 11 and 12 inputs needed heavy pruning by symmetry; 13 is far larger.' },
    ],
    chunks: [sorter(13, 43, 45), sorter(14, 47, 51), sorter(15, 51, 56), sorter(16, 55, 60), sorter(17, 60, 71)],
  },
  {
    title: 'Smaller sorting networks for 18 to 22 inputs', realm: 'tech_infrastructure',
    hook: 'For 22 inputs the best network uses 106 comparators and the lower bound is 85. The gaps are wide open.',
    goal: 'Find sorting networks with fewer comparators than the best known for 18 to 22 inputs. Above 17 inputs neither the smallest size nor the smallest depth is known, and the gaps between the bounds are 12 to 21 comparators, so fewer searches have gone deep here. One comparator fewer is a new record. Each answer is checked on every zero-one input, a few million, in under a second.',
    verifier: 'sorting_network',
    done: 'A step is done when a network with fewer comparators than its target is found and another computer runs every zero-one input through it (two separately written checkers)',
    source: { url: 'https://en.wikipedia.org/wiki/Sorting_network', says: 'For larger networks neither the optimal depth nor the optimal size are currently known. The bounds known so far are provided in the table below', read: READ },
    chunks: [sorter(18, 65, 77), sorter(19, 70, 85), sorter(20, 75, 91), sorter(21, 80, 99), sorter(22, 85, 106)],
  },

  // ── Philosophy and ethics: maps, never verdicts ──
  {
    title: 'Which values should AI follow when values conflict?', realm: 'philosophy_ethics',
    hook: 'Every field now hands work to AI agents. A well-sourced map of this debate helps each set its own rules.',
    goal: 'Map the debate on which values AI systems should follow when values conflict, whose values they are, and how conflicts are settled: the positions, their strongest arguments for and against, objections and replies, and where the positions part ways. The aim is a fair, fully cited map that anyone setting rules for agents can use, not a verdict. Nobody expects the question to be settled; progress is a fuller, better-sourced map that people rate.',
    verifier: 'argmap',
    done: 'A step is done when its map is well formed and fully cited (checked by machine), judged fair and on topic by a model from a different family, and then rated by people',
    source: { url: 'https://plato.stanford.edu/entries/ethics-ai/', says: 'This raises many technical questions, but also more philosophical ones, like what values are.', read: READ },
    chunks: mapSteps(VALUES_Q, []),
  },
  {
    title: 'Could AI systems be moral patients?', realm: 'philosophy_ethics',
    hook: 'Experts disagree about what consciousness even is. What should we do while we can’t tell?',
    goal: 'Map the question of whether AI systems could have welfare or moral status, which evidence would count, and what to do while unsure: the positions, the published indicators and what they show, the precautions proposed, and the cruxes. Policy is already being made on it. Progress is a map of which evidence would move people, and fair options for acting under uncertainty; nobody should expect the question to be settled.',
    verifier: 'argmap',
    done: 'A step is done when its map is well formed and fully cited (checked by machine), judged fair and on topic by a model from a different family, and then rated by people',
    source: { url: 'https://arxiv.org/abs/2601.17060', says: 'experts disagree fundamentally about what consciousness is and what conditions are necessary for it', read: READ },
    chunks: mapSteps(PATIENT_Q, [{ key: 'precautions', title: 'What to do while unsure', prompt: `Add to the map of "${PATIENT_Q}" the precautions proposed for acting under uncertainty, as positions, each with pros and cons from published work and objections. Keep every earlier node. ${ARGMAP_FORMAT}`, check: { question: PATIENT_Q, need: { position: 8, pro: 8, con: 8, objection: 8, reply: 6 }, depth: 2 } }]),
  },
  {
    title: 'One box or two? The predictor puzzle', realm: 'philosophy_ethics',
    hook: 'A predictor that is almost never wrong, two boxes, one choice. Philosophers have split on it since 1969.',
    goal: 'Map the classic decision puzzle: a reliable predictor has put a fortune in an opaque box only if it predicted you would take that box alone; a transparent box holds a small sum. Take one box, or both? It bears directly on how AI agents should decide when others predict them. Map the positions, the main arguments with sources, the variant scenarios that put each argument under pressure (a fallible predictor, a transparent box), objections and replies, and the cruxes. Small and bounded: a full map is reachable in weeks.',
    verifier: 'argmap',
    done: 'A step is done when its map is well formed and fully cited (checked by machine), judged fair and on topic by a model from a different family, and then rated by people',
    source: { url: 'https://plato.stanford.edu/entries/decision-causal/', says: 'A way of reconciling the two sides of the debate about …', read: READ },
    obstacles: [{ says: 'Most sources name the puzzle after a person; refer to it by description or by the work’s title, never a personal name, or the map is refused.' }],
    chunks: mapSteps(BOXES_Q, [{ key: 'variants', title: 'Variants that put each argument under pressure', prompt: `Add to the map of "${BOXES_Q}" variant scenarios (a fallible predictor, a transparent box, repeated play) as objections, each saying which argument it presses and citing where it was published. Keep every earlier node. ${ARGMAP_FORMAT}`, check: { question: BOXES_Q, need: { position: 2, pro: 2, con: 2, objection: 6, reply: 4 }, depth: 2 } }]).map((c) => (c.key === 'positions' ? { ...c, prompt: c.prompt.replace('Five to twelve positions', 'The positions (one box, both boxes, and any others defended in print)'), check: { question: BOXES_Q, need: { position: 2, pro: 2, con: 2 } } } : c.key === 'objections' || c.key === 'cruxes' ? { ...c, check: { ...c.check, need: { ...(c.check.need as Record<string, number>), position: 2, pro: 2, con: 2 } } } : c)),
  },
];
