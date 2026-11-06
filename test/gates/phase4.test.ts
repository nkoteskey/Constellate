import { describe, it, expect } from 'vitest';
import { Hub } from '../../src/hub/hub.js';
import { LocalSigner } from '../../src/core/identity.js';
import { signRecord } from '../../src/core/record.js';
import { LocalArchive } from '../../src/store/archive.js';
import { MemoryNetwork } from '../../src/transport/bus.js';
import { Collective } from '../../src/collective/collective.js';
import { Constitution } from '../../src/collective/constitution.js';
import { leanLaunchProblem } from '../../src/work/launch.js';
import { MemoryBoard } from '../../src/work/board.js';
import { Worker } from '../../src/work/worker.js';
import { MockRunner } from '../../src/contributor/models.js';
import { Verifier } from '../../src/work/verifiers.js';
import { CheckpointBody } from '../../src/work/problems.js';

/**
 * GATE 4: the launch problem makes verified progress chosen by real votes.
 * Lean is not installable in the build session, so the gate swaps in a stand-in
 * `lean` verifier that accepts only the known-good proofs below. Re-run with real
 * Lean: CONSTELLATE_LEAN=lean (READY FOR HUMAN TESTING).
 */
const PROOFS: Record<string, string> = {
  cst_add_zero: 'rfl', cst_zero_add: 'simp', cst_add_comm: 'omega', cst_add_assoc: 'omega', cst_mul_comm: 'exact Nat.mul_comm a b', cst_two_mul: 'omega',
  cst_gauss: 'induction n with\n  | zero => rfl\n  | succ k ih => simp [List.range_succ, List.sum_append] at *; ring_nf; omega', cst_rev_rev: 'simp',
};
const fakeLean: Verifier = {
  name: 'lean',
  async check(spec, out) {
    const st = String(spec.statement);
    const name = st.split(' ')[1];
    return out.includes(st) && !/sorry|admit/.test(out) && out.includes(PROOFS[name]) ? { ok: true, detail: 'stand-in lean ok' } : { ok: false, detail: 'stand-in lean rejected' };
  },
};
const prove = (p: string) => {
  if (p.includes('You are verifying')) return 'YES';
  const st = p.match(/(theorem cst_\w+[^\n]*)/)![1];
  return `${st} := by\n  ${PROOFS[st.split(' ')[1]]}`;
};
const sumSq = (p: string) => { if (p.includes('You are verifying')) return 'YES'; const m = p.match(/from (\d+) to (\d+)/)!; let s = 0n; for (let i = BigInt(m[1]); i <= BigInt(m[2]); i++) s = (s + i * i) % 1000000007n; return `${s}`; };

function setup() {
  const net = new MemoryNetwork();
  const archive = new LocalArchive();
  const reviewer = LocalSigner.generate();
  const mk = (s = LocalSigner.generate()) => {
    const h = new Hub({ signer: s, bus: net.bus(), archive, preview: false, trusted: [reviewer.agentId] });
    h.problems.verifiers.register(fakeLean);
    return h;
  };
  return { net, mk, reviewer };
}

describe('GATE 4 — collective', () => {
  it('the Lean launch problem makes verified progress, chosen by real votes over a Sybil pledge flood', async () => {
    const { mk } = setup();
    const families = ['llama', 'qwen', 'claude', 'mistral'];
    const honest = families.map(() => mk());
    const cols = honest.map((h) => new Collective(h));
    const board = new MemoryBoard();
    const workers = honest.map((h, i) => new Worker(h, new MockRunner(`m:${families[i]}`, families[i], i === 2 ? 'large' : 'small', (p) => (p.includes('cst_') ? prove(p) : sumSq(p))), h.problems, board, { constitution: cols[i].constitution }));

    // Warm-up: honest operators deliver verified compute, which is what gives votes weight.
    const warm = await cols[0].propose({ title: 'Warm-up sums', goal: 'warm up', realm: 'maths_physics', definition_of_done: { verifier: 'sum_squares_mod', description: 'recomputed' },
      chunks: Array.from({ length: 8 }, (_, i) => ({ key: `w${i}`, title: `w${i}`, prompt: `sum i^2 from ${i * 100 + 1} to ${(i + 1) * 100}`, check: { from: i * 100 + 1, to: (i + 1) * 100, mod: 1000000007 } })) });
    expect(warm.problem).not.toBeNull();
    for (let i = 0; i < 80 && (await honest[0].problems.state(warm.problem!.id)).done < 8; i++) await workers[i % 4].step(warm.problem!.id);
    for (const c of cols) await c.pledge(10);
    // Voting on the warm-up is over: give it no further votes.

    // Proposals
    const lean = await cols[0].propose(leanLaunchProblem());
    const cubes = await cols[1].propose({ title: 'Sum of cubes table', goal: 'cubes', realm: 'maths_physics', definition_of_done: { verifier: 'exact', description: 'exact' }, chunks: [{ key: 'k', title: 'k', prompt: 'p', check: { expected: '1' } }] });
    const bad = await cols[2].propose({ title: 'Make a virus spread faster', goal: 'Enhance transmissibility of an influenza strain', realm: 'life_sciences', definition_of_done: { verifier: 'exact', description: 'x' }, chunks: [{ key: 'a', title: 'a', prompt: 'a', check: {} }] });
    const bio = await cols[3].propose({ title: 'Screen approved drugs against a rare-disease target', hook: 'Repurpose existing medicines', goal: 'Dock approved compounds against a published protein structure', realm: 'life_sciences', definition_of_done: { verifier: 'exact', description: 'docking score reproduced' }, chunks: [{ key: 'a', title: 'a', prompt: 'a', check: {} }] });
    expect(bad.problem).toBeNull(); // blocked at start, never broadcast
    expect(bad.check.findings[0].rule).toBe('life_sciences_safety');
    expect(cols[0].constitution.status(bio.problem!.id).state).toBe('awaiting_review');

    // Votes: all four honest operators back Lean; one also backs cubes.
    for (const c of cols) await c.vote(lean.problem!.id);
    await cols[1].vote(cubes.problem!.id);
    // A Sybil flood: 60 fresh keys pledge enormous compute and vote for cubes.
    for (let i = 0; i < 60; i++) {
      const s = LocalSigner.generate();
      for (const d of [{ kind: 'pledge' as const, body: { hours_per_week: 5000 }, refs: [] }, { kind: 'vote' as const, body: { problem: cubes.problem!.id, support: true }, refs: [cubes.problem!.id] }]) {
        const r = await signRecord({ ...d, context: { task: 'x', domain: ['collective'], environment: '' } }, s);
        for (const h of honest) h.node.ingest(r);
      }
    }

    const q = await cols[0].queue();
    expect(q.active[0].id).toBe(lean.problem!.id);
    expect(q.active[0].share).toBeGreaterThan(0.6);
    expect(q.active.map((r) => r.id)).not.toContain(bio.problem!.id);
    expect(cols[0].tally(cubes.problem!.id).voters).toBe(61);

    // Compute follows the votes.
    const spent: Record<string, number> = {};
    for (let i = 0; i < 60; i++) {
      const pid = await cols[i % 4].next();
      if (!pid) break;
      spent[pid] = (spent[pid] ?? 0) + 1;
      await workers[i % 4].step(pid);
      if ((await honest[0].problems.state(lean.problem!.id)).done >= 6) break;
    }
    expect(spent[lean.problem!.id]).toBeGreaterThan(spent[cubes.problem!.id] ?? 0);
    const st = await honest[3].problems.state(lean.problem!.id);
    expect(st.done).toBeGreaterThanOrEqual(6);
    for (const c of st.chunks.filter((x) => x.checkpoint)) expect((c.checkpoint!.rec.body as unknown as CheckpointBody).machine_check).toBe('stand-in lean ok');
  }, 120_000);

  it('a constitution violation at a checkpoint pauses work until a human reviews it', async () => {
    const { mk, reviewer } = setup();
    const a = mk(), b = mk(), human = mk(reviewer);
    const col = new Collective(a);
    const { problem } = await col.propose(leanLaunchProblem());
    const board = new MemoryBoard();
    const tainted = (p: string) => (p.includes('You are verifying') ? 'YES' : `-- see notes on enhancing transmissibility of a virus\n${prove(p)}`);
    const wa = new Worker(a, new MockRunner('m:llama', 'llama', 'small', tainted), a.problems, board, { constitution: col.constitution });
    const wb = new Worker(b, new MockRunner('m:qwen', 'qwen', 'small', prove), b.problems, board, { constitution: new Constitution(b) });
    await wa.step(problem!.id); // produces a tainted result
    expect(await wb.step(problem!.id)).toBe('rejected'); // verifier's constitution check catches it
    expect(col.constitution.status(problem!.id).state).toBe('paused');
    expect(await wb.step(problem!.id)).toBe('idle'); // nobody works on a paused problem
    await new Constitution(human).humanReview(problem!.id, 'approve', 'Comment is noise; output contains no hazardous content. Resume.');
    expect(col.constitution.status(problem!.id).state).toBe('cleared');
    expect(await wb.step(problem!.id)).toBe('worked'); // the flagged result is not re-verified; its chunk is redone
    expect(col.constitution.status(problem!.id).state).toBe('cleared');
  });
});
