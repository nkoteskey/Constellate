import { answerText, whole } from './combinatorics.js';
import { integers } from './witness.js';
import { STRUCTURE_SECOND } from './second-structures.js';

/**
 * Second checkers: for each kind of witness, a check written separately from the first one (src/work/witness.ts,
 * combinatorics.ts, hadamard.ts), by a different method where there is one. A result counts as "Independently
 * checked" only when both accept it (src/work/results.ts); when they disagree, it says so instead of picking one.
 *
 * What they share with the first checkers, stated so nobody over-reads the label: the language (TypeScript, exact
 * integers via BigInt) and the answer-format clean-up (`answerText`, `integers`). The arithmetic and the search are
 * written again: Newton's method becomes binary search, fast doubling becomes 2×2 matrix powers, branch and bound
 * becomes Bron–Kerbosch, run-length scans become direct progressions, and so on. A checker in another language
 * would be more independent still; that is an open step (docs/RESULTS.md).
 */
export type Check = (spec: Record<string, unknown>, output: string) => Promise<{ ok: boolean; detail: string }>;

const yes = (detail: string) => ({ ok: true, detail });
const nope = (detail: string) => ({ ok: false, detail });

// ---- integers --------------------------------------------------------------------------------------------------

/** Integer square root by binary search (the first checker uses Newton's method). */
function rootFloor(n: bigint): bigint {
  if (n < 0n) return -1n;
  let lo = 0n, hi = 1n;
  while (hi * hi <= n) hi <<= 1n;
  while (lo < hi) { const mid = (lo + hi + 1n) >> 1n; if (mid * mid <= n) lo = mid; else hi = mid - 1n; }
  return lo;
}
const square = (n: bigint) => { const r = rootFloor(n); return r >= 0n && r * r === n; };

/** Left-to-right binary exponentiation (the first checker goes right to left). */
function powMod(base: bigint, exp: bigint, m: bigint): bigint {
  const b = ((base % m) + m) % m;
  let r = 1n % m;
  for (const bit of exp.toString(2)) { r = (r * r) % m; if (bit === '1') r = (r * b) % m; }
  return r;
}

/**
 * Strong probable-prime test with a different base set from the first checker's: the seven bases known to be
 * deterministic below 2^64, then seven more primes. Above 2^64 it is a probable-prime test, as the first one is.
 */
const SPRP_BASES = [2n, 325n, 9375n, 28178n, 450775n, 9780504n, 1795265022n, 43n, 47n, 53n, 59n, 61n, 67n, 71n];
function probablyPrime(n: bigint): boolean {
  if (n < 2n) return false;
  for (const p of [2n, 3n, 5n, 7n, 11n, 13n]) { if (n === p) return true; if (n % p === 0n) return false; }
  let d = n - 1n, r = 0;
  while (d % 2n === 0n) { d /= 2n; r++; }
  for (const raw of SPRP_BASES) {
    const a = raw % n;
    if (a === 0n) continue;
    let x = powMod(a, d, n);
    if (x === 1n || x === n - 1n) continue;
    let witness = true;
    for (let i = 1; i < r; i++) { x = (x * x) % n; if (x === n - 1n) { witness = false; break; } }
    if (witness) return false;
  }
  return true;
}

/** F(k) mod m by powers of the matrix [[1,1],[1,0]] (the first checker uses fast doubling). */
function fibonacciMod(k: bigint, m: bigint): bigint {
  type M = [bigint, bigint, bigint, bigint];
  const mul = (a: M, b: M): M => [(a[0] * b[0] + a[1] * b[2]) % m, (a[0] * b[1] + a[1] * b[3]) % m, (a[2] * b[0] + a[3] * b[2]) % m, (a[2] * b[1] + a[3] * b[3]) % m];
  let result: M = [1n, 0n, 0n, 1n], base: M = [1n, 1n, 1n, 0n], e = k;
  while (e > 0n) { if (e % 2n === 1n) result = mul(result, base); base = mul(base, base); e /= 2n; }
  return result[1];
}

// ---- graph6, written again -------------------------------------------------------------------------------------

function decodeGraph6(s: string): boolean[][] | null {
  if (!s.length || [...s].some((ch) => ch.charCodeAt(0) < 63 || ch.charCodeAt(0) > 126)) return null;
  const codes = [...s].map((ch) => ch.charCodeAt(0) - 63);
  let n: number, rest: number[];
  if (codes[0] === 63) { if (codes.length < 4 || codes[1] === 63) return null; n = codes[1] * 4096 + codes[2] * 64 + codes[3]; rest = codes.slice(4); } else { n = codes[0]; rest = codes.slice(1); }
  const bits = rest.flatMap((c) => [5, 4, 3, 2, 1, 0].map((b) => (c >> b) & 1));
  const need = (n * (n - 1)) / 2;
  if (rest.length !== Math.ceil(need / 6) || bits.slice(need).some(Boolean)) return null;
  const g = Array.from({ length: n }, () => Array<boolean>(n).fill(false));
  let k = 0;
  for (let j = 1; j < n; j++) for (let i = 0; i < j; i++) { if (bits[k++]) g[i][j] = g[j][i] = true; }
  return g;
}

/** Largest clique reaches `size`? Bron–Kerbosch with pivoting and a step budget; null when the budget runs out. */
function cliqueAtLeast(g: boolean[][], size: number, budget = 3_000_000): boolean | null {
  let steps = 0;
  const go = (r: number, p: number[], x: number[]): boolean | null => {
    if (r >= size) return true;
    if (++steps > budget) return null;
    if (r + p.length < size) return false;
    const pivot = [...p, ...x].reduce((best, u) => { const c = p.filter((v) => g[u][v]).length; return c > best.c ? { u, c } : best; }, { u: -1, c: -1 }).u;
    for (const v of p.filter((v) => pivot < 0 || !g[pivot][v])) {
      const res = go(r + 1, p.filter((w) => g[v][w]), x.filter((w) => g[v][w]));
      if (res !== false) return res;
      p = p.filter((w) => w !== v);
      x = [...x, v];
    }
    return false;
  };
  return go(0, g.map((_, i) => i), []);
}

// ---- the second checkers ---------------------------------------------------------------------------------------

export const SECOND_CHECKERS: Record<string, Check> = {
  async three_cubes(spec, output) {
    const v = integers(output).slice(-3);
    if (v.length < 3) return nope('three integers needed');
    const target = BigInt(String(spec.n));
    const total = v.reduce((s, x) => s + x * x * x, 0n);
    return total === target ? yes(`sum of cubes is ${target}`) : nope(`sum of cubes is ${total}`);
  },
  async perfect_cuboid(_spec, output) {
    const v = integers(output).slice(-3);
    if (v.length < 3 || v.some((x) => x < 1n)) return nope('three positive edges needed');
    const [a, b, c] = v.map((x) => x * x);
    const all = [a + b, b + c, a + c, a + b + c].every(square);
    return all ? yes('all four diagonals are integers') : nope('a diagonal is not an integer');
  },
  async wieferich(spec, output) {
    const p = integers(output).at(-1);
    if (p === undefined || p <= BigInt(String(spec.above ?? 0))) return nope('no prime above the bound');
    if (!probablyPrime(p)) return nope(`${p} is composite`);
    return powMod(2n, p - 1n, p * p) === 1n ? yes(`2^(p−1) mod p² is 1 for p = ${p}`) : nope('2^(p−1) mod p² is not 1');
  },
  async wall_sun_sun(spec, output) {
    const p = integers(output).at(-1);
    if (p === undefined || p <= BigInt(String(spec.above ?? 0)) || p === 2n || p === 5n) return nope('no prime above the bound');
    if (!probablyPrime(p)) return nope(`${p} is composite`);
    const euler = powMod(5n, (p - 1n) / 2n, p); // Euler's criterion for the Legendre symbol (5/p)
    const k = euler === 1n ? p - 1n : p + 1n;
    return fibonacciMod(k, p * p) === 0n ? yes(`p² divides F(${k})`) : nope(`p² does not divide F(${k})`);
  },
  async ramsey_graph(spec, output) {
    const s = whole(spec.s, 3, 12), t = whole(spec.t, 3, 12), n = whole(spec.n, 2, 128);
    const text = answerText(output, 4096);
    if (s === null || t === null || n === null || text === null) return nope('bad step or answer');
    const g = decodeGraph6(text);
    if (!g || g.length !== n) return nope('not a graph6 graph on n vertices');
    const comp = g.map((row, i) => row.map((e, j) => i !== j && !e));
    const a = cliqueAtLeast(g, s), b = a === false ? cliqueAtLeast(comp, t) : a;
    if (a === null || b === null) return nope('out of budget');
    return !a && !b ? yes('no clique of s, no independent set of t') : nope(a ? 'has a clique of s' : 'has an independent set of t');
  },
  async vdw_coloring(spec, output) {
    const r = whole(spec.colors, 2, 10), k = whole(spec.k, 3, 40), n = whole(spec.n, 1, 12_000);
    const text = answerText(output, (n ?? 0) * 2 + 64);
    if (r === null || k === null || n === null || text === null) return nope('bad step or answer');
    const c = text.replace(/\s+/g, '').split('').map(Number);
    if (c.length !== n || c.some((x) => !Number.isInteger(x) || x < 0 || x >= r)) return nope('wrong colouring shape');
    for (let a = 0; a < n; a++) for (let d = 1; a + (k - 1) * d < n; d++) {
      let same = true;
      for (let j = 1; j < k && same; j++) same = c[a + j * d] === c[a];
      if (same) return nope(`progression from ${a + 1} with step ${d} is one colour`);
    }
    return yes('no one-colour progression');
  },
  async golomb_ruler(spec, output) {
    const m = whole(spec.marks, 2, 200), below = whole(spec.below, 1, 1e9);
    const text = answerText(output, 4096);
    if (m === null || below === null || text === null || !/^[\d\s,]+$/.test(text)) return nope('bad step or answer');
    const v = text.split(/[^\d]+/).filter(Boolean).map(Number);
    if (v.length !== m || v[0] !== 0 || v.some((x, i) => i > 0 && x <= v[i - 1]) || v[m - 1] >= below) return nope('wrong marks');
    const diffs = v.flatMap((x, i) => v.slice(i + 1).map((y) => y - x)).sort((a, b) => a - b);
    return diffs.every((d, i) => i === 0 || d !== diffs[i - 1]) ? yes('all differences distinct') : nope('a difference repeats');
  },
  async cap_set(spec, output) {
    const n = whole(spec.n, 1, 10), want = whole(spec.size_at_least, 1, 5000);
    const text = answerText(output, 5000 * 12);
    if (n === null || want === null || text === null) return nope('bad step or answer');
    const words = text.split(/[\s,]+/).filter(Boolean);
    if (words.some((w) => w.length !== n || /[^012]/.test(w))) return nope('bad point');
    const codes = words.map((w) => [...w].reduce((a, d) => a * 3 + Number(d), 0)); // base-3 integers
    const set = new Set(codes);
    if (set.size !== codes.length || codes.length < want) return nope('repeated points or too few');
    const digits = (x: number) => Array.from({ length: n }, (_, i) => Math.floor(x / 3 ** i) % 3);
    for (let i = 0; i < codes.length; i++) for (let j = i + 1; j < codes.length; j++) {
      const a = digits(codes[i]), b = digits(codes[j]);
      const third = a.reduce((acc, ai, k) => acc + ((9 - ai - b[k]) % 3) * 3 ** k, 0);
      if (set.has(third)) return nope('three points on a line');
    }
    return yes('no three on a line');
  },
  async sat_assignment(spec, output) {
    if (typeof spec.cnf !== 'string') return nope('no CNF');
    const body = spec.cnf.split('\n').map((l) => l.trim()).filter((l) => l && !/^[c%]/.test(l));
    const head = /^p\s+cnf\s+(\d+)\s+(\d+)$/.exec(body[0] ?? '');
    if (!head) return nope('no header');
    const vars = Number(head[1]);
    const nums = body.slice(1).join(' ').split(/\s+/).filter(Boolean).map(Number);
    const text = answerText(output, vars * 8 + 4096);
    if (text === null) return nope('answer too long');
    const assign = new Int8Array(vars + 1);
    for (const tok of text.split('\n').filter((l) => !/^\s*[sc](\s|$)/.test(l)).join(' ').split(/\s+/)) {
      if (!tok || tok === 'v' || tok === '0') continue;
      const l = Number(tok);
      if (!Number.isInteger(l) || Math.abs(l) > vars || assign[Math.abs(l)] !== 0) return nope('bad assignment');
      assign[Math.abs(l)] = l > 0 ? 1 : -1;
    }
    if (assign.slice(1).some((x) => x === 0)) return nope('a variable has no value');
    let satisfied = false, clauses = 0;
    for (const l of nums) {
      if (l === 0) { if (!satisfied) return nope(`clause ${clauses + 1} is false`); clauses++; satisfied = false; continue; }
      if (assign[Math.abs(l)] === Math.sign(l)) satisfied = true;
    }
    return clauses === Number(head[2]) ? yes('every clause true') : nope('clause count differs');
  },
  async hadamard_gs(spec, output) {
    const n = whole(spec.n, 4, 20_000);
    if (n === null || n % 4) return nope('bad order');
    const v = n / 4;
    const text = answerText(output, 4 * (v + 2) + 64);
    const lines = (text ?? '').replace(/−/g, '-').split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length !== 4 || lines.some((l) => l.length !== v || /[^+-]/.test(l))) return nope('bad sequences');
    // Supplementary difference sets: with S the minus positions of a sequence, its autocorrelation at shift s is
    // v − 4(|S| − λ(s)), where λ(s) counts ordered pairs in S that differ by s. Counted from differences, not products.
    const total = new Array<number>(v).fill(0);
    for (const l of lines) {
      const minus = [...l].flatMap((ch, i) => (ch === '-' ? [i] : []));
      const lambda = new Array<number>(v).fill(0);
      for (const i of minus) for (const j of minus) lambda[(j - i + v) % v]++;
      for (let s = 1; s < v; s++) total[s] += v - 4 * (minus.length - lambda[s]);
    }
    const bad = total.findIndex((x, s) => s > 0 && x !== 0);
    return bad < 0 ? yes(`H Hᵀ = ${n} I for the Goethals–Seidel array`) : nope(`autocorrelations sum to ${total[bad]} at shift ${bad}`);
  },
};

/** DRAT, written again: clauses in a plain list, propagation by scanning every clause until nothing changes. */
function dratSecond(cnfText: string, proofText: string): string | null {
  const lines = cnfText.split('\n').map((l) => l.trim()).filter((l) => l && !/^[c%]/.test(l));
  const head = /^p\s+cnf\s+(\d+)\s+(\d+)$/.exec(lines[0] ?? '');
  if (!head) return 'no header';
  const vars = Number(head[1]);
  const split = (t: string) => { const out: number[][] = []; let cur: number[] = []; for (const x of t.split(/\s+/).filter(Boolean)) { const n = Number(x); if (n === 0) { out.push(cur); cur = []; } else cur.push(n); } return cur.length ? null : out; };
  let db = split(lines.slice(1).join(' '));
  if (!db) return 'bad formula';
  const rows = proofText.split('\n').map((l) => l.trim()).filter(Boolean);
  let budget = 20_000_000;
  const unitConflict = (assume: number[]): boolean | null => {
    const val = new Map<number, number>();
    for (const l of assume) { if (val.get(Math.abs(l)) === -Math.sign(l)) return true; val.set(Math.abs(l), Math.sign(l)); }
    for (let changed = true; changed;) {
      changed = false;
      for (const c of db!) {
        if ((budget -= 1) < 0) return null;
        const open = c.filter((l) => !val.has(Math.abs(l)));
        if (c.some((l) => val.get(Math.abs(l)) === Math.sign(l))) continue;
        if (!open.length) return true;
        if (open.length === 1) { val.set(Math.abs(open[0]), Math.sign(open[0])); changed = true; }
      }
    }
    return false;
  };
  for (const row of rows) {
    const del = row.startsWith('d');
    const lits = row.replace(/^d\s*/, '').split(/\s+/).map(Number);
    if (lits.pop() !== 0 || lits.some((l) => !Number.isInteger(l) || l === 0 || Math.abs(l) > vars)) return 'bad proof line';
    const sameClause = (c: number[]) => c.length === lits.length && [...c].sort().join() === [...lits].sort().join();
    if (del) { const i = db.findIndex(sameClause); if (i >= 0) db = [...db.slice(0, i), ...db.slice(i + 1)]; continue; }
    let ok = unitConflict(lits.map((l) => -l));
    if (ok === null) return 'out of budget';
    if (!ok && lits.length) {
      ok = true;
      for (const c of db.filter((c) => c.includes(-lits[0]))) {
        const r = [...new Set([...lits, ...c.filter((l) => l !== -lits[0])])];
        if (r.some((l) => r.includes(-l))) continue;
        const sub = unitConflict(r.map((l) => -l));
        if (sub === null) return 'out of budget';
        if (!sub) { ok = false; break; }
      }
    }
    if (!ok) return 'a line is neither RUP nor RAT';
    if (!lits.length) return null;
    db.push(lits);
  }
  return 'no empty clause';
}
SECOND_CHECKERS.unsat_drat = async (spec, output) => {
  if (typeof spec.cnf !== 'string') return nope('no CNF');
  const text = answerText(output, 400_000);
  if (text === null) return nope('proof too long');
  const why = dratSecond(spec.cnf, text);
  return why ? nope(why) : yes('the empty clause follows');
};

Object.assign(SECOND_CHECKERS, STRUCTURE_SECOND);

export const secondChecker = (name: string): Check | undefined => SECOND_CHECKERS[name];
