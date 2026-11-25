import { describe, it, expect } from 'vitest';
import { linearCodeVerifier, sortingNetworkVerifier, matmulSchemeVerifier, field } from '../../src/work/structures.js';
import { argmapVerifier } from '../../src/work/argmap.js';
import { STRUCTURE_SECOND } from '../../src/work/second-structures.js';
import { schoolbook } from '../../src/work/structure-controls.js';
import { VerifierRegistry } from '../../src/work/verifiers.js';

/**
 * The built-in structure checks (docs/CHECKERS.md): matrix multiplication schemes, linear codes, sorting networks
 * and argument maps. Each first checker is cross-checked against its second on random answers, right and wrong:
 * they must agree every time. Sizes are capped before any work.
 */
let seed = 11;
const rnd = (q: number) => (seed = (seed * 1103515245 + 12345) % 2 ** 31) % q;

describe('structure checks', () => {
  it('are registered, with shapes agents can read', () => {
    const reg = new VerifierRegistry();
    for (const n of ['matmul_scheme', 'linear_code', 'sorting_network', 'argmap']) expect(reg.get(n)?.shape).toBeTruthy();
  });

  it('sorting networks: both checkers agree on 300 random networks', async () => {
    for (let trial = 0; trial < 300; trial++) {
      const n = 2 + (trial % 9), len = 1 + rnd(30);
      const cs = Array.from({ length: len }, () => { const a = rnd(n); let b = rnd(n); if (b === a) b = (a + 1) % n; return `(${a},${b})`; }).join(' ');
      const spec = { n, below: 100 };
      expect((await sortingNetworkVerifier.check(spec, cs)).ok, cs).toBe((await STRUCTURE_SECOND.sorting_network(spec, cs)).ok);
    }
  });

  it('linear codes: both checkers find the same minimum distance on random codes over GF(2), GF(3), GF(4), GF(5), GF(8)', async () => {
    const fields: [number, number[] | undefined][] = [[2, undefined], [3, undefined], [4, [1, 1, 1]], [5, undefined], [8, [1, 1, 0, 1]]];
    for (let trial = 0; trial < 60; trial++) {
      const [q, poly] = fields[trial % fields.length];
      const k = 1 + rnd(3), n = k + 1 + rnd(6);
      const G = Array.from({ length: k }, () => Array.from({ length: n }, () => rnd(q)).join(' ')).join('\n');
      for (const d of [1, 2, 3, 4]) {
        const spec = { q, n, k, d_at_least: d, ...(poly ? { poly } : {}) };
        expect((await linearCodeVerifier.check(spec, G)).ok, `${q} ${G} d≥${d}`).toBe((await STRUCTURE_SECOND.linear_code(spec, G)).ok);
      }
    }
    expect(field(8, [1, 0, 0, 1])).toMatch(/not irreducible/); // x³ + 1 = (x + 1)(x² + x + 1)
    expect(field(6)).toMatch(/prime or a prime power/);
  });

  it('matrix schemes: both checkers agree on the schoolbook scheme and on every single-entry change of a 2×2×3 one', async () => {
    const base = schoolbook(2, 2, 3);
    const spec = { n: 2, m: 2, p: 3, rank_below: 13, ring: 'Z' };
    expect((await matmulSchemeVerifier.check(spec, JSON.stringify(base))).ok).toBe(true);
    let wrong = 0;
    for (const key of ['U', 'V', 'W'] as const) for (let t = 0; t < 12; t++) for (let e = 0; e < base[key][t].length; e++) {
      const s = structuredClone(base);
      s[key][t][e] = s[key][t][e] ? 0 : 1;
      const a = await matmulSchemeVerifier.check(spec, JSON.stringify(s)), b = await STRUCTURE_SECOND.matmul_scheme(spec, JSON.stringify(s));
      expect(a.ok).toBe(b.ok);
      if (!a.ok) wrong++;
    }
    expect(wrong).toBeGreaterThan(100); // nearly every change breaks it
    expect((await matmulSchemeVerifier.check({ n: 9, m: 2, p: 2, rank_below: 5 }, '{}')).detail).toMatch(/1 to 8/);
  });

  it('matrix schemes: a 4×4×4 check takes milliseconds', async () => {
    const t0 = Date.now();
    expect((await matmulSchemeVerifier.check({ n: 4, m: 4, p: 4, rank_below: 65 }, JSON.stringify(schoolbook(4, 4, 4)))).ok).toBe(true);
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it('argument maps: structure only, cited, no personal names', async () => {
    const q = 'Should we?';
    const m = (nodes: unknown[]) => JSON.stringify({ question: q, nodes });
    const cite = [{ url: 'https://example.org/a', quote: 'A quote.' }];
    expect((await argmapVerifier.check({ question: q, need: { position: 1 } }, m([{ id: 'a', parent: 'root', type: 'position', claim: 'Yes.' }]))).detail).toMatch(/says nothing about which side is right/);
    const named = ['Ada', 'Lovelace'].join(' ');
    expect((await argmapVerifier.check({ question: q }, m([{ id: 'a', parent: 'root', type: 'position', claim: `As ${named} argued, yes.` }]))).detail).toMatch(/personal data/);
    expect((await argmapVerifier.check({ question: q, need: { pro: 1 } }, m([{ id: 'a', parent: 'root', type: 'position', claim: 'Yes.' }, { id: 'b', parent: 'root', type: 'position', claim: 'No.' }, { id: 'p', parent: 'a', type: 'pro', claim: 'Good.', cites: cite }]))).detail).toMatch(/position "b" has no pro/);
  });
});
