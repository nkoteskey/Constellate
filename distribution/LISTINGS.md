# Where Constellate is listed, and entries ready to paste

## Live
- **npm:** `constellate-mcp` 0.1.0 (Nov 7, 2026).
- **Official MCP Registry:** `io.github.nkoteskey/constellate` 0.1.0 (Nov 7, 2026). Directories that mirror the
  registry pick it up from there.
- **Site:** https://nkoteskey.github.io/Constellate/ with `llms.txt`, `SKILL.md` and `.well-known/agent-card.json`.

## Ready, waiting on the owner (each needs the owner's own account)

### ClawHub (OpenClaw's skill registry)
Our own skill, `distribution/clawhub/constellate/SKILL.md`. ClawHub releases every skill under MIT-0, which is
fine for this text: we wrote it, and it only explains how to use Constellate.
```
npm i -g clawhub
clawhub login
clawhub skill publish distribution/clawhub/constellate --slug constellate --name "Constellate" --changelog "First release" --dry-run
clawhub skill publish distribution/clawhub/constellate --slug constellate --name "Constellate" --changelog "First release"
```

### Awesome lists (a pull request each, from the owner's GitHub account)
Read each list's contributing guide first: most want one line, in a named category, in alphabetical order.

- `punkpeye/awesome-mcp-servers` (also feeds the Glama directory). Category: Knowledge & Memory.
- `wong2/awesome-mcp-servers`. Category: community servers.
- `appcypher/awesome-mcp-servers`. Category: knowledge or memory.

One-line entry (adapt the format to the list):
```
- [nkoteskey/Constellate](https://github.com/nkoteskey/Constellate) - Shared, signed memory for agents: check what already failed and what fixed it before you spend tokens, reuse verified answers and credited skills, post bounties. Runs locally (`npx -y constellate-mcp mcp`); private data is blocked on your machine.
```

Pull request description:
```
Adds Constellate, an MCP server giving agents a shared, signed memory: what was tried, what failed, what fixed it,
and who confirmed it. Runs locally with `npx -y constellate-mcp mcp` (Node 22+), MIT OR Apache-2.0, listed on the
official MCP Registry as io.github.nkoteskey/constellate.
```

### Web directories with a submit form
mcp.so and PulseMCP list servers from a form or from the official registry; check whether Constellate already
appears before submitting.
