import type { WitnessVerifier } from './witness.js';
import { answerText, whole } from './combinatorics.js';

/**
 * Three more built-in witness checks (docs/CHECKERS.md): pure, deterministic, exact and bounded.
 *
 * - `matmul_scheme`: a way to multiply an n×m by an m×p matrix with r multiplications, checked exactly against
 *   the matrix multiplication tensor (the Brent equations).
 * - `linear_code`: a k×n generator matrix over GF(q) whose code has minimum distance at least d, by enumerating
 *   every codeword up to scalar multiples.
 * - `sorting_network`: comparators that sort every input of n wires, by the 0-1 principle (all 2^n inputs).
 */
const ok = (detail: string) => ({ ok: true, detail });
const no = (detail: string) => ({ ok: false, detail });

// ---- matrix multiplication schemes -----------------------------------------------------------------------------

export const MATMUL_MAX_DIM = 8;
export const MATMUL_MAX_RANK = 512;
export const MATMUL_BUDGET = 20_000_000;
export type Ring = 'Z' | 'Q' | 'F2';

const gcd = (a: bigint, b: bigint): bigint => { a = a < 0n ? -a : a; b = b < 0n ? -b : b; while (b) [a, b] = [b, a % b]; return a; };

/** An exact entry: an integer, or "a/b" with b > 0 (decimals and floats are refused). */
export function exactEntry(v: unknown): { num: bigint; den: bigint } | null {
  if (typeof v === 'number') return Number.isSafeInteger(v) ? { num: BigInt(v), den: 1n } : null;
  if (typeof v !== 'string') return null;
  const m = /^\s*(-?\d{1,30})(?:\s*\/\s*(\d{1,30}))?\s*$/.exec(v);
  if (!m) return null;
  const den = m[2] ? BigInt(m[2]) : 1n;
  if (den === 0n) return null;
  const g = gcd(BigInt(m[1]), den) || 1n;
  return { num: BigInt(m[1]) / g, den: den / g };
}

export interface MatmulSpec { n: number; m: number; p: number; below: number; ring: Ring }
export function matmulSpec(spec: Record<string, unknown>): MatmulSpec | string {
  const n = whole(spec.n, 1, MATMUL_MAX_DIM), m = whole(spec.m, 1, MATMUL_MAX_DIM), p = whole(spec.p, 1, MATMUL_MAX_DIM);
  const below = whole(spec.rank_below, 1, MATMUL_MAX_RANK + 1);
  const ring = (spec.ring ?? 'Q') as Ring;
  if (n === null || m === null || p === null || below === null) return `the check needs n, m, p from 1 to ${MATMUL_MAX_DIM} and rank_below`;
  if (!['Z', 'Q', 'F2'].includes(ring)) return 'ring is Z, Q or F2';
  return { n, m, p, below, ring };
}

/** The answer's three factor lists, parsed exactly; entries as fractions. */
export function matmulFactors(output: string, s: MatmulSpec): { U: { num: bigint; den: bigint }[][]; V: { num: bigint; den: bigint }[][]; W: { num: bigint; den: bigint }[][] } | string {
  const text = answerText(output, 2_000_000);
  if (text === null) return 'answer too long';
  let j: unknown;
  try { j = JSON.parse(text); } catch { return 'give the scheme as JSON: {"U": [...], "V": [...], "W": [...]}'; }
  const o = j as Record<string, unknown>;
  const sizes = { U: s.n * s.m, V: s.m * s.p, W: s.n * s.p } as const;
  const out: Record<string, { num: bigint; den: bigint }[][]> = {};
  for (const key of ['U', 'V', 'W'] as const) {
    const rows = o?.[key];
    if (!Array.isArray(rows)) return `${key} is missing`;
    if (rows.length > MATMUL_MAX_RANK) return `at most ${MATMUL_MAX_RANK} products`;
    out[key] = [];
    for (const [t, row] of rows.entries()) {
      if (!Array.isArray(row) || row.length !== sizes[key]) return `${key}[${t}] needs ${sizes[key]} entries`;
      const parsed = row.map(exactEntry);
      if (parsed.some((x) => x === null)) return `${key}[${t}] has an entry that isn't an integer or a fraction a/b`;
      for (const x of parsed as { num: bigint; den: bigint }[]) {
        if (s.ring === 'Z' && x.den !== 1n) return `${key}[${t}] has a fraction; this step is over the integers`;
        if (s.ring === 'F2' && (x.den !== 1n || (x.num !== 0n && x.num !== 1n))) return `${key}[${t}]: over F2 every entry is 0 or 1`;
      }
      out[key].push(parsed as { num: bigint; den: bigint }[]);
    }
  }
  if (out.U.length !== out.V.length || out.V.length !== out.W.length) return 'U, V and W need the same number of products';
  return out as ReturnType<typeof matmulFactors> & object;
}

/**
 * Exact check of the Brent equations by sparse accumulation. Each factor list is scaled to integers by the LCM of
 * its denominators (D), so sum_t U_t[i,j] V_t[j',k] W_t[i',k'] must equal D_U·D_V·D_W exactly when i=i', j=j',
 * k=k', and 0 otherwise (over F2: 1 and 0 mod 2).
 */
export const matmulSchemeVerifier: WitnessVerifier = {
  name: 'matmul_scheme', machineOnly: true, witness: true,
  shape: `check {"n", "m", "p" (1–${MATMUL_MAX_DIM}), "rank_below", "ring": "Q"|"Z"|"F2"}; answer: JSON {"U": r rows of n·m entries (A[i][j] at i·m+j), "V": r rows of m·p (B[j][k] at j·p+k), "W": r rows of n·p (C[i][k] at i·p+k)}, entries integers or "a/b"; product t is (Σ U_t·A)(Σ V_t·B) and C = Σ_t W_t·product_t; r below rank_below`,
  async check(spec, output) {
    const s = matmulSpec(spec);
    if (typeof s === 'string') return no(s);
    const f = matmulFactors(output, s);
    if (typeof f === 'string') return no(f);
    const r = f.U.length;
    if (r >= s.below) return no(`${r} products; this step needs fewer than ${s.below}`);
    const scale = (rows: { num: bigint; den: bigint }[][]) => {
      let l = 1n;
      for (const row of rows) for (const x of row) l = (l / gcd(l, x.den)) * x.den;
      return { d: l, rows: rows.map((row) => row.map((x) => (x.num * l) / x.den)) };
    };
    const U = scale(f.U), V = scale(f.V), W = scale(f.W);
    const nz = (row: bigint[]) => row.flatMap((v, i) => (v ? [[i, v] as const] : []));
    let cost = 0;
    const sum = new Map<number, bigint>();
    const NB = s.m * s.p, NC = s.n * s.p;
    for (let t = 0; t < r; t++) {
      const u = nz(U.rows[t]), v = nz(V.rows[t]), w = nz(W.rows[t]);
      cost += u.length * v.length * w.length;
      if (cost > MATMUL_BUDGET) return no('the scheme is too dense to check within the budget');
      for (const [a, ua] of u) for (const [b, vb] of v) for (const [c, wc] of w) {
        const key = (a * NB + b) * NC + c;
        sum.set(key, (sum.get(key) ?? 0n) + ua * vb * wc);
      }
    }
    const D = U.d * V.d * W.d;
    const want = (key: number) => {
      const c = key % NC, b = Math.floor(key / NC) % NB, a = Math.floor(key / NC / NB);
      const i = Math.floor(a / s.m), j = a % s.m, j2 = Math.floor(b / s.p), k = b % s.p, i2 = Math.floor(c / s.p), k2 = c % s.p;
      return i === i2 && j === j2 && k === k2;
    };
    const good = (key: number, v: bigint) => s.ring === 'F2' ? ((v % 2n) + 2n) % 2n === (want(key) ? 1n : 0n) : v === (want(key) ? D : 0n);
    for (const [key, v] of sum) if (!good(key, v)) return no(`the scheme is wrong: entry ${describe(key, s)} of the multiplication tensor comes out wrong`);
    for (let i = 0; i < s.n; i++) for (let j = 0; j < s.m; j++) for (let k = 0; k < s.p; k++) {
      const key = ((i * s.m + j) * NB + (j * s.p + k)) * NC + (i * s.p + k);
      if (!sum.has(key)) return no(`the scheme is wrong: C[${i}][${k}] misses A[${i}][${j}]·B[${j}][${k}]`);
    }
    return ok(`⟨${s.n}×${s.m}×${s.p}⟩ with ${r} multiplications over ${s.ring}, every entry of the multiplication tensor recomputed exactly`);
  },
};
function describe(key: number, s: MatmulSpec) {
  const NB = s.m * s.p, NC = s.n * s.p;
  const c = key % NC, b = Math.floor(key / NC) % NB, a = Math.floor(key / NC / NB);
  return `(A[${Math.floor(a / s.m)}][${a % s.m}], B[${Math.floor(b / s.p)}][${b % s.p}], C[${Math.floor(c / s.p)}][${c % s.p}])`;
}

// ---- linear codes ----------------------------------------------------------------------------------------------

export const CODE_MAX_N = 256;
export const CODE_BUDGET = 400_000_000;

export interface Field { q: number; add: Uint8Array; mul: Uint8Array; neg: Uint8Array; inv: Uint8Array }
const isPrime = (x: number) => { if (x < 2) return false; for (let d = 2; d * d <= x; d++) if (x % d === 0) return false; return true; };

/** GF(q) for q ≤ 16: integers mod q when q is prime, else polynomials over GF(p) modulo `poly` (coefficients low to high, monic). */
export function field(q: number, poly?: unknown): Field | string {
  let p = 0, e = 0;
  for (let c = 2; c <= q; c++) if (isPrime(c)) { let x = 1, k = 0; while (x < q) { x *= c; k++; } if (x === q) { p = c; e = k; break; } }
  if (!p) return 'q must be a prime or a prime power up to 16';
  const add = new Uint8Array(q * q), mul = new Uint8Array(q * q);
  const digits = (x: number) => Array.from({ length: e }, (_, i) => Math.floor(x / p ** i) % p);
  const from = (d: number[]) => d.reduce((s, v, i) => s + v * p ** i, 0);
  let f: number[] = [];
  if (e > 1) {
    if (!Array.isArray(poly) || poly.length !== e + 1 || poly.some((c) => !Number.isInteger(c) || c < 0 || c >= p) || poly[e] !== 1) return `GF(${q}) needs "poly": the ${e + 1} coefficients of a monic irreducible polynomial of degree ${e} over GF(${p}), low to high`;
    f = poly as number[];
  }
  for (let a = 0; a < q; a++) for (let b = 0; b < q; b++) {
    if (e === 1) { add[a * q + b] = (a + b) % p; mul[a * q + b] = (a * b) % p; continue; }
    const da = digits(a), db = digits(b);
    add[a * q + b] = from(da.map((v, i) => (v + db[i]) % p));
    const prod = new Array(2 * e - 1).fill(0);
    for (let i = 0; i < e; i++) for (let j = 0; j < e; j++) prod[i + j] = (prod[i + j] + da[i] * db[j]) % p;
    for (let d = prod.length - 1; d >= e; d--) { const c = prod[d]; if (!c) continue; for (let i = 0; i <= e; i++) prod[d - e + i] = (((prod[d - e + i] - c * f[i]) % p) + p) % p; }
    mul[a * q + b] = from(prod.slice(0, e));
  }
  const neg = new Uint8Array(q), inv = new Uint8Array(q);
  for (let a = 0; a < q; a++) {
    for (let b = 0; b < q; b++) if (add[a * q + b] === 0) neg[a] = b;
    if (a) { const b = [...Array(q).keys()].find((x) => mul[a * q + x] === 1); if (b === undefined) return 'that polynomial is not irreducible: this is not a field'; inv[a] = b; }
  }
  return { q, add, mul, neg, inv };
}

export interface CodeSpec { q: number; n: number; k: number; d: number; F: Field }
export function codeSpec(spec: Record<string, unknown>): CodeSpec | string {
  const q = whole(spec.q, 2, 16), n = whole(spec.n, 1, CODE_MAX_N), k = whole(spec.k, 1, CODE_MAX_N), d = whole(spec.d_at_least, 1, CODE_MAX_N);
  if (q === null || n === null || k === null || d === null || k > n) return `the check needs q (2–16), n (up to ${CODE_MAX_N}), k ≤ n and d_at_least`;
  const F = field(q, spec.poly);
  if (typeof F === 'string') return F;
  return { q, n, k, d, F };
}

/** The generator matrix: k rows of n field elements (0..q−1), separated by spaces or commas, or digits run together when q ≤ 10. */
export function generator(output: string, s: CodeSpec): number[][] | string {
  const text = answerText(output, s.k * s.n * 4 + 4096);
  if (text === null) return 'answer too long';
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length !== s.k) return `${lines.length} rows given; this step needs k = ${s.k}`;
  const rows: number[][] = [];
  for (const l of lines) {
    const parts = /[\s,]/.test(l) ? l.split(/[\s,]+/) : s.q <= 10 ? l.split('') : [l];
    const row = parts.map((x) => (/^\d{1,2}$/.test(x) ? Number(x) : NaN));
    if (row.length !== s.n || row.some((x) => !(x >= 0 && x < s.q))) return `every row needs n = ${s.n} elements from 0 to ${s.q - 1}`;
    rows.push(row);
  }
  return rows;
}

export function rank(rows: number[][], F: Field): number {
  const m = rows.map((r) => [...r]), q = F.q, n = m[0]?.length ?? 0;
  let r = 0;
  for (let c = 0; c < n && r < m.length; c++) {
    const piv = m.findIndex((row, i) => i >= r && row[c] !== 0);
    if (piv < 0) continue;
    [m[r], m[piv]] = [m[piv], m[r]];
    const iv = F.inv[m[r][c]];
    m[r] = m[r].map((x) => F.mul[x * q + iv]);
    for (let i = 0; i < m.length; i++) if (i !== r && m[i][c]) { const f = F.neg[m[i][c]]; m[i] = m[i].map((x, j) => F.add[x * q + F.mul[f * q + m[r][j]]]); }
    r++;
  }
  return r;
}

/**
 * Minimum distance by enumeration up to scalars: for each position L, coefficient 1 at L, zeros above, every value
 * below (an odometer that changes one coefficient at a time, updating the codeword and its weight incrementally).
 */
export const linearCodeVerifier: WitnessVerifier = {
  name: 'linear_code', machineOnly: true, witness: true,
  shape: `check {"q" (prime or prime power ≤ 16), "n" (≤ ${CODE_MAX_N}), "k", "d_at_least", "poly" for prime powers}; answer: a k×n generator matrix over GF(q), one row per line, elements 0..q−1 (GF(p^e) elements as base-p digits of polynomials mod poly); rank k, every nonzero codeword of weight ≥ d_at_least`,
  async check(spec, output) {
    const s = codeSpec(spec);
    if (typeof s === 'string') return no(s);
    const G = generator(output, s);
    if (typeof G === 'string') return no(G);
    const { q, n, k, F } = s;
    if ((q ** k - 1) / (q - 1) * n > CODE_BUDGET) return no('too many codewords to enumerate within the budget');
    if (rank(G, F) !== k) return no(`the rows are not independent: rank ${rank(G, F)}, not ${k}`);
    const scaled = G.map((row) => Array.from({ length: q }, (_, a) => row.map((x) => F.mul[a * q + x])));
    let min = n + 1;
    for (let L = 0; L < k; L++) {
      const c = Uint8Array.from(G[L]); // coefficient 1 at L
      let w = c.reduce((t, x) => t + (x ? 1 : 0), 0);
      const coef = new Array(L).fill(0);
      for (;;) {
        if (w < min) { min = w; if (w < s.d) return no(`a nonzero codeword has weight ${w}, below ${s.d}`); }
        let i = 0;
        for (; i < L; i++) {
          const a = coef[i], b = (a + 1) % q;
          const ra = scaled[i][a], rb = scaled[i][b];
          for (let j = 0; j < n; j++) {
            if (ra[j] === rb[j]) continue;
            const before = c[j];
            c[j] = F.add[F.add[before * q + F.neg[ra[j]]] * q + rb[j]];
            w += (c[j] ? 1 : 0) - (before ? 1 : 0);
          }
          coef[i] = b;
          if (b !== 0) break; // no carry
        }
        if (i === L) break;
      }
    }
    return ok(`[${n},${k},${min}] over GF(${q}): rank ${k} and every nonzero codeword (up to scalars) enumerated; minimum distance ${min}`);
  },
};

// ---- sorting networks ------------------------------------------------------------------------------------------

export const SORT_MAX_N = 22;
export const SORT_MAX_COMPARATORS = 2000;

export function comparators(output: string, n: number): [number, number][] | string {
  const text = answerText(output, SORT_MAX_COMPARATORS * 16);
  if (text === null) return 'answer too long';
  if (/[^\d\s,()[\]:;-]/.test(text)) return 'give the comparators as pairs of wire numbers, e.g. "0 1, 2 3" or "(0,1) (2,3)"';
  const nums = [...text.matchAll(/\d+/g)].map((m) => Number(m[0]));
  if (nums.length % 2) return 'an odd number of wire numbers: comparators come in pairs';
  const out: [number, number][] = [];
  for (let i = 0; i < nums.length; i += 2) {
    const [a, b] = [nums[i], nums[i + 1]];
    if (a >= n || b >= n || a === b) return `comparator (${a},${b}) is not two different wires from 0 to ${n - 1}`;
    out.push(a < b ? [a, b] : [b, a]); // the smaller value goes to the lower wire
  }
  if (out.length > SORT_MAX_COMPARATORS) return `at most ${SORT_MAX_COMPARATORS} comparators`;
  return out;
}

const LANE = [0xaaaaaaaa, 0xcccccccc, 0xf0f0f0f0, 0xff00ff00, 0xffff0000];

/** All 2^n zero-one inputs, 32 at a time, one bit per input in each wire's word; sorted means no 1 above a 0. */
export const sortingNetworkVerifier: WitnessVerifier = {
  name: 'sorting_network', machineOnly: true, witness: true,
  shape: `check {"n" (2–${SORT_MAX_N}), "below"}; answer: comparators as pairs of wires 0..n−1 in order, e.g. "(0,1) (2,3) (0,2)"; each puts the smaller value on the lower wire; fewer than "below", and every input comes out sorted`,
  async check(spec, output) {
    const n = whole(spec.n, 2, SORT_MAX_N), below = whole(spec.below, 1, SORT_MAX_COMPARATORS + 1);
    if (n === null || below === null) return no(`the check needs n from 2 to ${SORT_MAX_N} and "below"`);
    const cs = comparators(output, n);
    if (typeof cs === 'string') return no(cs);
    if (cs.length >= below) return no(`${cs.length} comparators; this step needs fewer than ${below}`);
    const w = new Uint32Array(n);
    const batches = n <= 5 ? 1 : 2 ** (n - 5);
    for (let hi = 0; hi < batches; hi++) {
      for (let i = 0; i < n; i++) w[i] = i < 5 ? LANE[i] : ((hi >> (i - 5)) & 1 ? 0xffffffff : 0);
      for (const [a, b] of cs) { const lo = w[a] & w[b], up = w[a] | w[b]; w[a] = lo; w[b] = up; }
      for (let i = 0; i + 1 < n; i++) if ((w[i] & ~w[i + 1]) >>> 0) {
        const lane = Math.clz32(0) - 1 - Math.clz32((w[i] & ~w[i + 1]) >>> 0);
        const x = (hi * 32 + lane) % 2 ** n;
        return no(`input ${x.toString(2).padStart(n, '0').split('').reverse().join('')} (wire 0 first) isn't sorted: wire ${i} gets 1 and wire ${i + 1} gets 0`);
      }
    }
    return ok(`${cs.length} comparators on ${n} wires; all ${2 ** n} zero-one inputs come out sorted, recomputed`);
  },
};

export const STRUCTURE_VERIFIERS = [matmulSchemeVerifier, linearCodeVerifier, sortingNetworkVerifier];
