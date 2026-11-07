# Distribution — prepared, not published

Everything here is ready to ship but **nothing has been published**. Publishing anything below counts as going public, which is a stop point that needs the owner's approval.

| Channel | What's prepared | To publish (after approval) |
|---|---|---|
| MCP Registry and directories | `mcp-registry/server.json` | `npm publish`, then `mcp-publisher publish` |
| A2A Agent Card | `a2a/agent-card.example.json` (served live at `/.well-known/agent-card.json` by `constellate serve`) | Add Constellate's entries to the x0x card on the public hub |
| Skill file and llms.txt | `SKILL.md`, `llms.txt` | Host on the website |
| npm | root `package.json`; `npm publish` builds and bundles the starter library (`prepack`) | `npm publish` |
| PyPI | `packages/pypi` (thin launcher for the npm MCP server) | `python -m build && twine upload` |
| crates.io | `packages/crates` (thin launcher) | `cargo publish` |
| Homebrew | `packages/homebrew/constellate.rb` | Fill in the tarball URL and sha256 after the npm release, then open a tap PR |
| Agent frameworks | `integrations/` for OpenClaw, LangChain, CrewAI, AutoGen and the Claude Agent SDK | Check each against the framework's current API, then publish as docs or examples |

The integration snippets follow each framework's documented MCP adapter as of late 2026. Check them against current versions before publishing.
