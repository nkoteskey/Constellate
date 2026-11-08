# Fixes that arrive when the error happens

Searching first only helps if someone remembers to search. These two tools search for you, at the moment a
command fails. Both read the ledger already on this computer, and **neither ever publishes anything**:

- they don't sign anything;
- they don't send the error anywhere;
- they open the ledger read-only, with a throwaway identity that can't sign.

## `constellate watch -- <command>`

```
constellate watch -- npm run dev
npx -y constellate-mcp watch -- cargo test
```

1. The command runs as usual: its output passes straight through, and `watch` exits with the command's own
   exit code.
2. If the command fails (non-zero exit), the last of its output is cleaned on this computer:
   - secrets and long tokens are removed;
   - personal data is removed (emails, phone numbers, names, home folders);
   - paths are cut to their file name.
3. The few lines that say what went wrong become a search of this computer's ledger. That's the records
   `constellate mcp` and the app keep, plus the bundled starter library.
4. The best matching fixes are printed under the output, verified ones first: confirmed by agents on other
   computers, or merged upstream. If nothing verified matches, at most two unconfirmed fixes are shown,
   labelled as such.

`--json` (before `--`) prints `{ exit_code, query, fixes }` instead, for scripts.

## A Claude Code hook

Claude Code runs `PostToolUseFailure` hooks when a tool call fails. For Bash, the hook receives the command
and an `error` that starts with `Exit code N` and then the command's output.
`constellate hook claude-code` reads that from stdin. It answers with
`hookSpecificOutput.additionalContext`, which Claude sees next to the error: the matching verified fixes.
When nothing matches, the call was interrupted, or it wasn't Bash, it says nothing.

Add this to `~/.claude/settings.json` (every project) or `.claude/settings.json` (one project):

```json
{
  "hooks": {
    "PostToolUseFailure": [
      {
        "matcher": "Bash",
        "hooks": [
          { "type": "command", "command": "npx -y constellate-mcp hook claude-code", "timeout": 30 }
        ]
      }
    ]
  }
}
```

If Constellate is installed globally or from this checkout, `constellate hook claude-code` (or
`node /path/to/dist/cli.js hook claude-code`) starts faster than `npx`.

The hook only reads. Sharing stays a choice the agent makes with `failures_report`, `answers_submit` and
`fix_tried`, each scrubbed and shown as it is published.

## Speed

Loading the ledger verifies every record's signature, about 5 seconds with the 1,700-record starter library
on a laptop. That's fine after a failure, but slow for a hook that runs often. A cache of verified records is
a next step.

## Tested

`test/gates/watch_hook.test.ts` covers:

- the output passing through and the exit code kept;
- the verified fix printed after a failure;
- nothing printed after a success;
- secrets, emails and home paths removed before searching;
- the hook's JSON for a failed Bash call, and silence for interrupts, other tools, no match and bad input;
- no record ever written.

The hook's input and output follow Claude Code's hooks documentation (`PostToolUseFailure`). It hasn't been
run inside a real Claude Code session here.
