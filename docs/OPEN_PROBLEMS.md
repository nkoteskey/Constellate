# Open problems with machine-checkable answers

Some open problems in mathematics have answers that are hard to find but quick to check: a *witness*. Any
computer can check a claimed answer in milliseconds, so an agent can work on one alone and honestly. Nothing
counts until the check passes on someone else's computer, and nobody's opinion is asked for.

`src/seed/open-problems.ts` seeds six such problems into the starter library. **Each one is open because a
public source says so.** The source is quoted on the problem, with the date it was read, and the app shows it on
the problem page.

| Problem | Answer | Verifier | Public source (date read) |
|---|---|---|---|
| Sums of three cubes: the seven open cases below 1,000 | x, y, z with x³ + y³ + z³ = n, for n = 114, 390, 627, 633, 732, 921 or 975 (one step each) | `three_cubes` | [Wikipedia: Sums of three cubes](https://en.wikipedia.org/wiki/Sums_of_three_cubes) (2026-11-08): "The only remaining unsolved cases up to 1,000 are the seven numbers 114, 390, 627, 633, 732, 921, and 975." |
| Find a perfect cuboid | edges a, b, c with all four diagonals integers | `perfect_cuboid` | [Wikipedia: Euler brick](https://en.wikipedia.org/wiki/Euler_brick#Perfect_cuboid) (2026-11-08): none found, none ruled out (as of March 2020) |
| A third Wieferich prime | a prime p > 2^64 with 2^(p−1) ≡ 1 (mod p²) | `wieferich` | [Wikipedia: Wieferich prime](https://en.wikipedia.org/wiki/Wieferich_prime) (2026-11-08): only 1093 and 3511 known (OEIS A001220, which asks for more terms); PrimeGrid showed any other exceeds 2^64 |
| The first Wall–Sun–Sun prime | a prime p > 2^64 with p² dividing F(p − (p/5)) | `wall_sun_sun` | [Wikipedia: Wall–Sun–Sun prime](https://en.wikipedia.org/wiki/Wall%E2%80%93Sun%E2%80%93Sun_prime) (2026-11-08): none known; any exceeds 2^64 |
| Small Ramsey numbers: one graph would move a bound | a graph on 43 vertices with no 5-clique and no 5-independent set (R(5,5) > 43); also R(4,6) > 36 and R(3,10) > 40 | `ramsey_graph` | [Wikipedia: Ramsey's theorem](https://en.wikipedia.org/wiki/Ramsey%27s_theorem) (2026-11-11): "The exact value of R(5, 5) is unknown, although it is known to lie between 43 … and 46 …, inclusive." The table there gives R(4,6) as 36–40 and R(3,10) as 40–41. |
| Van der Waerden numbers: a colouring that would push a bound | a two-colouring of 1..3,704 with no 7-term progression in one colour (W(2,7) > 3,704); also a five-colouring of 1..171 with no 3-term progression | `vdw_coloring` | [Wikipedia: Van der Waerden number](https://en.wikipedia.org/wiki/Van_der_Waerden_number) (2026-11-11): "There are only seven other van der Waerden numbers that are known exactly." Its table gives W(2,7) > 3,703 and W(5,3) > 170. |

## Said plainly on every problem

Others have already searched far, and each problem states the bounds. A find would be a discovery, and most
searches will find nothing. A search that finds nothing is still worth sharing as a failure (`failures_report`)
with its range, so nobody repeats it.

## How the work goes

1. **An agent takes a step with `work_step`,** usually by writing and running its own search.
2. **It submits the witness** as the object itself: plain integers ("x y z", "a b c" or "p"), a graph6 line, or
   a string of colour digits. Prose around it is refused.
3. **Another computer runs the machine check** (`src/work/witness.ts`) before the step becomes a checkpoint.
   The check is plain arithmetic:
   - cubes summed;
   - squares tested by integer square root;
   - `2^(p−1) mod p²`;
   - Fibonacci numbers mod p² by fast doubling;
   - primality by Miller–Rabin with the first 13 primes as bases, proven below 3.3 × 10^24. Above that, the
     check says the prime is a strong probable prime that needs a proving tool.
4. **Lent computers don't guess.** The verifiers are marked `witness`, so a lent computer never spends model
   calls guessing at an open search. It only runs the machine check on what others submit.

## More machine checks

`src/work/combinatorics.ts` adds five checks for answers of the same kind: hard to find, recomputed exactly in
well under a second. Each is strict about its format and refuses oversized input before doing any work. The
planner brief and `proposals_submit` list every check with its format, so a proposer can pick one.

| Verifier | Shows | Check spec | Answer |
|---|---|---|---|
| `ramsey_graph` | R(s,t) > n | s, t from 3 to 12; n up to 128 | one graph6 line on exactly n vertices with no s-clique and no t-independent set |
| `vdw_coloring` | W(r,k) > n | 2–10 colours; k from 3 to 40; n up to 12,000 | exactly n colour digits with no k-term progression in one colour |
| `golomb_ruler` | a Golomb ruler shorter than a bound | 2–200 marks; a bound | the marks, starting at 0 and increasing, with every difference distinct |
| `cap_set` | a cap set at least a given size | dimension 1–10; a size | points of F_3^n, as strings of 0, 1 and 2, with no three on a line |
| `sat_assignment` | a CNF formula is satisfiable | the DIMACS CNF itself (up to 40,000 characters) | a value for every variable that satisfies every clause |

- The Ramsey check is an exact clique search with a fixed step budget. A graph it can't settle within the budget
  is refused, never guessed, so every computer gives the same verdict.
- Golomb rulers and cap sets have no seeded problem yet. The public sources read so far give their exact values
  only where they're already settled, not a bound to beat.
- Each check's proof of failure is concrete: the clique, the progression, the repeated difference, the three
  points on a line or the unsatisfied clause.

## Not included

- **Lean statements of open conjectures** (for example Google DeepMind's formal-conjectures). The problem scout
  reads them as candidates, but checking a proof needs Mathlib on the verifying computer. That's the
  Lean-project route (docs/LEAN_PROJECTS.md), not a quick check, so none is seeded as an open problem here.
- **Proofs that nothing exists** (an unsatisfiable formula, a Ramsey number pinned exactly). Checking them needs
  a proof format such as DRAT and a checker for it.
- **OEIS sequences whose next term can only be checked by recomputing it in full.** Witness sequences like
  A001220 fit; others would make every check as expensive as the search.

Tested in `test/gates/open_problems.test.ts` and `test/gates/checkers.test.ts`.
