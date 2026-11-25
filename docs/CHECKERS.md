# Checkers: built in, or a pack

A checker is the only judge of a problem. A wrong or lenient one turns into false results that are signed and
kept for good. So checkers are added slowly, and only two kinds exist.

## Built in

Inside the app, pinned by version (`src/work/checker-pins.json`). A checker is built in only if it is all of:

- **Pure**: arithmetic on the answer and the step's check, nothing else. No network, no files, no outside
  programs, no model.
- **Deterministic**: the same answer always gets the same verdict, on every computer.
- **Exact**: integers or exact fractions. No floating point in a verdict.
- **Small and bounded**: a few hundred lines, with a stated cap on the work it will do (it refuses larger
  answers instead of running for hours).
- **Controlled**: control answers that must pass, and planted errors that must fail
  (`src/work/checker-controls.ts`), run in the gate test.
- **Checked twice where it can be**: a second checker written separately, by a different method
  (`src/work/second-checkers.ts`). Without one, its results are labelled "One engine".
- **Honest about limits**: what a pass does not establish (`NOT_ESTABLISHED` in `src/work/results.ts`).

All the built-in checkers together are tens of kilobytes; they don't weigh on the app.

## Packs

Anything heavier: a proof assistant with its libraries, a machine-learning rerun, a large solver, gigabytes of
data. The app holds only a thin adapter; the tool lives outside it, the way Lean does today
(`src/work/lean-project.ts`):

- The adapter says whether this computer has the pack (`available()`). Computers without it skip those steps
  and leave them for computers that have it.
- A pack is pinned: a reviewed repository at a commit, or a container image by its hash, recorded with the
  checker's version.
- It runs sandboxed, with no network during the check.
- Only people who opt in to that kind of problem download it.

A problem whose checker is a pack waits, shown as "waiting for a checker", until the pack exists and has been
reviewed.

## Adding one

1. Write it to the rule above, with its controls, and a second checker where one is possible.
2. Add it to `CHECKER_VERSIONS` and pin it: `UPDATE_CHECKER_PINS=1 npx vitest run test/gates/checkers.test.ts`.
3. Changing a checker's verdict-affecting code later means raising its version; every control must still give
   the same verdict.

## Status

| Checker | Kind | For |
|---|---|---|
| `matmul_scheme` | built in | fewer multiplications for matrix products |
| `linear_code` | built in | best-known error-correcting codes |
| `sorting_network` | built in | fewest comparators that sort n inputs (n ≤ 22) |
| `argmap` | built in (structure only; merit is judged by people) | argument maps for open questions |
| `polyhedron_net`, `heesch_certificate` | built in, next | unfolding polyhedra; Heesch numbers |
| Lean proof against a pinned library (Mathlib, formal-conjectures) | pack | Erdős problems; prime number theorem steps |
| ML reruns (ligand poses, cell response, ADMET, force fields) | pack | life sciences; materials |
| Power-grid optimality bounds | pack | grid dispatch certificates |
