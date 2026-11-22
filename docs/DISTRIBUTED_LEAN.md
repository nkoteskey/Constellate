# Checking a huge Lean proof across many computers

Some proofs are too big for one ordinary computer to rebuild in a reasonable time: the Riemann hypothesis claim of
November 2026 is reported at about 17 million lines of Lean. Mathlib, about 2 million lines, takes hours on a fast
machine. Constellate's aim is that many ordinary computers check such a proof together, and that the result can be
trusted because independent computers agree, not because of who owns the hardware.

Status: the plan below is designed; the part that needs no Lean is built and tested (`src/work/lean-distributed.ts`,
`test/gates/lean_distributed.test.ts`). The build step on real computers is next (see "What's left").

## Why it splits

Lean builds a project one module at a time. A module needs only the compiled files (`.olean`) of what it imports,
and Lean's kernel re-checks every proof in the module being built. So the import graph cuts into **slices**: groups
of modules that can be built as soon as the slices they import from are done. Slices at the same depth build side by
side on different computers.

1. **Plan.** Read every `.lean` file's imports at the pinned commit (`readProject`), give each module a level (one
   more than its deepest import inside the project), and cut each level into slices of a bounded size
   (`planSlices`, about 20,000 lines by default). Each slice waits for the slices holding what it imports.
2. **Steps.** Each slice becomes a step of a problem (`sliceSteps`), using the existing step order (`after`), so a
   slice opens only when its imports are agreed. The last step asks Lean which axioms the target theorems rest on
   (`#print axioms`), as the single-computer check does today (docs/LEAN_PROJECTS.md).
3. **Build.** A computer takes an open slice, fetches the agreed `.olean` files of the slices it imports (checking
   each against its agreed fingerprint), builds its modules with the pinned toolchain, and reports the sha256 of each
   output file.
4. **Agree.** A slice counts once at least a **quorum** of independent operators (2 by default; 3 for headline
   results) on the same toolchain report identical fingerprints (`agreement`). Their files become the agreed ones
   that downstream slices build on.
5. **Disputes are not votes.** Different fingerprints from the same toolchain mean a nondeterministic build, a faulty
   computer or a dishonest one. The slice shows as disputed and someone has to find out why, as with "Checkers
   disagree" on results (docs/RESULTS.md).

## Why it can be trusted

- **Every proof is checked by Lean's kernel on at least two independent computers.** Building a module type-checks
  its proofs. A downstream builder trusts its imports' `.olean` files, but only files that two independent builders
  produced identically.
- **One computer can't slip in a bad file.** It would need a second, independent operator to produce the same
  wrong file.
- **A stronger, optional pass:** `lean4checker` replays declarations from `.olean` files through the kernel again,
  module by module. It splits the same way, so the network can run it as a second, separately written check.
- **Mathlib and the toolchain:** by default builders use Mathlib's published build cache, so the label says what was
  trusted ("built on Mathlib's published cache"). The network can rebuild Mathlib itself once, the same way, and
  then build on its own agreed files instead.

## How fast

The least wall-clock time is the **critical path**: the longest chain of slices that wait for each other
(`criticalPath`), however many computers join. Proof projects are usually wide rather than deep, so most slices
build at the same time. In the gate test, a random 3,000-module project gives a chain far shorter than the number of
slices. Each slice is built by at least two computers, so the total work is at least twice a single build. The
point is wall-clock time and independence, not saving compute.

## What's left

- **Moving `.olean` files between computers.** They are large: Mathlib's are several GB. Planned: content-addressed
  bundles shared peer to peer, with the agreed fingerprints as their addresses (docs/STORAGE.md); Autonomi for ones
  worth keeping.
- **The builder:** a `lean_slice` check that runs `lake build` on just a slice's modules, with imported `.olean` files
  placed where Lake expects them, then reports fingerprints. Lean builds aren't guaranteed byte-for-byte
  reproducible across machines, so the first real test is whether two computers produce identical `.olean` files for
  the same slice. If they don't, the fallback is to agree on a fingerprint of the exported declarations instead of
  the raw file.
- **Pooled machines:** a slice too big for one ordinary computer can go to pooled machines on a fast local link
  (docs/DESKTOP.md, lending).
- **The reviewed list still applies:** building runs a project's code, so only projects reviewed onto the list in
  `src/work/lean-project.ts`, at pinned commits, are built.
