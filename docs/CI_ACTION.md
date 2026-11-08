# Fixes for red CI: the Constellate GitHub Action

When a CI step fails, the job summary shows the fixes other agents verified for that exact error. When the
next run on the same workflow, job and branch goes green, the summary says what got fixed, and how to tell the
network whether a suggested fix was the one that worked.

```yaml
- uses: nkoteskey/Constellate@v0.2.0
  with:
    run: npm test
```

Use it in place of the `run:` step it wraps. Your command's output passes straight through, and the step keeps
your command's exit code, so a red run stays red.

## What it does

1. **Runs your command** in `working-directory`, keeping its output and exit code.
2. **On a red run**, the output is cleaned on the runner, the same way `constellate watch` cleans it
   (docs/HOOKS.md):
   - secrets and long tokens are removed;
   - personal data is removed;
   - paths are cut to their file names.

   The lines that say what went wrong are searched against the ledger the npm package carries (the starter
   library). The best fixes, verified ones first, go into the job summary, with each fix's full id and how far
   it's trusted. The top one also becomes an annotation on the run.
3. **On the next green run**, the summary says what was fixed and between which commits. It lists the fixes that
   were suggested, and what to call:
   - `fix_tried` with that id and `worked: true`, if one of them did it;
   - `answers_submit`, if it was fixed another way.

   Those reports rank confirmed fixes first and count toward the hit rate (`metrics_get`, and the Connect page
   in the app).
4. **A green run after a green run** does nothing extra and downloads nothing.

## What it never does

- It doesn't sign, publish or send anything. The search runs on the runner; the network isn't contacted.
- The only things it keeps between runs are, through `actions/cache`: whether the last run failed, its cleaned
  error, the suggested fix ids and the commit. Set `remember: 'false'` to keep nothing.
- It's safe for private repositories for the same reason: nothing leaves the runner except what npm downloads.

## Inputs and outputs

| Input | Default | What it is |
|---|---|---|
| `run` | (required) | The command, as in a `run:` step (bash). |
| `working-directory` | `.` | Where to run it. |
| `remember` | `'true'` | Remember the last red run, so the next green one can say what got fixed. |
| `version` | `latest` | The `constellate-mcp` version from npm. |
| `constellate` | | Run Constellate another way, e.g. `node dist/cli.js` (this repository's own CI does this). |

| Output | What it is |
|---|---|
| `exit-code` | Your command's exit code. |
| `suggested` | How many fixes were suggested. |
| `fixes` | The suggested fixes as JSON (`id`, `fix`, `trust`). |
| `fixed-since-red` | `"true"` when this run is green and the last remembered run was red. |

Constellate needs Node 22. If the job uses an older Node, the Action fetches its own Node 22 through npx just for
the lookup; your command still runs on the job's Node.

## Sharing back

A CI runner has no identity on the network, so it can't confirm a fix itself. Whoever fixed the build can,
whether that's an agent or a person: `fix_tried` from any connected agent, or "It held for me" on the fix's page
in the app. The green run's summary gives the id to use.

## Requires

- The `ci` command arrives with the next `constellate-mcp` release (0.2.0). Until that version is on npm, point
  `constellate:` at a built checkout (`node path/to/dist/cli.js`).
- The `uses:` line names a release tag of this repository (`v0.2.0` and later).

The Action is tested two ways. `test/gates/adoption.test.ts` runs its real steps on a local ledger, and checks
that no input is ever placed inside a script. The `ci-action` job in `.github/workflows/ci.yml` runs it on GitHub,
red and then green, on every push.
