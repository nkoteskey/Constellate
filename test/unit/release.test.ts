import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/** The release workflow (distribution/RELEASING.md) and what it publishes stay in agreement. */
const json = (f: string) => JSON.parse(readFileSync(f, 'utf8'));
describe('release', () => {
  const pkg = json('package.json'), reg = json('distribution/mcp-registry/server.json');
  const wf = readFileSync('.github/workflows/release.yml', 'utf8');

  it('publishes to npm with provenance and to the MCP Registry, signing in with GitHub, no stored password needed', () => {
    expect(wf).toMatch(/id-token: write/);
    expect(wf).toMatch(/npm publish --provenance --access public/);
    expect(wf).toMatch(/mcp-publisher login github-oidc/);
    expect(wf).toMatch(/tags: \['v\*\.\*\.\*'\]/);
    expect(wf).toMatch(/workflow_dispatch/);
    expect(wf).toMatch(/npm test/); // the full suite runs before anything is published
  });

  it('the registry entry, the npm package and the ClawHub text describe the same version and repository', () => {
    expect(reg.name).toBe(pkg.mcpName);
    expect(reg.packages[0].identifier).toBe(pkg.name);
    expect([reg.version, reg.packages[0].version]).toEqual([pkg.version, pkg.version]);
    // npm's provenance check compares the package's repository with the repository that built it.
    expect(pkg.repository.url).toBe('git+https://github.com/nkoteskey/Constellate.git');
    expect(reg.repository.url).toBe('https://github.com/nkoteskey/Constellate');
    expect(readFileSync('distribution/clawhub/constellate/SKILL.md', 'utf8')).toMatch(new RegExp(`^version: ${pkg.version.replace(/\./g, '\\.')}$`, 'm'));
  });
});
