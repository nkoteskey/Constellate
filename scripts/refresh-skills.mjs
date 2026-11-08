// Moves the public skills to their latest upstream versions (docs/AGENT_SKILLS.md), for the weekly
// skills-refresh workflow:
//   1. resolve the newest commit of each source repository (the newest vX.Y.Z tag for x0x);
//   2. write the new pins to data/seed/skill-sources.json;
//   3. fetch each source at its pin and rerun scripts/import-skills.mjs, which keeps only openly licensed skills
//      that pass the privacy check;
//   4. write a summary of what moved (for the pull request body).
//
//   node scripts/refresh-skills.mjs [--work DIR] [--summary FILE]      (needs `npm run build` first)
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const ROOT = resolve(import.meta.dirname, '..');
const arg = (n) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : undefined; };
const work = arg('--work') ?? mkdtempSync(join(tmpdir(), 'skills-refresh-'));
const summaryFile = arg('--summary');
const pinsFile = join(ROOT, 'data', 'seed', 'skill-sources.json');
const skillsFile = join(ROOT, 'data', 'seed', 'agent-skills.json');
const git = (...a) => execFileSync('git', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const url = (repo) => `https://github.com/${repo}.git`;

/** The newest commit on a repository's default branch. */
const head = (repo) => git('ls-remote', url(repo), 'HEAD').split(/\s+/)[0];
/** The newest release tag (vX.Y.Z, no pre-releases). */
function newestTag(repo) {
  const tags = git('ls-remote', '--tags', '--refs', url(repo)).split('\n').map((l) => l.split('refs/tags/')[1]).filter((t) => /^v\d+\.\d+\.\d+$/.test(t ?? ''));
  const n = (t) => t.slice(1).split('.').map(Number);
  return tags.sort((a, b) => { const [x, y] = [n(a), n(b)]; return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; }).pop();
}
async function download(u, to) {
  const r = await fetch(u);
  if (!r.ok) throw new Error(`${u}: ${r.status}`);
  writeFileSync(to, await r.text());
}
const byRepo = (file) => { const m = new Map(); for (const k of JSON.parse(readFileSync(file, 'utf8')).skills) m.set(k.source.repo, [...(m.get(k.source.repo) ?? []), k.name]); return m; };

const pins = JSON.parse(readFileSync(pinsFile, 'utf8'));
const before = JSON.parse(JSON.stringify(pins));
const skillsBefore = byRepo(skillsFile);

for (const s of pins.repos) s.commit = head(s.repo);
pins.x0x.tag = newestTag(pins.x0x.repo) ?? pins.x0x.tag;
pins.autonomi.commit = head(pins.autonomi.repo);
writeFileSync(pinsFile, JSON.stringify(pins, null, 2) + '\n');

// Fetch each source at its pin.
mkdirSync(work, { recursive: true });
for (const s of pins.repos) {
  const d = join(work, s.dir);
  mkdirSync(d, { recursive: true });
  git('-C', d, 'init', '-q');
  try { git('-C', d, 'remote', 'add', 'origin', url(s.repo)); } catch { /* already there */ }
  git('-C', d, 'fetch', '-q', '--depth', '1', 'origin', s.commit);
  git('-C', d, 'checkout', '-q', 'FETCH_HEAD');
}
const x0xFile = join(work, 'x0x-SKILL.md'), antFile = join(work, 'ant-skill.md');
await download(`https://raw.githubusercontent.com/${pins.x0x.repo}/${pins.x0x.tag}/${pins.x0x.path}`, x0xFile);
await download(`https://raw.githubusercontent.com/${pins.autonomi.repo}/${pins.autonomi.commit}/${pins.autonomi.path}`, antFile);
const importLog = execFileSync(process.execPath, [join(ROOT, 'scripts', 'import-skills.mjs'), work, x0xFile, antFile], { encoding: 'utf8' });

// What moved.
const skillsAfter = byRepo(skillsFile);
const lines = ['Weekly refresh of the public agent skills (`scripts/refresh-skills.mjs`).', '', '| Source | Pin | Skills |', '|---|---|---|'];
const pinOf = (p, repo) => p.repos.find((r) => r.repo === repo)?.commit ?? (p.x0x.repo === repo ? p.x0x.tag : p.autonomi.commit);
for (const repo of [...pins.repos.map((r) => r.repo), pins.x0x.repo, pins.autonomi.repo]) {
  const a = pinOf(before, repo), b = pinOf(pins, repo);
  const was = skillsBefore.get(repo) ?? [], now = skillsAfter.get(repo) ?? [];
  const added = now.filter((n) => !was.includes(n)), removed = was.filter((n) => !now.includes(n));
  lines.push(`| ${repo} | ${a === b ? `\`${a.slice(0, 12)}\` (unchanged)` : `\`${a.slice(0, 12)}\` → \`${b.slice(0, 12)}\``} | ${now.length}${added.length ? `, added: ${added.join(', ')}` : ''}${removed.length ? `, removed: ${removed.join(', ')}` : ''} |`);
}
const left = importLog.split('\n').filter((l) => /left out: .*\(privacy|no open licence/.test(l));
if (left.length) lines.push('', '<details><summary>Left out (privacy check or licence)</summary>', '', ...left.map((l) => `- ${l.trim().replace(/^left out: /, '')}`), '', '</details>');
lines.push('', 'Review the text that changed before merging: published records are permanent. The test cases in `data/seed/skill-tests.json` must still quote lines that exist in the new text.');
const summary = lines.join('\n') + '\n';
if (summaryFile) writeFileSync(summaryFile, summary);
process.stdout.write(summary);
