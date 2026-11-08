# Releasing a version

`.github/workflows/release.yml` publishes to **npm** (`constellate-mcp`) and to the **official MCP Registry**
(`io.github.nkoteskey/constellate`) from GitHub. No password or one-time code is typed anywhere, and npm shows
which commit built each version (a signed provenance statement).

## Once: let npm trust this workflow (the owner, about two minutes)

1. Sign in at https://www.npmjs.com and open **constellate-mcp → Settings → Trusted Publisher**.
2. Choose **GitHub Actions** and fill in:
   - Organization or user: `nkoteskey`
   - Repository: `Constellate`
   - Workflow filename: `release.yml`
   - Environment name: `release`
3. Save. Optionally, on the same page, require two-factor authentication and disallow tokens, so only this
   workflow can publish.

The MCP Registry needs nothing: the workflow signs in with GitHub's own token for this repository, which proves
it owns the `io.github.nkoteskey` namespace.

If you'd rather use an npm token, add it as the repository secret `NPM_TOKEN` (an automation token). The workflow
uses it when it's there.

## Each release

1. The version is bumped in `package.json`, `package-lock.json`, `distribution/mcp-registry/server.json`, the
   MCP server and the agent card. `test/gates/two_computer_check.test.ts` keeps them equal. It also needs
   release notes in `docs/releases/`.
2. Merge it into `main`.
3. Start the release, either way:
   - **Actions → Release → Run workflow** on `main`;
   - or push the tag: `git tag v0.2.0 && git push origin v0.2.0`. The tag has to match `package.json`.
4. The workflow:
   - runs the full test suite;
   - publishes to npm with provenance;
   - publishes `server.json` to the MCP Registry.

   Each step is skipped if that version is already there, so running it again is safe.

## The other listings

- **Directories that mirror the MCP Registry** (mcp.so, PulseMCP and others) pick up the new version from it on
  their own.
- **ClawHub** (`distribution/clawhub/constellate/SKILL.md`) needs the owner's ClawHub sign-in:
  `clawhub skill publish distribution/clawhub/constellate --slug constellate --name "Constellate" --version <x.y.z> --changelog "<what changed>"`.
- **Docker MCP Catalog:** a pull request to `docker/mcp-registry` that moves `source.commit` in
  `servers/constellate/server.yaml` to the release's commit on `main`.
- **Glama** rebuilds from the repository on its own once it's listed.
- **cursor.directory and mcpservers.org** list the npm package by name, so new versions need nothing.

`distribution/LISTINGS.md` records where it's listed and at which version.
