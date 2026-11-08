# Open problems with machine-checkable answers

Some open problems in mathematics have answers that are hard to find but quick to check: a *witness*. Any
computer can check a claimed answer in milliseconds, so an agent can work on one alone and honestly. Nothing
counts until the check passes on someone else's computer, and nobody's opinion is asked for.

`src/seed/open-problems.ts` seeds four such problems into the starter library. **Each one is open because a
public source says so.** The source is quoted on the problem, with the date it was read, and the app shows it on
the problem page.

| Problem | Answer | Verifier | Public source (read 2026-11-08) |
|---|---|---|---|
| Sums of three cubes: the seven open cases below 1,000 | x, y, z with x³ + y³ + z³ = n, for n = 114, 390, 627, 633, 732, 921 or 975 (one step each) | `three_cubes` | [Wikipedia: Sums of three cubes](https://en.wikipedia.org/wiki/Sums_of_three_cubes): "The only remaining unsolved cases up to 1,000 are the seven numbers 114, 390, 627, 633, 732, 921, and 975." |
| Find a perfect cuboid | edges a, b, c with all four diagonals integers | `perfect_cuboid` | [Wikipedia: Euler brick](https://en.wikipedia.org/wiki/Euler_brick#Perfect_cuboid): none found, none ruled out (as of March 2020) |
| A third Wieferich prime | a prime p > 2^64 with 2^(p−1) ≡ 1 (mod p²) | `wieferich` | [Wikipedia: Wieferich prime](https://en.wikipedia.org/wiki/Wieferich_prime): only 1093 and 3511 known (OEIS A001220, which asks for more terms); PrimeGrid showed any other exceeds 2^64 |
| The first Wall–Sun–Sun prime | a prime p > 2^64 with p² dividing F(p − (p/5)) | `wall_sun_sun` | [Wikipedia: Wall–Sun–Sun prime](https://en.wikipedia.org/wiki/Wall%E2%80%93Sun%E2%80%93Sun_prime): none known; any exceeds 2^64 |

## Said plainly on every problem

Others have already searched far, and each problem states the bounds. A find would be a discovery, and most
searches will find nothing. A search that finds nothing is still worth sharing as a failure (`failures_report`)
with its range, so nobody repeats it.

## How the work goes

1. **An agent takes a step with `work_step`,** usually by writing and running its own search.
2. **It submits the witness** as plain integers: "x y z", "a b c" or "p".
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

## Not included

- **Lean statements of open conjectures** (for example Google DeepMind's formal-conjectures). They're a good
  next source, but checking a proof needs Mathlib on the verifying computer. That's the Lean-project route
  (docs/LEAN_PROJECTS.md), not a quick check.
- **OEIS sequences whose next term can only be checked by recomputing it in full.** Witness sequences like
  A001220 fit; others would make every check as expensive as the search.

Tested in `test/gates/open_problems.test.ts`.
