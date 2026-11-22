import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { agreement, criticalPath, importsOf, planSlices, readProject, sliceSteps, type LeanModule } from '../../src/work/lean-distributed.js';
import { orderProblem } from '../../src/work/problems.js';

/**
 * A huge Lean proof checked by many computers (docs/DISTRIBUTED_LEAN.md): the import graph cut into slices in
 * dependency order, each built by several independent computers that must produce identical files, then the axiom
 * check. This covers the part that needs no Lean; the build itself is the next step.
 */
const h = (c: string) => c.repeat(64);

describe('distributed Lean checking: the plan', () => {
  it('reads imports from a Lean file header only', () => {
    expect(importsOf('/- a\nproject -/\nimport Mathlib.Data.Nat\nimport Foo.Bar Foo.Baz -- two\n\nopen Nat\nimport NotAnImport\n')).toEqual(['Mathlib.Data.Nat', 'Foo.Bar', 'Foo.Baz']);
    expect(importsOf('module\npublic import A.B\nimport all C\ntheorem x : True := trivial')).toEqual(['A.B', 'C']);
  });

  it('reads a project, cuts it into slices in dependency order, and the slices form a valid step order', () => {
    const root = mkdtempSync(join(tmpdir(), 'lean-proj-'));
    const file = (name: string, imports: string[], lines = 10) => {
      const p = join(root, ...name.split('.')) + '.lean';
      mkdirSync(join(p, '..'), { recursive: true });
      writeFileSync(p, `${imports.map((i) => `import ${i}`).join('\n')}\n${'-- proof line\n'.repeat(lines)}`);
    };
    file('RH.Basic', ['Mathlib.Analysis.Complex'], 100);
    file('RH.Zeta', ['RH.Basic'], 300);
    file('RH.Zeros', ['RH.Basic'], 300);
    file('RH.Main', ['RH.Zeta', 'RH.Zeros'], 50);
    writeFileSync(join(root, 'lakefile.lean'), 'import Lake');
    const mods = readProject(root);
    expect(mods.map((m) => m.name).sort()).toEqual(['RH.Basic', 'RH.Main', 'RH.Zeros', 'RH.Zeta']);

    const slices = planSlices(mods, { maxCost: 350 });
    expect(slices.map((s) => [s.key, s.modules, s.after])).toEqual([
      ['L0-1', ['RH.Basic'], []],
      ['L1-1', ['RH.Zeros'], ['L0-1']], // the two middle modules don't fit one slice of 350 lines: built in parallel
      ['L1-2', ['RH.Zeta'], ['L0-1']],
      ['L2-1', ['RH.Main'], ['L1-1', 'L1-2']],
    ]);
    expect(criticalPath(slices)).toBe(3);
    const steps = sliceSteps({ repo: 'https://github.com/example/rh', commit: 'a'.repeat(40), theorems: ['RH.riemann_hypothesis'], target: 'RH.Main' }, slices);
    expect(steps.at(-1)).toMatchObject({ key: 'axioms', after: ['L2-1'] });
    expect(orderProblem(steps)).toBeNull(); // every step can open, in order
  });

  it('scales: thousands of modules become slices whose longest chain is the graph depth, not the module count', () => {
    let seed = 3;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const mods: LeanModule[] = [];
    for (let i = 0; i < 3000; i++) mods.push({ name: `M${i}`, imports: i ? [...new Set(Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => `M${Math.floor(rnd() * i)}`))] : [], cost: 200 + Math.floor(rnd() * 3000) });
    const slices = planSlices(mods, { maxCost: 40_000 });
    const total = mods.reduce((n, m) => n + m.cost, 0);
    expect(slices.reduce((n, s) => n + s.cost, 0)).toBe(total);
    expect(new Set(slices.flatMap((s) => s.modules)).size).toBe(3000); // every module exactly once
    expect(slices.every((s) => s.cost <= 40_000 || s.modules.length === 1)).toBe(true);
    const pos = new Map(slices.map((s, i) => [s.key, i]));
    expect(slices.every((s, i) => s.after.every((a) => pos.get(a)! < i))).toBe(true); // dependency order
    expect(criticalPath(slices)).toBeLessThan(slices.length / 3); // most slices can build side by side
    expect(() => planSlices([{ name: 'A', imports: ['B'], cost: 1 }, { name: 'B', imports: ['A'], cost: 1 }])).toThrow(/cycle/);
  });

  it('a slice counts once independent computers built identical files; a mismatch is a dispute, not a vote', () => {
    const slice = { key: 'L0-1', modules: ['RH.Basic', 'RH.Zeta'], after: [], cost: 1, level: 0 };
    const good = { 'RH.Basic': h('1'), 'RH.Zeta': h('2') };
    const r = (operator: string, outputs: Record<string, string>, toolchain = 'leanprover/lean4:v4.33.0') => ({ slice: 'L0-1', operator, toolchain, outputs });
    expect(agreement(slice, [r('a', good)]).status).toBe('waiting');
    expect(agreement(slice, [r('a', good), r('a', good)]).status).toBe('waiting'); // the same operator twice is one build
    expect(agreement(slice, [r('a', good), r('b', good)])).toMatchObject({ status: 'agreed', outputs: good, builders: 2 });
    expect(agreement(slice, [r('a', good), r('b', { ...good, 'RH.Zeta': h('3') })]).status).toBe('disputed');
    expect(agreement(slice, [r('a', good), r('b', { 'RH.Basic': h('1') })]).status).toBe('waiting'); // incomplete reports don't count
    // A different toolchain builds different files legitimately: not a dispute, just not the same build.
    expect(agreement(slice, [r('a', good), r('b', { ...good, 'RH.Zeta': h('4') }, 'leanprover/lean4:v4.34.0')]).status).toBe('waiting');
    expect(agreement(slice, [r('a', good), r('b', good), r('c', good)], 3).status).toBe('agreed');
  });

  it('is documented', () => {
    const doc = readFileSync(new URL('../../docs/DISTRIBUTED_LEAN.md', import.meta.url), 'utf8');
    for (const s of ['slice', 'quorum', '.olean', 'lean4checker', 'critical path', 'Mathlib']) expect(doc).toContain(s);
  });
});
