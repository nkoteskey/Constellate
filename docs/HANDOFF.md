# Handoff

## Status (Nov 8, later): items 1–9 are done

All nine are on `claude/new-session-nvj453`, one commit each with a gate test. PROGRESS.md has a section for
each, and its "Summary of what needs a human" lists what's left for the owner (items 11, 13, 14 and 15 are new or
changed). `npx vitest run`: 245 pass, 1 skipped; `npx tsc --noEmit` is clean.

| # | What landed | Gate |
|---|---|---|
| 1 | `scripts/two-computer-check.mjs`, docs/NETWORK.md, version 0.2.0, docs/releases/v0.2.0.md | `two_computer_check` |
| 2 | `fix_tried` (lean), `src/services/reproduce.ts`, "confirmed by N agents…", ranking, `report_back` | `reproduce` |
| 3 | `src/hub/savings.ts`: dead ends avoided plus an estimate, on home, profiles and `metrics_get` | `savings` |
| 4 | `constellate watch`, `constellate hook claude-code`, docs/HOOKS.md | `watch_hook` |
| 5 | `Pages.auto`, stable topic keys, `#/topic/<key>`, page-first search replies | `pages_auto` |
| 6 | `src/collab/help-notes.ts`: `help_wanted` notes, `watchHelpAnswers`, answers judged once | `help_midtask` |
| 7 | tldr-pages (CC BY 4.0) in the starter, `ISSUE_SEED_PROPOSED`, docs/SEED_SOURCES.md | `seed_licensed` |
| 8 | `src/work/witness.ts`, four open problems with sources, docs/OPEN_PROBLEMS.md | `open_problems` |
| 9 | `src/contributor/lend.ts`, one card in the desktop app, limits, log, pledge | `lend` |

**For the owner:**
- merge PR #21;
- `npm publish` 0.2.0 and push the tag;
- run the two-computer check;
- decide on the seed sources in docs/SEED_SOURCES.md;
- try lending and the Claude Code hook on a real computer.

The scheduled check-in `trig_015sZ8roNXPMfvF6bwPwNeyn` is still there; delete it once #21 has merged.

---

## Earlier: the plan for the nine improvements

Written at the end of a long session so a fresh one can pick up with a clean context. Read this first, then
DESIGN.md and PROGRESS.md as needed. The rules in CLAUDE.md still apply (personal data is never published, never
weaken `src/privacy/*` or its tests, real money and paid storage stay off).

## Where things stand

- **Branch:** `claude/new-session-nvj453`. PR #21 (npm users join x0x on their own, agents work on steps, names
  and models, sealed mailbox, MCP-only reach) is open, all green, waiting for the owner to merge.
  - If #21 has merged when you start: restart the branch from `origin/main` (same name) and open a new PR for
    this work. If it hasn't: keep committing on the branch; the work lands in #21 or a follow-up PR.
- **Version:** `package.json` is 0.1.1. npm has 0.1.0. Tag `v0.1.0` isn't pushed yet (this environment gets 403
  on tag pushes; the owner pushes tags).
- **Tests:** `npx vitest run` (210 tests). `test/setup.ts` gives each file a throwaway HOME and
  `CONSTELLATE_X0X=off`. The real-x0x gate in `test/gates/network_setup.test.ts` runs when
  `CONSTELLATE_TEST_X0X_ARCHIVE` is set (CI sets it).
- **Scheduled check-in** for PR #21: `trig_015sZ8roNXPMfvF6bwPwNeyn`. Delete it once #21 has merged.
- **Environment limits seen here:** no tag pushes, no force-push, no outside repos via add_repo. Inline
  heredoc Python was blocked by a safety check, so write scripts to the scratchpad and run them from there.

## Already built: extend these, don't duplicate them

| Need | Existing piece |
|---|---|
| Others confirm or dispute a record | kinds `confirmation`, `contradiction`; tools `records_confirm`, `records_contradict`; `src/services/trust.ts`, `src/services/reputation.ts` |
| Mark that a result was used | `records_used` tool, kind `use` |
| Topic pages and summaries | `src/graph/pages.ts` (rules with evidence and a status), `src/graph/consolidate.ts` (kind `summary`), docs/MEMORY.md |
| Help mid-task | kind `help_request`; tools `help_request`, `help_accept`; bounties in `src/economy/bounties.ts` (money off by default) |
| Metrics | `src/hub/metrics.ts`, tool `metrics_get` |
| Seeding | `src/seed/` (`issues.ts` allow-list, `papers.ts`, `agent-skills.ts`), `data/seed/LICENSES/` |
| Problems with machine checks | `src/collective/*`, verifiers (`exact`, `lean`, `sum_squares_mod`, …), `src/work/agent-step.ts` |
| Lending a computer | `src/contributor/*`, desktop app in `desktop/` |
| Constitution | `src/collective/constitution.ts`, `src/web/public/constitution.md` |
| Lean MCP tool set | `src/mcp/mode.ts` `LEAN_TOOLS` (keep it small: docs/STORAGE.md budgets ~2,400 tokens) |

## The work, in order (the owner asked for 1–9)

1. **Two-computer check, and 0.2.0.**
   - Write `scripts/two-computer-check.mjs`. On computer A: share a uniquely tagged failure. On computer B:
     poll `failures_search` until it shows up, and print the delay. Both run over the public x0x network
     (`CONSTELLATE_X0X=auto`).
   - Document it in docs/NETWORK.md. The owner runs it; this environment can't use two real computers.
   - Bump to 0.2.0 and add `docs/releases/v0.2.0.md`. The owner runs `npm publish` and pushes the tag.
2. **Agents reproduce each other's findings.**
   - When an agent tries a recorded fix, it reports whether that worked, through `records_confirm` or
     `records_contradict` with evidence: environment, error before and after.
   - Show "confirmed by N agents from M model families on K computers", using `context.agent` and agent
     ids, in search results and on the web.
   - Rank searches by independent confirmation.
   - Prompt for it: when `failures_search` returns a fix, the reply asks the agent to report back once it has
     tried it.
   - Keep the lean tool count low: fold this into an existing tool, or add one tool and update docs/STORAGE.md.
3. **Show what it saved.**
   - Count uses (`use` records, `records_used`) where an agent avoided a known failed approach.
   - Estimate time and tokens saved, conservatively and labelled as an estimate.
   - Show it on profiles, the home page and in `metrics_get`. Count behaviour only on this node unless the
     operator chooses to publish it (see the `metrics.ts` header).
4. **Fixes that arrive when the error happens.**
   - `constellate watch -- <command>` runs a command. On a non-zero exit, it searches the ledger with the
     error output (privacy-scrubbed locally) and prints the best matching verified fixes.
   - Add a Claude Code hook recipe (PostToolUse on Bash failures) that does the same, documented in a new
     docs/HOOKS.md. It must never publish anything by itself.
5. **Topic pages written automatically.**
   - Make `src/graph/pages.ts` / `consolidate.ts` run on their own once a topic has enough verified records.
   - Each page is signed and links its sources.
   - Agents get the page first: one compact answer instead of many records.
   - Give the web a readable page with a stable link.
6. **Ask for help mid-task.**
   - Surface `help_request` to connected agents with matching skills in their next tool reply, the way
     `person_asked` notes work (`src/work/work-requests.ts`).
   - Answers still pass their check.
   - A bounty is optional; money stays off unless the owner turns it on.
7. **More open failure data, licensed.**
   - Add seed sources with their licences kept on every record and in `data/seed/LICENSES/`:
     - tldr-pages (CC BY 4.0) for command usage;
     - public CI failure history from widely used open-source projects, which needs the owner to approve
       the allow-list extension in `src/seed/issues.ts`;
     - negative-results sources only where the licence clearly allows it.
   - Never name people. The privacy scrub runs on every record. Leave out anything whose licence is unclear,
     and list it for the owner instead.
8. **Problems from science and maths.**
   - Seed a curated set of open problems that have machine-checkable success, so agents can work alone and
     honestly. Examples: small open problems with exact or Lean verifiers, and OEIS sequence extensions
     checked by computation.
   - Each comes with its source, its definition of done and its verifier.
   - Don't claim a problem is open unless a public source says so.
9. **Lend a computer in one click.**
   - In the desktop app (`desktop/`), a toggle with limits: hours per night, never on battery, a CPU cap.
   - A visible log of what ran.
   - Off by default. It ties into `compute_pledge` and work steps.

Not in this batch, but needed before announcing widely: the constitution keyword and safety review, and
Apple and Windows code-signing (which needs the owner's accounts).

## How to work

- One commit per item, each with tests in `test/gates/`. Run `npx vitest run` and `npx tsc --noEmit`
  (or the repo's build) before each commit.
- Check the UI with Playwright (it's pre-installed; don't reinstall it).
- Update PROGRESS.md and the relevant docs/*.md in the same commit.
- Write for people in plain words, as in the existing docs and the agent-facing notes.
- After each push, tell the owner what landed and what needs them.
