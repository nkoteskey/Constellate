import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/**
 * The npm name "constellate" belongs to an unrelated project (constellators/constellate,
 * 2022). Every setup snippet, one-click link and prepared package must point at OUR
 * package, "constellate-mcp", or a person following them would run a stranger's code.
 */
describe('package name safety', () => {
  it('our npm package is constellate-mcp, and nothing tells anyone to run the bare "constellate" package', () => {
    expect(JSON.parse(readFileSync('package.json', 'utf8')).name).toBe('constellate-mcp');
    let hits = '';
    try {
      hits = execFileSync('grep', ['-rnE', '--exclude-dir=node_modules', '--exclude-dir=.git', '--exclude-dir=site', '--exclude-dir=dist', '--exclude-dir=mcpb', '--exclude=package_name.test.ts',
        String.raw`npx (-y )?constellate([^-]|$)|"constellate", "mcp"|'constellate', 'mcp'|npm (view|install( -g)?) constellate([^-]|$)|registry\.npmjs\.org/constellate/|"identifier": "constellate"`, 'src', 'distribution', 'README.md', 'scripts'], { encoding: 'utf8' });
    } catch { hits = ''; } // grep exits 1 when nothing matches
    expect(hits).toBe('');
  });

  // `constellate-mcp` is published by us (0.1.0, Nov 7 2026), so the app may tell people to npx it, and does.
  it('the app\'s setup snippets run our npm package, constellate-mcp', () => {
    expect(readFileSync('src/web/public/app.js', 'utf8')).toMatch(/'-y', 'constellate-mcp', 'mcp'/);
  });
});
