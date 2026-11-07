import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Hub } from '../../src/hub/hub.js';
import { LocalSigner } from '../../src/core/identity.js';
import { parseAxioms, specProblem, judge, LEAN_PROJECTS, leanProjectVerifier, LeanProjectSpec } from '../../src/work/lean-project.js';
import { seedFeatured, AA_PROBLEM_TITLE, AA_DEBATE } from '../../src/seed/featured.js';
import { Worker } from '../../src/work/worker.js';
import type { Verifier } from '../../src/work/verifiers.js';
import type { ModelRunner } from '../../src/contributor/models.js';

/**
 * Re-checking a published Lean proof (docs/LEAN_PROJECTS.md): only reviewed projects at pinned commits are built;
 * a theorem passes when it rests only on Lean's standard axioms and a second computer's build agrees; machine work
 * runs only where it can (Lean installed), with no model and no spend.
 */
const AA = LEAN_PROJECTS[0];
const spec = (t = 'AaronsonAmbainis.aaronson_ambainis'): LeanProjectSpec => ({ repo: AA.repo, commit: AA.commit, module: 'AaronsonAmbainis.Main', theorems: [t] });
const line = (t: string, ax = 'propext, Classical.choice, Quot.sound') => `'${t}' depends on axioms: [${ax}]`;

describe('re-checking a published Lean proof', () => {
  it('reads Lean’s axiom report and passes only theorems on the standard axioms that both builds agree on', () => {
    expect([...parseAxioms(`${line('A.x')}\n'A.y' does not depend on any axioms\nnoise`)]).toEqual([['A.x', ['Classical.choice', 'Quot.sound', 'propext']], ['A.y', []]]);
    const t = 'AaronsonAmbainis.aaronson_ambainis';
    expect(judge(spec(t), line(t), line(t)).ok).toBe(true);
    expect(judge(spec(t), line(t, 'propext, sorryAx'), line(t, 'propext, sorryAx'))).toMatchObject({ ok: false, detail: expect.stringMatching(/sorryAx \(an unfinished proof\)/) });
    expect(judge(spec(t), line(t, 'propext, Classical.choice, Quot.sound, myAxiom'), line(t))).toMatchObject({ ok: false, detail: expect.stringMatching(/rests on myAxiom/) });
    expect(judge(spec(t), line(t), line(t, 'propext'))).toMatchObject({ ok: false, detail: expect.stringMatching(/doesn’t match/) });
    expect(judge(spec(t), line(t), 'nothing')).toMatchObject({ ok: false });
  });

  it('builds only reviewed projects at their pinned commit, and needs Lean on the computer', async () => {
    expect(specProblem(spec())).toBeNull();
    expect(specProblem({ ...spec(), commit: 'f'.repeat(40) })).toMatch(/reviewed list/);
    expect(specProblem({ ...spec(), repo: 'https://github.com/someone/else' })).toMatch(/reviewed list/);
    expect(specProblem({ ...spec(), theorems: ['x; #eval IO.Process.exit 0'] })).toMatch(/declaration names/);
    expect(specProblem({ ...spec(), commit: 'main' })).toMatch(/40-character/);
    process.env.CONSTELLATE_LAKE = 'off';
    try {
      expect(leanProjectVerifier.available!()).toBe(false);
      expect(await leanProjectVerifier.check(spec() as never, line('AaronsonAmbainis.aaronson_ambainis'))).toMatchObject({ ok: false, detail: expect.stringMatching(/Lean isn’t installed/) });
    } finally { delete process.env.CONSTELLATE_LAKE; }
  });

  it('every install opens with the problem (four machine-checked steps) and the debate, once', async () => {
    process.env.CONSTELLATE_HOME = mkdtempSync(join(tmpdir(), 'aa-'));
    try {
      const hub = new Hub({ signer: LocalSigner.generate(), preview: false });
      const r = await seedFeatured(hub);
      expect(r.problem).toBeTruthy();
      const p = hub.problems.get(r.problem!)!.rec.body as { title: string; realm: string; definition_of_done: { verifier: string }; chunks: { key: string; check: LeanProjectSpec }[] };
      expect(p).toMatchObject({ title: AA_PROBLEM_TITLE, realm: 'maths_physics', definition_of_done: { verifier: 'lean_project' } });
      expect(p.chunks.map((c) => c.key)).toEqual(['printed', 'explicit', 'plus-minus', 'improved']);
      for (const c of p.chunks) expect(specProblem(c.check)).toBeNull();
      expect(hub.deliberation.questions().map((q) => (q.rec.body as { question: string }).question)).toEqual([AA_DEBATE]);
      expect(await seedFeatured(hub)).toEqual({ problem: null, debate: null }); // not twice
      expect(JSON.stringify(hub.node.store.all().map((s) => s.rec.body))).not.toMatch(/@psi\.inc|Turturean/); // organisations only
    } finally { delete process.env.CONSTELLATE_HOME; }
  });

  it('machine work runs only where it can, with no model and no spend, and a second computer’s check makes the checkpoint', async () => {
    process.env.CONSTELLATE_HOME = mkdtempSync(join(tmpdir(), 'aa-'));
    try {
      let can = false, builds = 0;
      const fake: Verifier = {
        name: 'fake_build', machineOnly: true, available: () => can,
        work: async () => { builds++; return line('T.main'); },
        check: async (_s, out) => ({ ok: out === line('T.main'), detail: 'rebuilt' }),
      };
      const model = (fam: string): ModelRunner => ({ id: `m:${fam}`, family: fam, size: 'small', costPerCall: 1, run: async () => { throw new Error('no model should run for machine work'); } });
      const author = new Hub({ signer: LocalSigner.generate(), preview: false });
      author.problems.verifiers.register(fake);
      const { record } = await author.problems.propose({ title: 'Rebuild T', hook: '', goal: 'Rebuild T and report its axioms.', realm: 'maths_physics', definition_of_done: { verifier: 'fake_build', description: 'rebuilt' }, chunks: [{ key: 'main', title: 'Rebuild T', prompt: 'build', check: {}, needs: { size: 'large' } }] }, { publish: true });
      const a = new Hub({ signer: LocalSigner.generate(), preview: false }), b = new Hub({ signer: LocalSigner.generate(), preview: false });
      for (const h of [a, b]) { h.problems.verifiers.register(fake); h.node.ingest(record); }
      const wa = new Worker(a, model('alpha'), a.problems, a.board), wb = new Worker(b, model('beta'), b.problems, b.board);
      expect(await wa.step(record.id)).toBe('idle'); // no Lean here: leave it
      can = true;
      expect(await wa.step(record.id)).toBe('worked'); // a 'small' model still takes a 'large' build: the machine does it
      const result = a.node.store.ofKind('task_result')[0];
      expect(result.rec.body).toMatchObject({ model: 'lean-kernel (lake build)', family: 'machine', output: line('T.main') });
      b.node.ingest(result.rec);
      expect(await wb.step(record.id)).toBe('verified');
      expect(builds).toBe(1);
    } finally { delete process.env.CONSTELLATE_HOME; }
  });
});
