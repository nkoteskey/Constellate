# Re-checking published Lean proofs

Some results arrive with a machine-checkable proof: a Lean 4 project that the
authors say builds, with every theorem resting only on Lean's standard axioms.
A proof like that is only as good as the build that checked it. Constellate
lets lent computers rebuild it independently, so the network, not just the
authors, can say it holds.

## How a re-check works (`src/work/lean-project.ts`)

Each step of a re-check problem names a project, a pinned commit, a module and
the theorems to check. A computer with Lean installed:

1. clones the project and checks out exactly that commit;
2. fetches Mathlib's prebuilt files (`lake exe cache get`) and builds the module;
3. asks Lean `#print axioms` for each theorem, and reports Lean's lines.

A different computer then repeats the whole build itself (the `lean_project`
check). The step passes only when:
- each theorem rests on nothing beyond `propext`, `Classical.choice` and
  `Quot.sound` (so no `sorry` and no added axiom);
- both computers' reports agree.

The decision is the machine check alone. No model's opinion is asked for, and
the work uses no AI account or spend.

## Safety

Building a Lean project runs its code. So only projects on the reviewed list in
`src/work/lean-project.ts`, at exactly the listed commit, are ever built. Any
other project, and any other commit of a listed project, is refused before
anything runs. Theorem names are checked to be plain Lean names before they're
put in the probe file.

## Who takes these steps

Only computers with Lean installed (elan, which provides `lake`), with room for
Mathlib (several GB). Other computers leave these steps for those that can.
`CONSTELLATE_LAKE` points at a specific `lake`; `CONSTELLATE_LAKE=off` opts out.

## Featured: the Aaronson–Ambainis conjecture (`src/seed/featured.ts`)

- **What was claimed:** in 2009 Aaronson and Ambainis conjectured that every
  bounded, low-degree polynomial on the Boolean cube has an influential
  variable. In November 2026, PSI ([physical-superintelligence/aaronson-ambainis](https://github.com/physical-superintelligence/aaronson-ambainis))
  published a proof produced by AI models, with a Lean 4 formalization (Lean
  4.33, Mathlib v4.33.0). The authors re-checked it with two independent Lean
  kernels.
- **The problem**, *Re-check the Aaronson–Ambainis proof*, has four steps, one
  per main theorem:
  - `aaronson_ambainis`: the conjecture as printed;
  - `aaronson_ambainis_explicit`: the explicit bound;
  - `aaronson_ambainis_pm`: the paper's Theorem 1.1;
  - `aaronson_ambainis_of_fbsDegreeBound`: the improved constant, assuming
    another paper's bound.

  Each is checked at commit `2a6ceaef8727`.
- **The debate:** *Does the Lean statement say what Aaronson and Ambainis
  conjectured?* A build can show the proof proves its statement. Only judgement
  can show the statement is the right one. The authors put the conjecture,
  written with Mathlib only, in `AaronsonAmbainis/Conjecture.lean` for exactly
  this reading.

Both are in the starter library and the demo, so every install opens with them.
The authors are named only by their organisation.

## Adding another project

1. Review the project at a specific commit: what its build runs, and its
   lakefile. A declarative `lakefile.toml` is easiest to review.
2. Add `{ repo, commit, why }` to `LEAN_PROJECTS`.
3. Propose a problem whose steps use the `lean_project` check with that repo
   and commit.
