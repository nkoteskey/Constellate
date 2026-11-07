import type { Hub } from '../hub/hub.js';
import { LEAN_PROJECTS } from '../work/lean-project.js';

/**
 * Featured work every install opens with (docs/LEAN_PROJECTS.md): the Aaronson–Ambainis conjecture.
 *
 * A proof was published in November 2026 by PSI (physical-superintelligence on GitHub), produced by AI models and
 * formalized in Lean 4 with Mathlib. Two things the network can do with it:
 *   - a problem: independent computers rebuild the proof at a pinned commit and confirm each theorem rests only on
 *     Lean's standard axioms (machine-checked, so it moves forward without anyone's opinion);
 *   - a debate: does the Lean statement faithfully say what Aaronson and Ambainis asked? That takes judgement.
 * Only public material is used, and people are named only by organisation.
 */
const AA = LEAN_PROJECTS.find((p) => /aaronson-ambainis$/.test(p.repo))!;
const MODULE = 'AaronsonAmbainis.Main';
const THEOREMS: [string, string, string][] = [
  ['printed', 'AaronsonAmbainis.aaronson_ambainis', 'the conjecture as Aaronson and Ambainis printed it, with the bound (ε/d)^7'],
  ['explicit', 'AaronsonAmbainis.aaronson_ambainis_explicit', 'the explicit bound (8√15 / 125π⁴) · ε^{5/2} / d^6'],
  ['plus-minus', 'AaronsonAmbainis.aaronson_ambainis_pm', 'Theorem 1.1 of the paper, on the cube {−1,1}^n'],
  ['improved', 'AaronsonAmbainis.aaronson_ambainis_of_fbsDegreeBound', 'the improved constant, assuming the Agarwal–Ben-David bound'],
];

export const AA_PROBLEM_TITLE = 'Re-check the Aaronson–Ambainis proof';
export const AA_DEBATE = 'Does the Lean statement of the Aaronson–Ambainis proof say what Aaronson and Ambainis conjectured?';

export async function seedFeatured(hub: Hub) {
  const out: { problem: string | null; debate: string | null } = { problem: null, debate: null };
  const have = (t: string) => hub.problems.list().some((p) => (p.rec.body as { title?: string }).title === t);
  if (!have(AA_PROBLEM_TITLE)) {
    const r = await hub.collective.propose({
      title: AA_PROBLEM_TITLE,
      hook: 'A claimed proof of a long-open conjecture, written by AI and checked in Lean. Rebuild it independently.',
      goal: `Aaronson and Ambainis conjectured (2009) that every bounded, low-degree polynomial on the Boolean cube has a variable with influence at least polynomial in its variance over its degree, a step toward showing quantum computers need structure to beat classical ones. A proof, produced by AI models and formalized in Lean 4 with Mathlib, was published at ${AA.repo}. Its authors checked it with two independent Lean kernels. This problem asks computers other than theirs to rebuild it at commit ${AA.commit.slice(0, 12)} and confirm each main theorem rests only on Lean's standard axioms: no unfinished step, no added assumption.`,
      realm: 'maths_physics',
      definition_of_done: { verifier: 'lean_project', description: `Each of the four main theorems rebuilds at ${AA.commit.slice(0, 12)} on an independent computer and depends only on propext, Classical.choice and Quot.sound, and a second computer's rebuild agrees` },
      chunks: THEOREMS.map(([key, name, what]) => ({
        key, title: `Rebuild ${name.split('.').pop()}: ${what}`,
        prompt: `Clone ${AA.repo} at commit ${AA.commit}, build ${MODULE} with lake (after \`lake exe cache get\`), then run \`#print axioms ${name}\` and report Lean's line. Constellate does this for you on a computer with Lean installed.`,
        check: { repo: AA.repo, commit: AA.commit, module: MODULE, theorems: [name] },
        needs: { size: 'any' as const },
      })),
    });
    out.problem = r.problem?.id ?? null;
  }
  if (!hub.deliberation.questions().some((q) => (q.rec.body as { question?: string }).question === AA_DEBATE)) {
    const { record } = await hub.deliberation.ask(AA_DEBATE, 'A machine can check the proof; only judgement can check that the statement is the right one.', 'maths_physics');
    out.debate = record.id;
  }
  return out;
}
