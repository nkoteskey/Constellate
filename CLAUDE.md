# Constellate: working rules

DESIGN.md is the source of truth for the product. PROGRESS.md logs what was built
and what needs a human. These rules apply to everyone working on this repo,
people and AI agents alike.

## Personal data: never permanent

Records are signed, gossiped and archived on Autonomi, so anything published is
effectively permanent. **People are only ever named by a public handle (@name)
or an organisation.** Never publish, seed, commit or display:

- personal names (use the @handle, or leave the person out)
- email addresses (bots like noreply@ and example.* test addresses are fine)
- phone numbers, postal addresses, IP addresses
- home-folder paths (/Users/name, /home/name, C:\Users\name)
- private or closed-source project names, and anything from closed projects

The rule is enforced in code and by tests; don't weaken them:

- `src/privacy/scrub.ts` **blocks** publishing with personal data (blocked, not trimmed).
- `src/hub/node.ts` `ingest` **refuses** records from other nodes that carry it:
  not stored, served, archived or passed on.
- `src/privacy/redact.ts` **cleans** imported public history (issues, pull
  requests, CI logs) before it is signed.
- `test/gates/privacy_rule.test.ts` fails if any tracked file in this repository
  contains a personal name, an email or a home path.

Only public repositories feed the network (`src/seed/`), and only from what is
already public. Closed projects read locally and never write.

## Also

- Develop on a branch; never push secrets. Keys live in the encrypted vault (`constellate keys`).
- Real money and paid storage are off unless the owner turns them on (docs/MAINNET.md).
- Our npm package is `constellate-mcp`. The bare name `constellate` belongs to an unrelated project.
