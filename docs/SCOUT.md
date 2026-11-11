# The scout: open problems worth proposing

Proposing a problem should take one press. The scout reads public catalogues of open problems, ranks them by how
close a computer is to checking an answer, and fills in the propose form for the person to read and post. It
never posts on its own.

Code: `src/scout/` (`sources.ts` reads the catalogues, `scout.ts` ranks them). Gate: `test/gates/scout.test.ts`.

## Where it shows up

| Where | What |
|---|---|
| App: **Proposals → Suggested** | Four lanes of cards with a search box. **Propose this** opens the usual form, filled in, for the person to edit and post. Problems already proposed say "Already an idea". |
| CLI: `constellate scout` | The top of each lane. `--lane quick\|moonshot\|formal\|all`, `--realm`, `--q "prime gaps"`, `--limit`, `--refresh`. `--propose ID` prints the idea; it does not post. |
| MCP: `problems_scout` | Full mode (`CONSTELLATE_MCP_TOOLS=full`), read-only and free. Each item carries the idea to propose; the tool tells the agent to let its person choose. |

## The catalogues

Both are Apache-2.0, read from their public GitHub repositories. Licence and notice are in
`data/seed/LICENSES/NOTICE.md`.

| Catalogue | What we read | Size (read 2026-11-11) |
|---|---|---|
| [teorth/erdosproblems](https://github.com/teorth/erdosproblems) `data/problems.yaml` | number, status, prize, tags, OEIS links, whether it is formalised, the short common name | 1,221 problems |
| [google-deepmind/formal-conjectures](https://github.com/google-deepmind/formal-conjectures) | each file's title, and each open statement's name, docstring and AMS subject codes | 1,094 files, 1,860 open statements |

The app refreshes the copy in the background when it is a week old (`CONSTELLATE_SCOUT_REFRESH=off` turns that
off, and so does private read mode for the MCP tool). The copy lives in `CONSTELLATE_HOME/scout/catalogue.json`
and is replaced in one step, so a failed or empty read keeps the copy we have.

**Since 2026-10-06 erdosproblems.com no longer shows statuses or solved counts**; the repository's YAML is the
source for them. Its CONTRIBUTING.md defines the statuses the scout relies on:

- **falsifiable**: open, but if false, one finite counterexample disproves it.
- **verifiable**: open, but if true, one finite example proves it.
- **decidable**: both.
- **"(Lean)" at the end**, even "open (Lean)": a solution has been checked in Lean and awaits a human reading.
  The scout treats these as settled, not open.

## People are never named

Both catalogues carry people's names: contributor notes in the YAML, and author lists in every Lean file's
references. The scout never reads them:

- The YAML's `formal_status` block (notes and links) is skipped without being parsed, including notes that run
  over several lines.
- Every Lean `*References:*` block is cut off before anything is read from it.
- Any sentence that credits someone is dropped: "proved by", "due to", "conjectured", a citation key like
  `[AB12]`, an initial and a surname, an OEIS signature ("_Name_, Jul 01 2010"), a dated aside, a link.
- Descriptions under a file's title are read only for sequences (OEIS) and encyclopaedia entries, where they
  define the object; for papers and books they are usually an author list.
- Whatever is left must still pass the network's personal-data check (`src/privacy/scrub.ts`) to be shown.

On the real catalogues the ranking has no string the privacy check flags. The gate plants text where the real
catalogues hold names (notes, references, "conjectured by …", "from …", an OEIS signature) and checks none of
it reaches the parsers' output, the ranking, the copy on disk, the API, MCP or the page.

## How it ranks

Each problem lands in one lane:

| Lane | What | Examples |
|---|---|---|
| **Quick wins** | A machine checks an answer, or a finite search could settle it. | Erdős problems marked falsifiable, verifiable or decidable. |
| **Moonshots** | A prize of $500 or more, a Millennium or Hilbert problem, or famous enough for an encyclopaedia entry. | Long odds; big news if one falls. |
| **Stated in Lean** | Stated precisely enough that a proof checks itself. | Open formal-conjectures statements. |
| **Not yet checkable** | Open, with nothing a machine can check yet. Hidden unless asked for. | Erdős problems with no finite route and no Lean statement. |

Within a lane, points for: a finite route (35), a Lean statement (25), a prize (up to 20, by size), OEIS links
(5: small cases can be computed), a Millennium problem (20), a sequence or encyclopaedia entry (10), several
open statements in one place (up to 5).
Problems the catalogue marks "ambiguous statement" lose 30 and drop to Not yet checkable. Problems already on
the network (the starter library's `seed:` problems) are not suggested again.

Every card says why it ranks where it does, in plain words, and links its source with the date read.

## What a proposal carries

**Propose this** fills in the title, the statement, how a computer would help, a definition of done, the realm
and the check, and a source link with the date read. The statement text comes from formal-conjectures
(Apache-2.0) and says so. The person reads it, changes what they like, and posts; the constitution check runs
first, as for any proposal. The proposal carries the scout id (`erdos:647`, `fc:OEIS/123.lean`), which the
server checks against a strict pattern; the Suggested tab uses it to mark problems already proposed.

An idea becomes a live problem the usual way: someone splits it into steps a machine can check (Plan it with
your agent), and it goes live once the constitution check clears it.

## Honest about checking

- **Quick wins** need a witness check. The registered ones (`src/work/verifiers.ts`, docs/OPEN_PROBLEMS.md)
  check an answer in under a second. For an Erdős problem with a finite route, the check for its answer usually
  has to be written first; the idea says so.
- **Lean statements** can be checked today by anyone with Lean and Mathlib. **The network has no check for
  them yet.** The planned one:
  - pins a formal-conjectures commit;
  - confirms the submitted file's statement is the pinned statement, unchanged;
  - builds it with no `sorry` and only the standard axioms (`propext`, `Classical.choice`, `Quot.sound`);
  - runs only on computers that opted into Lean builds (`src/work/lean-project.ts` already does this for a
    person's own Lean projects).

## Other realms

The catalogues are mathematics. For the other realms (life sciences, planet and energy, philosophy and
ethics, art and creativity) `problems_scout` returns a scouting brief instead: where open problems in that
realm are listed publicly, and the rules for proposing one (a public source URL with the date read; people
named only by a public @handle or an organisation). Catalogue readers for those realms are tracked in issue #36.
