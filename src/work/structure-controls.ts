import type { Controls } from './checker-controls.js';

/**
 * Controls for the structure checks (src/work/structures.ts, src/work/argmap.ts): answers known to be right, and
 * planted errors that must fail. Run with both checkers in the gate test (test/gates/results.test.ts).
 */

// 2×2 matrices with 7 multiplications (the classical 1969 scheme). U: A11 A12 A21 A22; V: B11 B12 B21 B22; W: C11 C12 C21 C22.
const seven = {
  U: [[1, 0, 0, 1], [0, 0, 1, 1], [1, 0, 0, 0], [0, 0, 0, 1], [1, 1, 0, 0], [-1, 0, 1, 0], [0, 1, 0, -1]],
  V: [[1, 0, 0, 1], [1, 0, 0, 0], [0, 1, 0, -1], [-1, 0, 1, 0], [0, 0, 0, 1], [1, 1, 0, 0], [0, 0, 1, 1]],
  W: [[1, 0, 0, 1], [0, 0, 1, -1], [0, 1, 0, 1], [1, 0, 1, 0], [-1, 1, 0, 0], [0, 0, 0, 1], [1, 0, 0, 0]],
};
/** The schoolbook scheme for n×m×p: one product per (i, j, k). */
export function schoolbook(n: number, m: number, p: number) {
  const U: number[][] = [], V: number[][] = [], W: number[][] = [];
  for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) for (let k = 0; k < p; k++) {
    U.push(Array.from({ length: n * m }, (_, a) => (a === i * m + j ? 1 : 0)));
    V.push(Array.from({ length: m * p }, (_, b) => (b === j * p + k ? 1 : 0)));
    W.push(Array.from({ length: n * p }, (_, c) => (c === i * p + k ? 1 : 0)));
  }
  return { U, V, W };
}
const halved = { U: seven.U.map((r, t) => (t === 0 ? r.map((x) => (x ? `${x}/2` : 0)) : r)), V: seven.V, W: seven.W.map((r, t) => (t === 0 ? r.map((x) => 2 * x) : r)) };
const flipped = { ...seven, W: seven.W.map((r, t) => (t === 4 ? [1, 1, 0, 0] : r)) };
const sq = (n: number) => ({ n, m: n, p: n });

const hamming = '1000110\n0100101\n0010011\n0001111';
const tetracode = '1 0 1 1\n0 1 1 2';
const hexacode = '1 0 0 1 2 2\n0 1 0 2 1 2\n0 0 1 2 2 1'; // GF(4) with x² + x + 1; 2 is x

const four = '(0,1) (2,3) (0,2) (1,3) (1,2)';

const map = (nodes: unknown[]) => JSON.stringify({ question: 'Take one box or both?', nodes });
const cite = [{ url: 'https://example.org/decision-theory', quote: 'A short quote from the source.' }];
const goodMap = map([
  { id: 'one', parent: 'root', type: 'position', claim: 'Take one box.' },
  { id: 'two', parent: 'root', type: 'position', claim: 'Take both boxes.' },
  { id: 'p1', parent: 'one', type: 'pro', claim: 'One-boxers tend to end up richer.', cites: cite, crux: true },
  { id: 'c1', parent: 'one', type: 'con', claim: 'Your choice cannot change what is already in the box.', cites: cite },
  { id: 'p2', parent: 'two', type: 'pro', claim: 'Two boxes always hold more than one, whatever was predicted.', cites: cite },
  { id: 'c2', parent: 'two', type: 'con', claim: 'A reliable predictor will have left the opaque box empty.', cites: cite },
  { id: 'o1', parent: 'p2', type: 'objection', claim: 'Dominance reasoning fails when the states depend on the act.', cites: cite },
  { id: 'r1', parent: 'o1', type: 'reply', claim: 'Here the contents are fixed before the act, so they do not depend on it.', cites: cite },
]);

export const STRUCTURE_CONTROLS: Record<string, Controls> = {
  matmul_scheme: {
    good: [
      { check: { ...sq(2), rank_below: 8, ring: 'Z' }, answer: JSON.stringify(seven), why: '2×2 with 7 products' },
      { check: { ...sq(2), rank_below: 8, ring: 'F2' }, answer: JSON.stringify({ U: seven.U.map((r) => r.map((x) => Math.abs(x))), V: seven.V.map((r) => r.map((x) => Math.abs(x))), W: seven.W.map((r) => r.map((x) => Math.abs(x))) }), why: 'the same scheme mod 2' },
      { check: { ...sq(2), rank_below: 8, ring: 'Q' }, answer: JSON.stringify(halved), why: 'a fraction in one product, made up in W' },
      { check: { n: 2, m: 3, p: 2, rank_below: 13, ring: 'Z' }, answer: JSON.stringify(schoolbook(2, 3, 2)), why: 'the schoolbook 2×3×2 scheme' },
    ],
    planted: [
      { check: { ...sq(2), rank_below: 8, ring: 'Z' }, answer: JSON.stringify(flipped), why: 'one sign changed' },
      { check: { ...sq(2), rank_below: 7, ring: 'Z' }, answer: JSON.stringify(seven), why: 'not below the bound' },
      { check: { ...sq(2), rank_below: 8, ring: 'Z' }, answer: JSON.stringify(halved), why: 'a fraction over the integers' },
      { check: { ...sq(2), rank_below: 8, ring: 'Z' }, answer: JSON.stringify({ ...seven, U: seven.U.map((r, t) => (t ? r : [0.5, 0, 0, 1])) }), why: 'a decimal' },
      { check: { ...sq(2), rank_below: 8, ring: 'Z' }, answer: JSON.stringify({ ...seven, W: seven.W.slice(1) }), why: 'W has one product too few' },
      { check: { n: 2, m: 3, p: 2, rank_below: 13, ring: 'Z' }, answer: JSON.stringify({ ...schoolbook(2, 3, 2), W: schoolbook(2, 3, 2).W.map((r, t) => (t === 11 ? r.map(() => 0) : r)) }), why: 'one product dropped from C' },
      { check: { ...sq(2), rank_below: 8, ring: 'F2' }, answer: JSON.stringify(seven), why: 'a −1 over F2' },
    ],
  },
  linear_code: {
    good: [
      { check: { q: 2, n: 7, k: 4, d_at_least: 3 }, answer: hamming, why: 'the [7,4,3] binary Hamming code' },
      { check: { q: 3, n: 4, k: 2, d_at_least: 3 }, answer: tetracode, why: 'the [4,2,3] ternary tetracode' },
      { check: { q: 4, n: 6, k: 3, d_at_least: 4, poly: [1, 1, 1] }, answer: hexacode, why: 'the [6,3,4] hexacode over GF(4)' },
    ],
    planted: [
      { check: { q: 2, n: 7, k: 4, d_at_least: 4 }, answer: hamming, why: 'distance 3, not 4' },
      { check: { q: 2, n: 7, k: 4, d_at_least: 2 }, answer: '1000110\n0100101\n0010011\n1110000', why: 'dependent rows' },
      { check: { q: 4, n: 6, k: 3, d_at_least: 4, poly: [1, 0, 1] }, answer: hexacode, why: 'x² + 1 is not irreducible over GF(2)' },
      { check: { q: 3, n: 4, k: 2, d_at_least: 3 }, answer: '1 0 1 1\n0 1 1 3', why: 'a symbol outside GF(3)' },
      { check: { q: 2, n: 7, k: 4, d_at_least: 3 }, answer: '1000110\n0100101\n0010011', why: 'too few rows' },
    ],
  },
  sorting_network: {
    good: [
      { check: { n: 4, below: 6 }, answer: four, why: 'an optimal 4-input network' },
      { check: { n: 3, below: 4 }, answer: '0 1, 1 2, 0 1', why: 'three inputs, three comparators' },
      { check: { n: 6, below: 16 }, answer: Array.from({ length: 6 }, (_, i) => Array.from({ length: 5 - i }, (_, j) => `(${j},${j + 1})`)).flat().join(' '), why: 'bubble sort on 6 wires' },
    ],
    planted: [
      { check: { n: 4, below: 6 }, answer: '(0,1) (2,3) (0,2) (1,3)', why: 'the last comparator missing' },
      { check: { n: 4, below: 5 }, answer: four, why: 'not below the bound' },
      { check: { n: 4, below: 6 }, answer: '(0,1) (2,3) (0,2) (1,4) (1,2)', why: 'a wire that isn’t there' },
      { check: { n: 6, below: 16 }, answer: Array.from({ length: 5 }, (_, i) => Array.from({ length: 5 - i }, (_, j) => `(${j},${j + 1})`)).flat().slice(1).join(' '), why: 'bubble sort with a pass cut short' },
    ],
  },
  argmap: {
    good: [{ check: { question: 'Take one box or both?', need: { position: 2, pro: 1, con: 1, objection: 1, reply: 1, crux: 1 }, depth: 1 }, answer: goodMap, why: 'a small, cited map' }],
    planted: [
      { check: { question: 'Take one box or both?', need: { position: 2 } }, answer: goodMap.replace('Take one box or both?', 'Is it rational?'), why: 'a different question' },
      { check: { question: 'Take one box or both?', need: { position: 2 } }, answer: map([{ id: 'one', parent: 'root', type: 'position', claim: 'Take one box.' }, { id: 'p1', parent: 'one', type: 'pro', claim: 'Richer.' }]), why: 'a pro without a source' },
      { check: { question: 'Take one box or both?', need: { position: 1 } }, answer: map([{ id: 'one', parent: 'root', type: 'position', claim: 'Take one box.' }, { id: 'r', parent: 'one', type: 'reply', claim: 'A reply to nothing.', cites: cite }]), why: 'a reply not under an objection' },
      { check: { question: 'Take one box or both?', need: { position: 1 } }, answer: map([{ id: 'a', parent: 'b', type: 'objection', claim: 'First.', cites: cite }, { id: 'b', parent: 'a', type: 'objection', claim: 'Second.', cites: cite }]), why: 'parents in a circle' },
      { check: { question: 'Take one box or both?', need: { position: 2 } }, answer: map([{ id: 'one', parent: 'root', type: 'position', claim: 'Take one box.' }, { id: 'two', parent: 'root', type: 'position', claim: 'take one box!' }]), why: 'the same claim twice' },
      { check: { question: 'Take one box or both?', need: { position: 3 } }, answer: goodMap, why: 'too few positions' },
      { check: { question: 'Take one box or both?', need: { position: 1 } }, answer: map([{ id: 'one', parent: 'root', type: 'position', claim: `Write to ${['someone', 'example.com'].join('@')} for the answer.` }]), why: 'an email address' },
    ],
  },
};
