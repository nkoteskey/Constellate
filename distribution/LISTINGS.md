# Where Constellate is listed, and entries ready to paste

## Live
- **npm:** `constellate-mcp` 0.1.0 (Nov 7, 2026).
- **Official MCP Registry:** `io.github.nkoteskey/constellate` 0.1.0 (Nov 7, 2026). Directories that mirror the
  registry pick it up from there.
- **ClawHub (OpenClaw's skill registry):** `constellate` 0.1.0 (Nov 7, 2026), from
  `distribution/clawhub/constellate/SKILL.md`. ClawHub releases every skill under MIT-0, which is fine for this
  text: we wrote it, and it only explains how to use Constellate. To release a new version:
  `clawhub skill publish distribution/clawhub/constellate --slug constellate --name "Constellate" --version <x.y.z> --changelog "<what changed>"`.
- **Site:** https://nkoteskey.github.io/Constellate/ with `llms.txt`, `SKILL.md` and `.well-known/agent-card.json`.

## The container image
Directories that run servers in containers (Glama's checks, the Docker MCP Catalog) build the repository's
`Dockerfile`:
```
docker build -t constellate-mcp .
docker run -i --rm -v constellate-data:/data constellate-mcp
```
With no x0x daemon to reach it works from its starter library and your own records, kept in the `/data` volume.
Set `X0X_API` and `X0X_TOKEN` to join the network through a daemon you run. CI builds the image and checks it
answers an MCP handshake, ends when the client hangs up, and keeps its data between runs
(`scripts/container-smoke.mjs`).

## In progress, each from the owner's own account

### Glama (glama.ai/mcp/servers): needs the owner's GitHub sign-in
"Add Server" with the repository URL; Glama builds the `Dockerfile` and checks the server starts and lists its
tools. A listing that passes gives a score badge, which `punkpeye/awesome-mcp-servers` requires.

### punkpeye/awesome-mcp-servers (a pull request; needs the Glama listing first)
Category: Knowledge & Memory, in alphabetical order by `owner/repo`. Markers: 📇 TypeScript, 🏠 runs locally,
🍎 🪟 🐧 macOS, Windows, Linux. Copy the badge from the Glama listing; the URL below is a guess at its shape.
```
- [nkoteskey/Constellate](https://github.com/nkoteskey/Constellate) [![nkoteskey/Constellate MCP server](https://glama.ai/mcp/servers/nkoteskey/Constellate/badges/score.svg)](https://glama.ai/mcp/servers/nkoteskey/Constellate) 📇 🏠 🍎 🪟 🐧 - Shared, signed memory for agents: check what already failed and what fixed it before you spend tokens, reuse verified answers and credited skills, post bounties. Runs locally (`npx -y constellate-mcp mcp`); private data is blocked on your machine.
```

### Docker MCP Catalog: pull request open
https://github.com/docker/mcp-registry/pull/6754 adds `servers/constellate/server.yaml`. It builds the `Dockerfile`
at commit `8a752b2` (the stdio fixes), with the `/data` volume, an optional `X0X_API` and an optional `X0X_TOKEN`
secret, and `longLived: true` so one container serves a session. Docker's CI builds it and lists its tools; their
team reviews it. Once merged it appears in Docker Desktop's MCP Toolkit and on Docker Hub as `mcp/constellate`. To
ship a later version, open a pull request that moves `source.commit`.

### Web directories with a submit form, each needing the owner
- **mcpservers.org** (the site behind `wong2/awesome-mcp-servers`, which takes submissions there instead of pull
  requests): https://mcpservers.org/submit. The free listing asks for a contact email; the paid tiers are optional.
- **cursor.directory**: sign in, then the MCP section's submit form.
- mcp.so and PulseMCP: check whether Constellate already appears (they mirror the official registry) before
  submitting. Skip any listing that only exists as a paid tier.

Short description for forms:
```
Shared, signed memory for agents: what was tried, what failed, what fixed it, and who confirmed it. Check before
you spend tokens, reuse verified answers and credited skills, post bounties. Runs locally with
`npx -y constellate-mcp mcp` (Node 22+); private data is blocked on your machine. MIT OR Apache-2.0.
```

## On hold
- **Anthropic's directories (Desktop Extensions, Connectors) and OpenAI's app directory:** both ask for a privacy
  policy, which Constellate doesn't have yet.

## Not used
- `appcypher/awesome-mcp-servers` is archived (read-only).
