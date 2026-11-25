import type { Check } from './second-checkers.js';
import { answerText, whole } from './combinatorics.js';
import { matmulSpec, matmulFactors, codeSpec, generator, field, type Field } from './structures.js';

/**
 * Second checkers for the structure witnesses (src/work/structures.ts), each by a different method. They share
 * the first checkers' parsing (the answer formats) and the field tables, not the arithmetic that decides.
 *
 * - matmul_scheme: per output entry, the bilinear form the scheme computes, in reduced fractions, compared with
 *   the one matrix multiplication needs (the first sums one sparse tensor, scaled to integers).
 * - linear_code: every codeword up to scalars normalised on its first nonzero coefficient, each computed from
 *   scratch (the first normalises on the last and updates incrementally); rank by eliminating columns.
 * - sorting_network: one input at a time as an integer, swapping bits (the first runs 32 inputs per word).
 */
const yes = (detail: string) => ({ ok: true, detail });
const nope = (detail: string) => ({ ok: false, detail });

type Frac = [bigint, bigint];
const g = (a: bigint, b: bigint): bigint => (b ? g(b, a % b) : a < 0n ? -a : a);
const red = ([n, d]: Frac): Frac => { if (!n) return [0n, 1n]; const k = g(n, d); return [n / k, d / k]; };
const fadd = (a: Frac, b: Frac): Frac => red([a[0] * b[1] + b[0] * a[1], a[1] * b[1]]);
const fmul = (a: Frac, b: Frac): Frac => red([a[0] * b[0], a[1] * b[1]]);

export const STRUCTURE_SECOND: Record<string, Check> = {
  async matmul_scheme(spec, output) {
    const s = matmulSpec(spec);
    if (typeof s === 'string') return nope(s);
    const f = matmulFactors(output, s);
    if (typeof f === 'string') return nope(f);
    const r = f.U.length;
    if (r >= s.below) return nope('too many products');
    if (s.n * s.p * r * s.n * s.m * s.m * s.p > 60_000_000) return nope('too large for the second check');
    const fr = (x: { num: bigint; den: bigint }): Frac => [x.num, x.den];
    for (let i = 0; i < s.n; i++) for (let k = 0; k < s.p; k++) {
      // coef[a][b]: the coefficient of A_a·B_b in the computed C[i][k].
      const coef: Frac[][] = Array.from({ length: s.n * s.m }, () => Array.from({ length: s.m * s.p }, (): Frac => [0n, 1n]));
      for (let t = 0; t < r; t++) {
        const w = fr(f.W[t][i * s.p + k]);
        if (!w[0]) continue;
        for (let a = 0; a < s.n * s.m; a++) {
          const u = fr(f.U[t][a]);
          if (!u[0]) continue;
          const wu = fmul(w, u);
          for (let b = 0; b < s.m * s.p; b++) { const v = fr(f.V[t][b]); if (v[0]) coef[a][b] = fadd(coef[a][b], fmul(wu, v)); }
        }
      }
      for (let a = 0; a < s.n * s.m; a++) for (let b = 0; b < s.m * s.p; b++) {
        const need = Math.floor(a / s.m) === i && b % s.p === k && a % s.m === Math.floor(b / s.p) ? 1n : 0n;
        const [num, den] = coef[a][b];
        const got = s.ring === 'F2' ? (((num % 2n) + 2n) % 2n) : num;
        if (s.ring === 'F2' ? got !== need : !(den === 1n && num === need)) return nope(`C[${i}][${k}] gets the wrong coefficient on A_${a}·B_${b}`);
      }
    }
    return yes(`every output entry is exactly the right bilinear form, with ${r} products`);
  },

  async linear_code(spec, output) {
    const s = codeSpec(spec);
    if (typeof s === 'string') return nope(s);
    const G = generator(output, s);
    if (typeof G === 'string') return nope(G);
    const { q, n, k, F } = s;
    if ((q ** k - 1) / (q - 1) * n * k > 1_500_000_000) return nope('too large for the second check');
    if (columnRank(G, F) !== k) return nope('rank below k');
    let min = n + 1;
    const coef = new Array(k).fill(0);
    for (let lead = 0; lead < k; lead++) {
      // First nonzero coefficient at `lead` is 1, those before it 0, those after it anything.
      const free = k - lead - 1;
      for (let x = 0; x < q ** free; x++) {
        coef.fill(0); coef[lead] = 1;
        for (let j = 0, y = x; j < free; j++, y = Math.floor(y / q)) coef[lead + 1 + j] = y % q;
        let w = 0;
        for (let col = 0; col < n; col++) {
          let v = 0;
          for (let row = 0; row < k; row++) if (coef[row]) v = F.add[v * q + F.mul[coef[row] * q + G[row][col]]];
          if (v) w++;
        }
        if (w < s.d) return nope(`a codeword of weight ${w}`);
        if (w < min) min = w;
      }
    }
    return yes(`minimum distance ${min}`);
  },

  async sorting_network(spec, output) {
    const n = whole(spec.n, 2, 22), below = whole(spec.below, 1, 2001);
    const text = answerText(output, 32_000);
    if (n === null || below === null || text === null) return nope('bad step or answer');
    const nums = (text.match(/\d+/g) ?? []).map(Number);
    if (nums.length % 2 || nums.length / 2 >= below) return nope('wrong number of comparators');
    const pairs: number[][] = [];
    for (let i = 0; i < nums.length; i += 2) { const a = Math.min(nums[i], nums[i + 1]), b = Math.max(nums[i], nums[i + 1]); if (a === b || b >= n) return nope('bad comparator'); pairs.push([1 << a, 1 << b]); }
    const all = (1 << n) - 1;
    for (let x = 0; x <= all; x++) {
      let y = x;
      for (const [lo, hi] of pairs) if ((y & lo) && !(y & hi)) y ^= lo | hi; // a 1 below a 0: swap them
      let ones = 0; for (let z = y; z; z &= z - 1) ones++;
      if (y !== (all ^ ((1 << (n - ones)) - 1))) return nope(`input ${x} comes out unsorted`);
    }
    return yes(`all ${2 ** n} inputs sorted`);
  },
};

/** Rank by eliminating columns (transpose, then reduce). */
function columnRank(G: number[][], F: Field): number {
  const q = F.q, T = G[0].map((_, c) => G.map((row) => row[c]));
  let r = 0;
  const k = G.length;
  for (let c = 0; c < k && r < T.length; c++) {
    const piv = T.findIndex((row, i) => i >= r && row[c] !== 0);
    if (piv < 0) continue;
    [T[r], T[piv]] = [T[piv], T[r]];
    for (let i = r + 1; i < T.length; i++) if (T[i][c]) {
      const f = F.mul[T[i][c] * q + F.inv[T[r][c]]];
      T[i] = T[i].map((x, j) => F.add[x * q + F.neg[F.mul[f * q + T[r][j]]]]);
    }
    r++;
  }
  return r;
}
export { field };
