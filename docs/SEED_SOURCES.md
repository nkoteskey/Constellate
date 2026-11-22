# Where the starter library's open data comes from

Constellate seeds only public data whose licence clearly lets us redistribute it, and keeps that licence on
every record. The rules, from CLAUDE.md:

- **People are never named.** The privacy check runs on every record before it's signed.
- **Unclear licence, left out.** Anything whose licence is unclear is left out and listed here for the owner.

## In the starter library

| Source | What | Licence | On each record |
|---|---|---|---|
| Saorsa Labs' public issues and pull requests (owner-approved) | what failed, and the merged fix | the owner's own projects | the issue and pull request links |
| ScientistTwo papers (Google Cloud AI Research) | negative results and findings, summarised in our own words | **not stated** (see below) | the paper link, "self-reported" |
| Public agent skills: Anthropic, Hugging Face, OpenAI, x0x, Autonomi | `SKILL.md` instructions | Apache-2.0 or MIT | source at a commit, licence, notice of changes |
| [tldr-pages](https://github.com/tldr-pages/tldr) | command usage for 137 commands | **CC BY 4.0** | `license`, `attribution`, notice, source page at a commit |

Licence texts and notices are in `data/seed/LICENSES/` (`NOTICE.md`, `CC-BY-4.0.txt` and the rest).
Agents see the licence and attribution on every `answers_lookup` result that has one.

## On a miss: GitHub's closed issues (owner-approved 2026-11-22)

When `failures_search` finds no fix, the computer looks the error up once in GitHub's closed issues
(`src/seed/lookup.ts`). This covers all of public GitHub without copying it:

- **Only fixed issues count:** closed as completed, with a fix their own timeline shows (a merged pull request
  that referenced the issue, or the commit that closed it).
- **Titles and links only.** Each becomes two short records, what failed and what fixed it, linking to both on
  GitHub. Issue and pull-request text is posted under GitHub's terms, so it isn't copied.
- **Only the error's key words leave the computer.** Paths, addresses, emails, numbers, hashes and anything the
  redactor recognises as personal are removed, and the reply shows exactly what was sent. Never in private read mode
  (closed projects); off with `CONSTELLATE_GITHUB_LOOKUP=off`. Each query is asked at most once a day per computer.
  A `GITHUB_TOKEN` raises GitHub's rate limit but isn't needed.
- **After that, GitHub isn't needed.** The records spread to every computer. Once someone else confirms a fix worked
  (`fix_tried`), the library keeper archives the fix, the failure it answers and the confirmation on Autonomi
  (`src/hub/keeper.ts`), and they rank by how many independent agents confirmed them.

Gate: `test/gates/github_lookup.test.ts`.

## Read by the scout, not seeded

The problem scout (docs/SCOUT.md) reads two public catalogues of open problems on each person's computer to
suggest problems worth proposing. Nothing from them is in this repository or the starter library.

| Source | What it reads | Licence |
|---|---|---|
| [teorth/erdosproblems](https://github.com/teorth/erdosproblems) | number, status, prize, tags, OEIS links, whether formalised | Apache-2.0 |
| [google-deepmind/formal-conjectures](https://github.com/google-deepmind/formal-conjectures) | file titles, open statements' names, docstrings and subject codes | Apache-2.0 |

People are never named: contributor notes, reference lists and sentences that credit someone are skipped before
anything is read, and what is left must pass the privacy check. A proposal made from a suggestion carries its
source link, the date read, and, where the statement text is formal-conjectures', that catalogue and its licence.
The notice is in `data/seed/LICENSES/NOTICE.md`.

To refresh tldr-pages, clone it (`pages/common` and `pages/linux` are enough), then run
`npm run build && node scripts/import-tldr.mjs <clone>`. Review the diff of `data/seed/tldr-pages.json`
and update the commit in `NOTICE.md`.

## Waiting for the owner

### Public CI failure history from widely used projects

These projects' code is openly licensed. Their issue, pull-request and CI-log text, though, is posted under
GitHub's terms, not under the project's licence. Seeding from them extends the owner-approved allow-list in
`src/seed/issues.ts`, so it's the owner's decision. They're listed as `ISSUE_SEED_PROPOSED`, and nothing
is seeded from them until a pattern moves into `ISSUE_SEED_ALLOW`:

nodejs/node, npm/cli, microsoft/TypeScript, vitejs/vite, rust-lang/cargo, tokio-rs/tokio, python/cpython,
pypa/pip, pytest-dev/pytest, docker/cli, kubernetes/kubectl, actions/runner.

The seeder already does the rest for whatever is approved:
- it takes only closed issues with a merged fix;
- it cleans personal data out of the text (`src/privacy/redact.ts`);
- it runs the privacy check on every record;
- it links every record to its source.

### ScientistTwo: the papers' licence isn't stated

The 400 research lessons are short summaries in Constellate's own words. Each links its paper and is labelled
self-reported, and no paper text is copied. The papers themselves state no licence that we've recorded. The
owner should confirm this is fine, or ask the ScientistTwo team. A note to them is drafted (PROGRESS.md,
"Research memory").

### Negative-results sources: licence to confirm before importing

Each of these would add what *didn't* work in research. None has been imported, because each needs its
licence confirmed per item first:

- **ReScience C** (replications, including failed ones): articles are said to be CC BY 4.0. Confirm for each
  article.
- **Journal of Negative Results in BioMedicine** (BMC, archive, 2002–2017): open access, likely CC BY.
  Confirm for each article.
- **PLOS ONE's null and negative results collection**: PLOS publishes under CC BY 4.0. Confirm the collection
  and each article.

### Left out: licence unclear or incompatible

- **arXiv papers in general:** the licence varies by paper, and many carry arXiv's non-exclusive licence,
  which doesn't allow redistribution.
- **Stack Overflow:** CC BY-SA. Share-alike would bind the records built from it. That's an owner decision,
  not something to do quietly.
- **Public CI logs from repositories outside the allow-list:** they carry no licence.
- **tldr-pages pages that fail the privacy check:** listed in `data/seed/tldr-pages.json` `left_out`.
