import type { WitnessVerifier } from './witness.js';
import { answerText, whole } from './combinatorics.js';

/**
 * Hadamard matrices from four circulant blocks (the Goethals–Seidel array). A Hadamard matrix of order n is an
 * n × n matrix of ±1 with H Hᵀ = n I. Four ±1 sequences a, b, c, d of length v whose periodic autocorrelations
 * sum to zero at every nonzero shift give one of order 4v through the Goethals–Seidel array, so the four lines are a
 * certificate: 4v characters instead of (4v)² entries, and any computer checks them in a fraction of a second.
 *
 * This accepts that one structure only. Other constructions (Spence's bordered arrays, Miyamoto's blocks…) can
 * settle the same orders; each would be its own check (docs/OPEN_PROBLEMS.md).
 */
export const MAX_GS_V = 5000;

const ok = (detail: string) => ({ ok: true, detail });
const no = (detail: string) => ({ ok: false, detail });

/** Four lines of + and − (or - and 1/-1 written as + and -), each exactly v long. */
export function parseGs(output: string, v: number): Int8Array[] | string {
  const text = answerText(output, 4 * (v + 2) + 64);
  if (text === null) return 'answer too long';
  const lines = text.split('\n').map((l) => l.trim().replace(/−/g, '-')).filter(Boolean);
  if (lines.length !== 4) return `give exactly four lines of + and -; this has ${lines.length}`;
  const out: Int8Array[] = [];
  for (const [i, l] of lines.entries()) {
    if (!/^[+-]+$/.test(l)) return `line ${i + 1} must be only + and - characters`;
    if (l.length !== v) return `line ${i + 1} has ${l.length} entries; this step needs exactly ${v}`;
    out.push(Int8Array.from(l, (ch) => (ch === '+' ? 1 : -1)));
  }
  return out;
}

/** Order n = 4v from four circulant blocks: Σ over the four sequences of Σᵢ x(i)·x(i+s mod v) is 0 for every s ≠ 0. */
export const hadamardGsVerifier: WitnessVerifier = {
  name: 'hadamard_gs', machineOnly: true, witness: true,
  shape: `check {"n": order, a multiple of 4 up to ${4 * MAX_GS_V}}; answer: four lines of + and -, each n/4 long, whose periodic autocorrelations sum to 0 at every nonzero shift (Goethals–Seidel: they give a Hadamard matrix of order n)`,
  async check(spec, output) {
    const n = whole(spec.n, 4, 4 * MAX_GS_V);
    if (n === null || n % 4) return no(`the check needs n, a multiple of 4 up to ${4 * MAX_GS_V}`);
    const v = n / 4;
    const seqs = parseGs(output, v);
    if (typeof seqs === 'string') return no(seqs);
    for (let s = 1; s < v; s++) {
      let sum = 0;
      for (const x of seqs) for (let i = 0; i < v; i++) sum += x[i] * x[(i + s) % v];
      if (sum !== 0) return no(`the autocorrelations sum to ${sum}, not 0, at shift ${s}`);
    }
    return ok(`four sequences of length ${v}, autocorrelations sum to 0 at every shift, recomputed: a Hadamard matrix of order ${n} (Goethals–Seidel array)`);
  },
};
