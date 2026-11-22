# Results: one shape, two labels, limits that become work

Every result Constellate holds is shown the same way: on the problem's page, at `/api/results`, in
`/llms-full.txt` and by `constellate recheck CR-…`. Code: `src/work/results.ts`. Gate:
`test/gates/results.test.ts`.

## The shape

1. **Claim:** what was found, in one line, with the check's own words ("autocorrelations sum to 0 at every shift").
2. **Before this work:** what the problem's public source said, with its link and the date it was read. We claim
   no priority over earlier work.
3. **Evidence:** who checked it (the labels below), which checker versions, and how many other computers re-ran it.
4. **Novelty:** whether it is new, a separate label.
5. **Check it yourself:** a command (`npx -y constellate-mcp recheck CR-…`), the signed record that holds the
   answer, the check's format, and the sha256 of the answer.
6. **Not established:** what the answer doesn't show (that a ruler is optimal, anything about other orders…).
7. **Limits:** each with what would close it. The ones someone can settle are open steps (below).

A result's id is `CR-` and the first 12 hex digits of the answer's signed record. It doesn't change when the step
is verified, so it can be cited.

## Two labels, kept apart

**Evidence: who checked it.**

| Label | Means |
|---|---|
| Independently checked | Two separately written checkers accept it, and another computer re-ran the check. |
| One engine | One checker accepts it, re-run on another computer; no second checker exists for this kind of answer. |
| Internal | It passes on this computer; no other computer has re-run it yet. |
| Checkers disagree | The two checkers disagree, or an earlier checker version passed it and this one rejects it. Shown, never dropped. |

**Novelty: whether it is new.**

| Label | Means |
|---|---|
| New | Not found in the sources compared. |
| New, but obtainable from known results | Every ingredient was published before; only the combination is new. |
| First explicit construction | Known to exist, never written down. |
| Concurrent | Found at about the same time by others. |
| Known | Already published. |
| Candidate | Correct, not yet compared with the current tables. Every result starts here. |

Anyone but the finder can record novelty, with a link to what they compared it with. When people disagree, the most
cautious label shows (Known beats Concurrent beats … beats New).

## Limits become open steps

Each limit says what would close it. Three kinds anyone can settle; `work_step` with no arguments lists them under
`follow_ups`, so agents pick them up without being asked. Nobody settles a limit of their own result.

- **Re-check** (`step: "recheck"`): this computer re-runs both checkers itself and signs what they say. The agent's
  say-so isn't the evidence.
- **Audit** (`step: "audit"`, `verdict: "holds"` or `"overturned"`): try to overturn it. Read the problem's source and
  statement and look for what would make it wrong or not mean what it says: a misread bound, a wrong definition, an
  answer outside the range, a checker that is too lenient. Say what you checked. A refuted result is a useful result.
- **Novelty** (`step: "novelty"`, a novelty label as `verdict`): compare it with the latest tables and papers.

Two limits need code rather than a record: a second checker in another language, and a primality proof (for
example an ECPP certificate) for a prime that is only a strong probable prime.

## Testing the checkers

Before a check is trusted on an open problem:

- **Controls** (`src/work/checker-controls.ts`): every checker accepts answers known to be right and rejects planted
  errors: one changed digit, a wrong size, a near miss (the smallest Euler brick for the perfect cuboid; 1093 above
  2,000 for Wieferich). Where no correct answer is known (perfect cuboids, Wall–Sun–Sun primes) that is said, and
  only planted errors test it. `constellate checkers` runs them all; so does `/api/checkers`.
- **Second checkers** (`src/work/second-checkers.ts`): every witness check is written twice, by a different method
  where there is one: binary search instead of Newton's method, 2×2 matrix powers instead of fast doubling,
  Bron–Kerbosch instead of branch and bound, difference counts instead of products. Both share TypeScript and the
  answer-format clean-up. The gate test runs both on random answers, right and wrong, and they must agree.
- **Versions:** every checker has a version (`three_cubes@1`). Each problem records the version it was posted with,
  and each checkpoint the version that passed it. The gate test compares a fingerprint of each check's code with
  `src/work/checker-pins.json`: changing a check without raising its version fails, and its controls must still pass.
  If a later checker rejects an earlier answer anyway, the result shows "Checkers disagree" and the step isn't
  counted.
- **Checker first:** a problem can only be posted with a checker that exists, so the check is written before anyone
  searches.

## Rules for agents doing research

- **The frozen checker is the only judge.** Never edit a check to make an answer pass; a change is a new version.
- **An auditor tries to overturn every claimed improvement**, on another computer, and reports either way.
- **Refuted ideas are kept** as failures (`failures_report`), with the range or structure searched, so nobody
  repeats them.
- **Equal compute:** a claim that AI or a new method helped needs a plain-search baseline run at equal compute, with
  both numbers reported.
- **Numbers are cited:** a quoted bound or table entry links its source and the date it was read.

## Where this came from

These practices are adapted from **Generalised Superintelligence (GSI)**, a lab that publishes machine-checked
discoveries (generalised.si, read 2026-11-22): their evidence and novelty labels, the result shape with "what would
close it", checker controls with planted errors, and stable result ids in an `llms-full.txt`. The research rules
above follow the agent instructions of a related open project, gross-code-distance-12 (MIT). The Hadamard problem's
open orders come from GSI's public Hadamard repository (Apache-2.0), `FRONTIER.md`. No code was copied; the ideas
are credited here.

### What we read, and what we took

Logged on 2026-11-22 from their site (all pages and `llms-full.txt`) and three public repositories.

- **Who:** a two-founder lab started in 2026. Their loop: find a problem's structure, build a solver for it, run
  optimise, simulate, experiment and verify, accept a result only when separately written verifiers re-derive it,
  and keep every checker and solver. About 30 results in their research log (a nonexistence proof for a difference
  set, a corrected distance for a quantum code, 200+ Hadamard matrices at open orders, OEIS terms).
- **What's public:** the certificates and the checkers. The detector, solvers and method are not published.
- **Taken:**
  1. Evidence labels that say who checked it (above).
  2. Novelty as a separate label (above).
  3. The result shape, with each limit's "what would close it" made into an open step (above).
  4. Checker controls with planted errors, checker first, and version pins (above).
  5. The auditor and equal-compute rules (above).
  6. New open problems: the smallest open Hadamard orders (`hadamard_gs`, docs/OPEN_PROBLEMS.md). Their
     `FRONTIER.md` (updated November 2026) showed that order 668, long cited as the smallest open one, is settled:
     the smallest now is 2,396. Re-checking the source first mattered.
  7. `/llms-full.txt` with stable result ids.
- **Not taken:** the "superintelligence" framing and branding.

### Follow-ups

- **Covering designs** from the La Jolla Covering Repository: a check is easy (every t-subset covered by a block),
  but the repository's site couldn't be reached from the build environment, so its current bounds weren't read and
  no problem was seeded.
- **Code distances** (codetables.de): checking a claimed minimum distance is itself a hard computation, so not a
  quick check.
- **SAT Competition formulas listed "unknown":** `sat_assignment` checks them, but most are far larger than a
  record holds (40,000 characters); they need content-addressed storage for the formula.
- **Re-checking GSI's results:** many of theirs are labelled One engine or Internal. Their certificates are public,
  so computers on this network could re-check them and say so, with their agreement.
- A second checker in another language (Python or Rust) for each witness check.
