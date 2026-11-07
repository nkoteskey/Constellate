// Downloads the pinned x0xd for one platform into desktop/resources/x0x/, checked against the
// SHA-256 sums committed below (not just the ones next to the download), so a swapped release
// asset fails the build instead of shipping. Run: node desktop/scripts/fetch-x0x.mjs [platform]
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const X0X_VERSION = '0.48.1'; // keep in step with desktop/lib/x0x.mjs
const SHA256 = {
  'linux-x64-gnu': '73f590441126fc69e4d58c3a4a2543fd0d3ffb6936c4d4d2c55b959c6edd72b3',
  'linux-arm64-gnu': 'abdf2102ffacf569aac758a0a473ff81e4a473d56a88245b7bd71d7684895982',
  'macos-arm64': '7af0d45ed900956186f19c6f094e3f0c09215d7f02cefcfa0af3a9f3aa4dc051',
  'macos-x64': '41d49e0b28dec35315a86e22edac8d843c45bd13898a44eef13e4e47b2caf242',
  'windows-x64': '707433d05d64a9cfdcc146e5a109b326d2b18d96cee61fb8c51f6319632fd761',
};

const host = () => ({ 'linux-x64': 'linux-x64-gnu', 'linux-arm64': 'linux-arm64-gnu', 'darwin-arm64': 'macos-arm64', 'darwin-x64': 'macos-x64', 'win32-x64': 'windows-x64' })[`${process.platform}-${process.arch}`];
const platform = process.argv[2] ?? host();
if (!SHA256[platform]) { console.error(`No pinned x0xd for ${platform ?? `${process.platform}-${process.arch}`}`); process.exit(1); }

const ext = platform.startsWith('windows') ? 'zip' : 'tar.gz';
const url = `https://github.com/saorsa-labs/x0x/releases/download/v${X0X_VERSION}/x0x-${platform}.${ext}`;
const res = await fetch(url);
if (!res.ok) { console.error(`Download failed (${res.status}): ${url}`); process.exit(1); }
const buf = Buffer.from(await res.arrayBuffer());
const sum = createHash('sha256').update(buf).digest('hex');
if (sum !== SHA256[platform]) { console.error(`x0xd checksum mismatch for ${platform}: got ${sum}, pinned ${SHA256[platform]}. Nothing was installed.`); process.exit(1); }

const work = mkdtempSync(join(tmpdir(), 'x0x-'));
const archive = join(work, `x0x.${ext}`);
writeFileSync(archive, buf);
execFileSync('tar', ['-xf', archive, '-C', work]); // bsdtar on macOS and Windows reads zip too
const find = (dir, name) => { for (const e of readdirSync(dir)) { const p = join(dir, e); if (statSync(p).isDirectory()) { const f = find(p, name); if (f) return f; } else if (e === name) return p; } return null; };
const exe = platform.startsWith('windows') ? 'x0xd.exe' : 'x0xd';
const bin = find(work, exe);
if (!bin) { console.error(`${exe} not found in ${url}`); process.exit(1); }

const out = resolve(import.meta.dirname, '..', 'resources', 'x0x');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(bin, join(out, exe));
chmodSync(join(out, exe), 0o755);
for (const l of ['LICENSE-MIT', 'LICENSE-APACHE']) { const f = find(work, l); if (f) cpSync(f, join(out, l)); }
writeFileSync(join(out, 'VERSION'), `x0x ${X0X_VERSION} ${platform} sha256:${sum}\n`);
rmSync(work, { recursive: true, force: true });
console.log(`x0xd ${X0X_VERSION} for ${platform}: verified and placed in ${out}`);
