import { ProblemBody } from './problems.js';
import { z } from 'zod';

/**
 * Launch problem: a Lean 4 formalisation project. It is fully verifiable
 * (Lean either accepts the proof or it doesn't) and shows the whole system
 * working end to end. Each chunk is one theorem; done = `lean` accepts a file
 * that states exactly this theorem, with no sorry/admit. The starter set is core
 * Lean 4 (no Mathlib) so any contributor with `elan` can check it; the real
 * launch swaps in a Mathlib backlog chosen by vote.
 */
const THEOREMS: { key: string; title: string; statement: string }[] = [
  { key: 'add_zero', title: 'n + 0 = n', statement: 'theorem cst_add_zero (n : Nat) : n + 0 = n' },
  { key: 'zero_add', title: '0 + n = n', statement: 'theorem cst_zero_add (n : Nat) : 0 + n = n' },
  { key: 'add_comm', title: 'Addition commutes', statement: 'theorem cst_add_comm (a b : Nat) : a + b = b + a' },
  { key: 'add_assoc', title: 'Addition associates', statement: 'theorem cst_add_assoc (a b c : Nat) : a + b + c = a + (b + c)' },
  { key: 'mul_comm', title: 'Multiplication commutes', statement: 'theorem cst_mul_comm (a b : Nat) : a * b = b * a' },
  { key: 'two_mul', title: '2 * n = n + n', statement: 'theorem cst_two_mul (n : Nat) : 2 * n = n + n' },
  { key: 'sum_range', title: 'Gauss: 2 * Σ i<n+1 = n(n+1)', statement: 'theorem cst_gauss (n : Nat) : 2 * (List.range (n + 1)).sum = n * (n + 1)' },
  { key: 'rev_rev', title: 'Reversing twice is identity', statement: 'theorem cst_rev_rev (l : List Nat) : l.reverse.reverse = l' },
];

export function leanLaunchProblem(): z.input<typeof ProblemBody> & { license: string } {
  return {
    title: 'Formalise the basics in Lean 4',
    hook: 'Watch AIs and people prove theorems a computer can check',
    goal: 'Machine-checked Lean 4 proofs of a starter backlog of theorems, published under an open licence. The pilot for formalising major results.',
    realm: 'maths_physics',
    license: 'CC-BY-4.0',
    definition_of_done: { verifier: 'lean', description: 'Lean 4 accepts each file, which states exactly the theorem, with no sorry or admit' },
    chunks: THEOREMS.map((t) => ({
      key: t.key,
      title: t.title,
      prompt: `Write a complete Lean 4 file (core Lean only, no Mathlib, no sorry) that proves:\n\n${t.statement} := by\n  ...\n\nReturn only the Lean file.`,
      check: { statement: t.statement, cost_hours: 0.5 },
      needs: { size: t.key === 'sum_range' ? 'large' : 'any' },
    })),
  };
}
