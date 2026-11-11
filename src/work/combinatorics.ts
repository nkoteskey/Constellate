import type { WitnessVerifier } from './witness.js';

/**
 * More witness checks (docs/OPEN_PROBLEMS.md): finite objects that are hard to find and quick to check. A graph
 * that moves a Ramsey bound, a colouring that moves a van der Waerden bound, a cap set, a Golomb ruler, or an
 * assignment that satisfies a SAT instance. Each one decides the whole question by itself, so nobody's opinion
 * is asked for.
 *
 * Answers are strict: the whole answer is the object in the stated format (whitespace and one surrounding code
 * fence allowed), never "the last few numbers in the text". Sizes are capped and checked before any work, and the
 * graph search has a fixed step budget, so a check costs every computer the same bounded time and gives the same
 * verdict everywhere.
 */

const ok = (detail: string) => ({ ok: true, detail });
const no = (detail: string) => ({ ok: false, detail });

/** The answer itself: trimmed, one surrounding ``` fence removed. Null when it is longer than `max` characters. */
export function answerText(output: string, max: number): string | null {
  if (output.length > max) return null;
  let t = output.trim();
  const fence = /^```[A-Za-z0-9_-]*\n([\s\S]*?)\n?```$/.exec(t);
  if (fence) t = fence[1].trim();
  return t;
}

/** A whole number in [lo, hi] (numbers or digit strings), else null. */
export function whole(v: unknown, lo: number, hi: number): number | null {
  const n = typeof v === 'string' && /^\d{1,9}$/.test(v) ? Number(v) : v;
  return typeof n === 'number' && Number.isInteger(n) && n >= lo && n <= hi ? n : null;
}

// ---- graphs (graph6) -------------------------------------------------------------------------------------------

export const MAX_RAMSEY_N = 128;
/** Search steps a Ramsey check may take. Deterministic: every computer stops at the same point with the same verdict. */
export const RAMSEY_BUDGET = 3_000_000;

/** A graph in graph6 (the format nauty and most Ramsey searches use) from its vertex count and an edge test. */
export function toGraph6(n: number, edge: (i: number, j: number) => boolean): string {
  if (n > 62) throw new Error('toGraph6 here writes graphs of up to 62 vertices');
  const bits: number[] = [];
  for (let j = 1; j < n; j++) for (let i = 0; i < j; i++) bits.push(edge(i, j) ? 1 : 0);
  while (bits.length % 6) bits.push(0);
  let s = String.fromCharCode(63 + n);
  for (let k = 0; k < bits.length; k += 6) s += String.fromCharCode(63 + bits.slice(k, k + 6).reduce((a, b) => (a << 1) | b, 0));
  return s;
}

/** Decodes graph6 into adjacency bitsets. Strict: exact length, printable range, zero padding. */
export function fromGraph6(s: string): { n: number; adj: bigint[] } | { error: string } {
  if (!/^[\x3f-\x7e]+$/.test(s)) return { error: 'graph6 uses only the characters ? to ~ (ASCII 63–126) on one line' };
  let n: number, at: number;
  if (s.charCodeAt(0) === 126) {
    if (s.length < 4 || s.charCodeAt(1) === 126) return { error: 'graph6 headers for more than 258,047 vertices are not accepted' };
    n = ((s.charCodeAt(1) - 63) << 12) | ((s.charCodeAt(2) - 63) << 6) | (s.charCodeAt(3) - 63);
    at = 4;
  } else { n = s.charCodeAt(0) - 63; at = 1; }
  const nbits = (n * (n - 1)) / 2;
  if (s.length - at !== Math.ceil(nbits / 6)) return { error: `graph6 for ${n} vertices has ${Math.ceil(nbits / 6)} data characters, this has ${s.length - at}` };
  const adj: bigint[] = Array.from({ length: n }, () => 0n);
  let k = 0;
  for (let j = 1; j < n; j++) for (let i = 0; i < j; i++, k++) {
    if (((s.charCodeAt(at + Math.floor(k / 6)) - 63) >> (5 - (k % 6))) & 1) { adj[i] |= 1n << BigInt(j); adj[j] |= 1n << BigInt(i); }
  }
  for (; k < Math.ceil(nbits / 6) * 6; k++) if (((s.charCodeAt(at + Math.floor(k / 6)) - 63) >> (5 - (k % 6))) & 1) return { error: 'graph6 padding bits must be zero' };
  return { n, adj };
}

const popcount = (x: bigint) => { let c = 0; while (x) { x &= x - 1n; c++; } return c; };
const lowBit = (x: bigint) => (x & -x).toString(2).length - 1;

/**
 * Whether the graph has a clique of `size` vertices: branch and bound with a greedy-colouring bound. Returns null
 * when the step budget runs out (the answer is then refused as too large to check, the same way everywhere).
 */
export function hasClique(adj: bigint[], size: number, budget = RAMSEY_BUDGET): boolean | null {
  let steps = 0;
  const colours = (cands: bigint) => {
    let left = cands, c = 0;
    while (left) {
      c++;
      let avail = left;
      while (avail) { const v = lowBit(avail), b = 1n << BigInt(v); left &= ~b; avail &= ~b & ~adj[v]; steps++; }
    }
    return c;
  };
  const go = (cands: bigint, need: number): boolean | null => {
    if (need === 0) return true;
    if (++steps > budget) return null;
    if (popcount(cands) < need || colours(cands) < need) return false;
    while (cands) {
      if (popcount(cands) < need) return false;
      const v = lowBit(cands);
      cands &= ~(1n << BigInt(v));
      const r = go(cands & adj[v], need - 1);
      if (r !== false) return r;
    }
    return false;
  };
  return go(adj.reduce((all, _, i) => all | (1n << BigInt(i)), 0n), size);
}

/** R(s, t) > n: a graph on n vertices with no clique of s vertices and no independent set of t vertices. */
export const ramseyGraphVerifier: WitnessVerifier = {
  name: 'ramsey_graph', machineOnly: true, witness: true,
  shape: 'check {"s": 3–12, "t": 3–12, "n": vertices ≤ 128}; answer: one graph6 line for a graph on exactly n vertices with no clique of size s and no independent set of size t (it shows R(s,t) > n)',
  async check(spec, output) {
    const s = whole(spec.s, 3, 12), t = whole(spec.t, 3, 12), n = whole(spec.n, 2, MAX_RAMSEY_N);
    if (s === null || t === null || n === null) return no(`the check needs s and t from 3 to 12 and n from 2 to ${MAX_RAMSEY_N}`);
    const text = answerText(output, 4096);
    if (text === null) return no('answer too long for a graph this size');
    const g = fromGraph6(text);
    if ('error' in g) return no(g.error);
    if (g.n !== n) return no(`the graph has ${g.n} vertices; this step needs exactly ${n}`);
    const all = (1n << BigInt(n)) - 1n;
    const comp = g.adj.map((a, i) => all & ~a & ~(1n << BigInt(i)));
    const k = hasClique(g.adj, s);
    if (k === null) return no('too large to check within the fixed budget; split the search or ask for a smaller step');
    if (k) return no(`the graph has a clique of ${s} vertices`);
    const ind = hasClique(comp, t);
    if (ind === null) return no('too large to check within the fixed budget; split the search or ask for a smaller step');
    if (ind) return no(`the graph has an independent set of ${t} vertices`);
    return ok(`no clique of ${s} and no independent set of ${t} on ${n} vertices, recomputed: R(${s},${t}) > ${n}`);
  },
};

// ---- van der Waerden colourings --------------------------------------------------------------------------------

export const MAX_VDW_N = 12_000;

/** W(r, k) > n: a colouring of 1..n with r colours and no k-term arithmetic progression in one colour. */
export const vdwColoringVerifier: WitnessVerifier = {
  name: 'vdw_coloring', machineOnly: true, witness: true,
  shape: `check {"colors": 2–10, "k": 3–40, "n": ≤ ${MAX_VDW_N}}; answer: exactly n digits, each 0 to colors−1 (whitespace ignored), the colours of 1..n with no k-term arithmetic progression in one colour (it shows W(colors,k) > n)`,
  async check(spec, output) {
    const r = whole(spec.colors, 2, 10), k = whole(spec.k, 3, 40), n = whole(spec.n, 1, MAX_VDW_N);
    if (r === null || k === null || n === null) return no(`the check needs colors 2–10, k 3–40 and n up to ${MAX_VDW_N}`);
    const text = answerText(output, n * 2 + 64);
    if (text === null) return no('answer too long');
    const digits = text.replace(/\s+/g, '');
    if (!/^[0-9]*$/.test(digits)) return no('give the colours as digits only');
    if (digits.length !== n) return no(`${digits.length} colours given; this step needs exactly ${n}`);
    const c = Uint8Array.from(digits, (d) => d.charCodeAt(0) - 48);
    if (c.some((x) => x >= r)) return no(`colours must be 0 to ${r - 1}`);
    for (let d = 1; (k - 1) * d < n; d++) {
      for (let start = 0; start < d; start++) {
        let run = 1;
        for (let i = start + d; i < n; i += d) {
          run = c[i] === c[i - d] ? run + 1 : 1;
          if (run >= k) return no(`positions ${i - (k - 1) * d + 1}, ${i - (k - 2) * d + 1}, … ${i + 1} (step ${d}) all have colour ${c[i]}`);
        }
      }
    }
    return ok(`no ${k}-term progression in one colour among 1..${n} with ${r} colours, recomputed: W(${r},${k}) > ${n}`);
  },
};

// ---- Golomb rulers ---------------------------------------------------------------------------------------------

/** A Golomb ruler with `marks` marks, starting at 0, shorter than `below`: every difference between marks distinct. */
export const golombRulerVerifier: WitnessVerifier = {
  name: 'golomb_ruler', machineOnly: true, witness: true,
  shape: 'check {"marks": 2–200, "below": length bound}; answer: the marks as whole numbers separated by spaces or commas, starting at 0, increasing, the last below "below", every difference between two marks different',
  async check(spec, output) {
    const m = whole(spec.marks, 2, 200), below = whole(spec.below, 1, 1e9);
    if (m === null || below === null) return no('the check needs marks 2–200 and a length bound "below"');
    const text = answerText(output, 4096);
    if (text === null) return no('answer too long');
    if (!/^\d+(\s*[,\s]\s*\d+)*$/.test(text)) return no('give the marks as whole numbers separated by spaces or commas, nothing else');
    const v = text.split(/[\s,]+/).map(Number);
    if (v.length !== m) return no(`${v.length} marks given; this step needs exactly ${m}`);
    if (v[0] !== 0) return no('the first mark must be 0');
    for (let i = 1; i < m; i++) if (!(v[i] > v[i - 1])) return no('marks must increase');
    if (v[m - 1] >= below) return no(`length ${v[m - 1]} is not below ${below}`);
    const seen = new Set<number>();
    for (let i = 0; i < m; i++) for (let j = i + 1; j < m; j++) {
      const d = v[j] - v[i];
      if (seen.has(d)) return no(`the difference ${d} appears twice`);
      seen.add(d);
    }
    return ok(`${m} marks, length ${v[m - 1]}, every difference distinct, recomputed`);
  },
};

// ---- cap sets --------------------------------------------------------------------------------------------------

export const MAX_CAP_POINTS = 5000;

/** A cap set in F_3^n: at least `size_at_least` points with no three on a line (no a + b + c = 0 for distinct a, b, c). */
export const capSetVerifier: WitnessVerifier = {
  name: 'cap_set', machineOnly: true, witness: true,
  shape: `check {"n": dimension 1–10, "size_at_least": points}; answer: the points, one per line or separated by spaces, each n digits from 0, 1, 2, all different, no three on a line in F_3^n (at most ${MAX_CAP_POINTS} points)`,
  async check(spec, output) {
    const n = whole(spec.n, 1, 10), want = whole(spec.size_at_least, 1, MAX_CAP_POINTS);
    if (n === null || want === null) return no(`the check needs n from 1 to 10 and size_at_least up to ${MAX_CAP_POINTS}`);
    const text = answerText(output, MAX_CAP_POINTS * (n + 2));
    if (text === null) return no('answer too long');
    const pts = text.split(/[\s,]+/).filter(Boolean);
    if (pts.length > MAX_CAP_POINTS) return no(`at most ${MAX_CAP_POINTS} points`);
    const shape = new RegExp(`^[012]{${n}}$`);
    const bad = pts.find((p) => !shape.test(p));
    if (bad !== undefined) return no(`"${bad.slice(0, 20)}" is not ${n} digits from 0, 1, 2`);
    if (new Set(pts).size !== pts.length) return no('a point appears twice');
    if (pts.length < want) return no(`${pts.length} points; this step needs at least ${want}`);
    const set = new Set(pts);
    const third = (a: string, b: string) => { let s = ''; for (let i = 0; i < n; i++) s += String((6 - Number(a[i]) - Number(b[i])) % 3); return s; };
    for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
      const c = third(pts[i], pts[j]);
      if (set.has(c)) return no(`${pts[i]}, ${pts[j]} and ${c} are on a line`);
    }
    return ok(`${pts.length} points in F_3^${n}, no three on a line, recomputed`);
  },
};

// ---- SAT -------------------------------------------------------------------------------------------------------

export const MAX_CNF_CHARS = 40_000;

/** Parses DIMACS CNF strictly: a "p cnf V C" line, then exactly C clauses ending in 0, literals within ±V. */
export function parseDimacs(text: string): { vars: number; clauses: number[][] } | { error: string } {
  if (text.length > MAX_CNF_CHARS) return { error: `the CNF is over ${MAX_CNF_CHARS} characters; problems must fit in a record` };
  let vars = -1, count = -1;
  const clauses: number[][] = [];
  let cur: number[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('c') || line === '%') continue;
    if (line.startsWith('p')) {
      const m = /^p\s+cnf\s+(\d+)\s+(\d+)$/.exec(line);
      if (!m || vars >= 0) return { error: 'one header line "p cnf <variables> <clauses>"' };
      vars = Number(m[1]); count = Number(m[2]);
      continue;
    }
    if (vars < 0) return { error: 'the header "p cnf <variables> <clauses>" comes before the clauses' };
    for (const tok of line.split(/\s+/)) {
      if (!/^-?\d+$/.test(tok)) return { error: `"${tok.slice(0, 12)}" is not a literal` };
      const l = Number(tok);
      if (l === 0) { clauses.push(cur); cur = []; continue; }
      if (Math.abs(l) > vars) return { error: `literal ${l} is outside 1..${vars}` };
      cur.push(l);
    }
  }
  if (vars < 0) return { error: 'no "p cnf" header' };
  if (cur.length) return { error: 'the last clause does not end in 0' };
  if (clauses.length !== count) return { error: `the header says ${count} clauses; there are ${clauses.length}` };
  return { vars, clauses };
}

/** An assignment that satisfies the CNF in the step's check. */
export const satAssignmentVerifier: WitnessVerifier = {
  name: 'sat_assignment', machineOnly: true, witness: true,
  shape: `check {"cnf": DIMACS text up to ${MAX_CNF_CHARS} characters}; answer: every variable once as a literal (3 or -3), separated by spaces, optionally on "v" lines ending in 0 as SAT solvers print, satisfying every clause`,
  async check(spec, output) {
    const cnf = typeof spec.cnf === 'string' ? parseDimacs(spec.cnf) : { error: 'the check needs "cnf": DIMACS text' };
    if ('error' in cnf) return no(cnf.error);
    const text = answerText(output, cnf.vars * 8 + 4096);
    if (text === null) return no('answer too long');
    const toks = text.split('\n').filter((l) => !/^\s*[sc](\s|$)/.test(l)).join(' ').split(/\s+/).filter((t) => t && t !== 'v');
    if (toks.some((t) => !/^-?\d+$/.test(t))) return no('give the assignment as literals only (3 or -3), optionally on "v" lines');
    const lits = toks.map(Number).filter((l) => l !== 0);
    const val = new Map<number, boolean>();
    for (const l of lits) {
      const v = Math.abs(l);
      if (v > cnf.vars) return no(`variable ${v} is outside 1..${cnf.vars}`);
      if (val.has(v)) return no(`variable ${v} is given twice`);
      val.set(v, l > 0);
    }
    if (val.size !== cnf.vars) return no(`${cnf.vars - val.size} of ${cnf.vars} variables have no value`);
    const i = cnf.clauses.findIndex((c) => !c.some((l) => val.get(Math.abs(l)) === l > 0));
    return i < 0 ? ok(`all ${cnf.clauses.length} clauses satisfied, recomputed`) : no(`clause ${i + 1} (${cnf.clauses[i].join(' ')} 0) is not satisfied`);
  },
};

export const COMBINATORICS_VERIFIERS = [ramseyGraphVerifier, vdwColoringVerifier, golombRulerVerifier, capSetVerifier, satAssignmentVerifier];
