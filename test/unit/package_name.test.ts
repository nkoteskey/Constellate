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

  // Until `constellate-mcp` is published by us, anyone could claim it. The app and CLI must
  // point people at their own clone, never at npx. Delete this check once the package is ours.
  it('until the package is published, the app and CLI never tell anyone to npx constellate-mcp', () => {
    let hits = '';
    try { hits = execFileSync('grep', ['-rnE', String.raw`npx (-y )?constellate-mcp|"-y", "constellate-mcp"|'-y', 'constellate-mcp'`, 'src'], { encoding: 'utf8' }); } catch { hits = ''; }
    expect(hits).toBe('');
  });
});
