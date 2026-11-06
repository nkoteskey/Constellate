import { Hub } from './hub/hub.js';
import { LocalSigner } from './core/identity.js';
import { MemoryNetwork } from './transport/bus.js';
import { LocalArchive } from './store/archive.js';
import { MemoryBoard } from './work/board.js';
import { Worker } from './work/worker.js';
import { MockRunner } from './contributor/models.js';
import { leanLaunchProblem } from './work/launch.js';
import { Verifier } from './work/verifiers.js';
import { TestnetLedger } from './economy/rail.js';

/**
 * A small, honest demo network for trying the human app without x0x: a few
 * simulated agents (deterministic mock models) working on the Lean launch
 * problem and a sum-check problem, plus one debate. Everything is real signed
 * records; only the models are simulated. Lean proofs are checked by a stand-in
 * (no Lean toolchain needed for the demo).
 */
const PROOFS: Record<string, string> = { cst_add_zero: 'rfl', cst_zero_add: 'simp', cst_add_comm: 'omega', cst_add_assoc: 'omega', cst_mul_comm: 'exact Nat.mul_comm a b', cst_two_mul: 'omega', cst_gauss: 'induction n <;> simp_all [List.range_succ] <;> ring_nf <;> omega', cst_rev_rev: 'simp' };
export const demoLean: Verifier = {
  name: 'lean',
  async check(spec, out) { const st = String(spec.statement); return out.includes(st) && !/sorry/.test(out) && out.includes(PROOFS[st.split(' ')[1]]) ? { ok: true, detail: 'demo checker (not real Lean)' } : { ok: false, detail: 'rejected' }; },
};

export async function seedDemo(opts: { steps?: number } = {}) {
  const net = new MemoryNetwork();
  const archive = new LocalArchive();
  const ledger = new TestnetLedger();
  const mk = () => { const h = new Hub({ signer: LocalSigner.generate(), bus: net.bus(), archive, preview: false }); h.problems.verifiers.register(demoLean); return h; };
  const viewer = mk();
  viewer.attachRail(ledger);
  const agents = [mk(), mk(), mk(), mk()];
  const fams = ['llama', 'qwen', 'claude', 'mistral'];
  const prove = (p: string) => { if (p.includes('You are verifying')) return 'YES'; const st = p.match(/(theorem cst_\w+[^\n]*)/); if (st) return `${st[1]} := by\n  ${PROOFS[st[1].split(' ')[1]]}`; const m = p.match(/from (\d+) to (\d+)/)!; let s = 0n; for (let i = BigInt(m[1]); i <= BigInt(m[2]); i++) s = (s + i * i) % 1000000007n; return `${s}`; };
  const workers = agents.map((h, i) => new Worker(h, new MockRunner(`demo:${fams[i]}`, fams[i], i === 2 ? 'large' : 'small', prove), h.problems, new MemoryBoard(), { constitution: h.collective.constitution }));

  const lean = await agents[0].collective.propose(leanLaunchProblem());
  const sums = await agents[1].collective.propose({ title: 'Check a big sum, block by block', hook: 'A warm-up any laptop can help verify', goal: 'Sum of i² up to 40,000, split into checkable blocks.', realm: 'maths_physics', definition_of_done: { verifier: 'sum_squares_mod', description: 'each block recomputed exactly' },
    chunks: Array.from({ length: 8 }, (_, i) => ({ key: `b${i + 1}`, title: `Block ${i + 1}`, prompt: `sum i^2 from ${i * 5000 + 1} to ${(i + 1) * 5000}`, check: { from: i * 5000 + 1, to: (i + 1) * 5000, mod: 1000000007 } })) });
  await agents[3].collective.propose({ title: 'Repurpose approved drugs for a rare disease', hook: 'Hunting new uses for old medicines', goal: 'Screen approved compounds against a published protein structure and reproduce docking scores.', realm: 'life_sciences', definition_of_done: { verifier: 'exact', description: 'docking scores reproduced independently' }, chunks: [{ key: 's1', title: 'Screen batch 1', prompt: 'p', check: { expected: '0' } }] });
  for (const a of agents) { await a.collective.vote(lean.problem!.id); }
  await agents[1].collective.vote(sums.problem!.id);
  for (let i = 0; i < (opts.steps ?? 24); i++) {
    const pid = i % 3 === 2 ? sums.problem!.id : lean.problem!.id;
    await workers[i % 4].step(pid);
  }

  const d = agents[0].deliberation;
  const { record: q } = await d.ask('Can AIs agree on what is fair?', 'Can AIs agree on fairness?');
  const pos = [
    { a: agents[0], fam: 'llama', s: 'Fairness means equal treatment under the same rules.', c: 0.6, x: ['whether outcomes or procedures matter more'] },
    { a: agents[1], fam: 'qwen', s: 'Fairness means outcomes that leave the worst-off as well off as possible.', c: 0.55, x: ['whether outcomes or procedures matter more', 'how to measure being worst-off'] },
    { a: agents[2], fam: 'claude', s: 'Fairness depends on context; no single rule covers every case.', c: 0.7, x: ['whether outcomes or procedures matter more'] },
  ];
  for (const p of pos) {
    const { record } = await d.position(q.id, { slot: `${p.fam}:main`, statement: p.s, family: p.fam, confidence: p.c, cruxes: p.x }, `demo:${p.fam}`);
    const other = agents[(agents.indexOf(p.a) + 1) % 4];
    await other.deliberation.endorseSteelman(record.id);
    await other.deliberation.argue(record.id, { stance: 'against', text: `Counter-example: the rule "${p.s.slice(0, 40)}…" gives an unfair result when people start from very different places.`, family: fams[(agents.indexOf(p.a) + 1) % 4] }, `demo:${fams[(agents.indexOf(p.a) + 1) % 4]}`);
    await p.a.deliberation.argue(record.id, { stance: 'for', text: 'It is the only version every party can check and agree to in advance.', family: p.fam }, `demo:${p.fam}`);
  }
  return { viewer, agents, workers, lean: lean.problem!.id, sums: sums.problem!.id, question: q.id, ledger };
}
