# Example problems

For each realm, three example problems were chosen (sources read 2026-11-25): one that helps every field, the
field's most ambitious, and one within reach. Plus one front-page problem: famous and instantly checkable, with
real records on the way to the summit. Only problems whose checker is **built in** (docs/CHECKERS.md) are seeded
(`src/seed/example-problems.ts`); the rest wait for their checker.

## Seeded

| Realm | Problem | Checker |
|---|---|---|
| Front page, maths and physics | Multiply 4×4 matrices with 47 multiplications (plus records for 3×3×4 … 5×5×5, and 3×3 below 23) | `matmul_scheme` |
| Technology and infrastructure (helps every field) | Better error-correcting codes: nine table entries with a gap | `linear_code` |
| Technology and infrastructure (most ambitious) | The fewest comparators that sort 13 to 17 inputs | `sorting_network` |
| Technology and infrastructure (within reach) | Smaller sorting networks for 18 to 22 inputs | `sorting_network` |
| Philosophy and ethics (helps every field) | Which values should AI follow when values conflict? | `argmap` |
| Philosophy and ethics (most ambitious) | Could AI systems be moral patients? | `argmap` |
| Philosophy and ethics (within reach) | One box or two? The predictor puzzle | `argmap` |

Matrix multiplication was the research's pick for both maths and technology; it stays in maths (and on the front
page), and technology has codes and sorting networks instead.

## Waiting for a checker

| Realm | Problem | Source | Needs |
|---|---|---|---|
| Maths and physics (most ambitious) | Riemann Hypothesis machinery: Lean steps toward the prime number theorem with error term (not a proof of RH) | the open Lean project formalising the prime number theorem with error term (PrimeNumberTheoremAnd on GitHub, Apache-2.0) | pack: a Lean proof checked against a pinned project with Mathlib |
| Maths and physics (within reach) | Lean proofs of Erdős problems already solved on paper (over 1,000 statements without one) | https://github.com/google-deepmind/formal-conjectures | the same pack |
| Life sciences (helps every field) | Protein–ligand poses on unfamiliar pockets (Runs N' Poses) | https://www.biorxiv.org/content/10.1101/2025.02.03.636309v3 | pack: pose RMSD and validity checks |
| Life sciences (most ambitious) | Virtual cell: predict gene-knockdown effects in unseen cell types | https://arcinstitute.org/news/virtual-cell-challenge-2026 | pack: pinned cell-eval; data licence to confirm |
| Life sciences (within reach) | Beat 0.256 MAE on TDC Caco2_Wang | https://tdcommons.ai/benchmark/admet_group/01caco2/ | pack: sandboxed rerun; dataset licence to confirm |
| Planet and energy (helps every field) | Universal atomic force fields (Matbench Discovery, F1 0.941) | https://matbench-discovery.materialsproject.org/ | pack: deterministic inference rerun |
| Planet and energy (most ambitious) | Certify optimality of large AC power-flow cases (PGLib-OPF) | https://github.com/power-grid-lib/pglib-opf/blob/master/BASELINE.md | pack: feasibility plus a lower-bound certificate checker |
| Planet and energy (within reach) | Certified optimal dispatch for every small PGLib-OPF case | same | the same |
| Art and creativity (helps every field) | Can every convex polyhedron be unfolded into a net? | https://arxiv.org/abs/2607.09606 | built in, next: `polyhedron_net` |
| Art and creativity (most ambitious) | A tile with Heesch number 7 or more | https://epoch.ai/frontiermath/open-problems/heesch-number | built in, next: `heesch_certificate` |
| Art and creativity (within reach) | Heesch numbers of every 20-omino | https://arxiv.org/abs/2105.09438 | the same, plus the count of 20-ominoes read from its source |

Runners-up for the front page: BB(6) holdouts (bbchallenge.org; licence to confirm) and Erdős prize problems in
Lean (needs the Lean pack). Both need a checker that isn't built in.
