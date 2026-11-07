/**
 * Build a one-click Claude Desktop bundle (MCP Bundle, .mcpb): the MCP server
 * compiled into a single self-contained file, so installing it needs no npm
 * package and no terminal. Prepared, not published: the file lands in
 * distribution/ and goes out only with an approved release.
 * Usage: npx tsx scripts/build-mcpb.mts
 */
import { build } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const work = join(root, 'distribution', 'mcpb', 'build');
const out = join(root, 'distribution', 'mcpb', 'constellate.mcpb');
rmSync(work, { recursive: true, force: true });
mkdirSync(join(work, 'server'), { recursive: true });

await build({
  entryPoints: [join(root, 'src/cli.ts')],
  outfile: join(work, 'server', 'index.mjs'),
  bundle: true, platform: 'node', format: 'esm', target: 'node20', minify: true, legalComments: 'linked',
  // Node built-ins stay external; everything else (MCP SDK, post-quantum crypto) is inside the one file.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
// Data files the server reads next to itself at runtime.
cpSync(join(root, 'src/graph/context.jsonld'), join(work, 'server', 'context.jsonld'));

const manifest = {
  manifest_version: '0.2',
  name: 'constellate',
  display_name: 'Constellate',
  version: pkg.version,
  description: 'Check what other agents already tried before you spend tokens: failures, verified answers, skills and second opinions, signed and shared over x0x.',
  long_description: 'One connection, and every agent’s experience becomes yours. Reads are free. Anything you share is scrubbed for secrets and personal data on this machine first, and shown to you before it leaves.',
  author: { name: 'Constellate contributors', url: 'https://github.com/nkoteskey/constellate' },
  repository: { type: 'git', url: 'https://github.com/nkoteskey/constellate' },
  license: pkg.license,
  keywords: ['x0x', 'agents', 'memory', 'failures', 'skills', 'post-quantum'],
  server: { type: 'node', entry_point: 'server/index.mjs', mcp_config: { command: 'node', args: ['${__dirname}/server/index.mjs', 'mcp'], env: { CONSTELLATE_PREVIEW: 'on' } } },
  compatibility: { platforms: ['darwin', 'win32', 'linux'], runtimes: { node: '>=20.0.0' } },
};
writeFileSync(join(work, 'manifest.json'), JSON.stringify(manifest, null, 2));
rmSync(out, { force: true });
execFileSync('zip', ['-qr', out, '.'], { cwd: work });
console.log(`bundle: ${out}`);
