# Launching publicly with the x0x home test

The plan for the first public release to the Autonomi community, with the x0x home test (docs/X0X_HOME_TEST.md) as
the starter problem: every participant's session counts, the community already runs x0x, and it exercises
Constellate end to end.

## Before anyone outside is asked

- [ ] Publish `constellate-mcp` 0.2.0 to npm (Actions, Release; distribution/RELEASING.md).
- [ ] Run the two-computer check on two computers in different homes (`scripts/two-computer-check.mjs`,
      docs/NETWORK.md).
- [ ] @dirvine and the Saorsa Labs team revise docs/X0X_HOME_TEST.md, ideally with a public word of support.
- [ ] A private run on 3 to 5 friendly computers in different homes:
  - [ ] the session's numbers look right against x0xd's own diagnostics (field names were read from v0.49.1's code);
  - [ ] the echo probes are heard across homes (`cohort_seen`, `echoes_per_probe`);
  - [ ] the sent records contain no address or id (they're checked in tests; confirm on real output);
  - [ ] fix what breaks, then run it again.
- [ ] Post the home test as a problem in Technology and infrastructure, in the version the x0x team approved.

## Launch

- [ ] A short post on the Autonomi forum and Discord: what it is, what it measures, what it never sends, the
      one-click install, and the link to the results page.
- [ ] A weekly report: computers taking part, NAT types, the census numbers, and any experiment that reached 5
      computers per arm in the same hours, with its spread and its labels.

## What to learn about Constellate itself

- **Install:** where people drop off between the post and a finished session.
- **Return:** how many run a second session, or connect an agent.
- **The network:** connection problems people hit, which also feed the x0x results.
- **Lookups:** how often `failures_search` finds a fix (network or GitHub), and how many get confirmed
  (`metrics_get`).
