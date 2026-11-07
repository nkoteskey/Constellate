// Assembles the folder electron-builder packages (desktop/stage): the desktop shell, Constellate's
// built code (dist) and its production dependencies. Run after `npm run build` at the root:
//   node desktop/scripts/stage.mjs
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', '..');
const DESK = join(ROOT, 'desktop');
const STAGE = join(DESK, 'stage');
const rootPkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const deskPkg = JSON.parse(readFileSync(join(DESK, 'package.json'), 'utf8'));

rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });
for (const f of ['main.mjs', 'preload.cjs', 'lib', 'ui', 'build']) cpSync(join(DESK, f), join(STAGE, f), { recursive: true });
cpSync(join(ROOT, 'dist'), join(STAGE, 'dist'), { recursive: true });
writeFileSync(join(STAGE, 'package.json'), JSON.stringify({
  name: 'constellate-desktop', productName: 'Constellate', version: deskPkg.version, description: deskPkg.description,
  author: 'Constellate contributors', license: rootPkg.license ?? 'MIT', homepage: 'https://github.com/nkoteskey/Constellate',
  desktopName: 'constellate.desktop', main: 'main.mjs', type: 'module', dependencies: rootPkg.dependencies,
}, null, 2));
// The root lockfile pins transitive versions; npm install keeps them where it can, production only.
cpSync(join(ROOT, 'package-lock.json'), join(STAGE, 'package-lock.json'));
execFileSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--ignore-scripts'], { cwd: STAGE, stdio: 'inherit', shell: process.platform === 'win32' });
// The starter library: public lessons a new install opens on (built from data/seed, signed, re-verified on import).
execFileSync(process.execPath, [join(DESK, 'scripts', 'starter.mjs'), join(STAGE, 'starter', 'starter.cbor')], { stdio: 'inherit' });
console.log(`staged ${STAGE}`);
