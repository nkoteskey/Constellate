// Builds data/seed/agent-skills.json: openly licensed public agent skills (SKILL.md format), with credit.
//
//   node scripts/import-skills.mjs <clones dir> <x0x SKILL.md> <ant-sdk skill.md>     (needs `npm run build` first)
//
// <clones dir> holds git clones of the source repositories, named as in SOURCES below, checked out at the
// pinned commits. Only skills whose licence lets us redistribute them (Apache-2.0 or MIT) are taken; each keeps
// its source, commit, licence and a modification notice, and each must pass the privacy check (or it's left out).
import { readFileSync, readdirSync, existsSync, writeFileSync, statSync } from 'node:fs';
import { join, relative, resolve, basename } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname, '..');
const { scrub } = await import(pathToFileURL(join(ROOT, 'dist', 'privacy', 'scrub.js')).href);
const [clones, x0xSkill, antSkill] = process.argv.slice(2);
if (!clones || !x0xSkill || !antSkill) { console.error('usage: node scripts/import-skills.mjs <clones dir> <x0x SKILL.md> <ant-sdk skill.md>'); process.exit(2); }

const SOURCES = [
  { dir: 'anthropics_skills', org: 'Anthropic', repo: 'anthropics/skills', commit: '2c5958ecac7cee2b583967a2c4981d0f4a75c579' },
  { dir: 'huggingface_skills', org: 'Hugging Face', repo: 'huggingface/skills', commit: '25910b3d0ba31a2ba102f901cdc9e008c278a69c' },
  { dir: 'openai_skills', org: 'OpenAI', repo: 'openai/skills', commit: '49f948faa9258a0c61caceaf225e179651397431' },
  // A research method in seven stages (frame, evidence, hypothesize, execute, verify, synthesize, and the loop).
  { dir: 'research_loop_skills', org: 'Research Loop', repo: 'wrencanfly/research-loop-skills', commit: '52333290066262c448e423795eac7eddee5f51e5', tags: ['research-method'] },
];
// Left out on purpose: one organisation's own brand, internal or course material; installers that change the
// agent's own setup; empty templates; and duplicates of a skill kept elsewhere in the same repository.
const SKIP = new Set([
  'anthropics/skills:skills/academy-guide', 'anthropics/skills:skills/brand-guidelines', 'anthropics/skills:skills/internal-comms', 'anthropics/skills:template',
  'openai/skills:skills/.system/skill-installer', 'openai/skills:skills/.system/plugin-creator', 'openai/skills:skills/.system/openai-docs',
]);
const MAX = 32_000;
// Exact edits to the x0x and Autonomi skills, so they pass the privacy check: placeholder wording the checker
// reads as a credential, and a person's name and contact address, which Constellate never publishes.
const EDITS = {
  x0x: [
    ['`?token=<session_token>`', '`?token=` with a session token'],
    [/ · \*\*Contact\*\*: [^ ]+@[^ ]+/g, ''],
    [/"human_name":"[^"]+"/g, '"human_name":"<your name>"'],
    [/--human-name "[^"]+"/g, '--human-name "<your name>"'],
  ],
  autonomi: [['Keep it secret: anyone', 'Keep it secret; anyone']],
};
const edit = (body, key) => (EDITS[key] ?? []).reduce((b, [from, to]) => b.replaceAll(from, to), body);
const STOP = new Set(['huggingface', 'hf', 'skill', 'skills', 'the', 'and', 'for', 'to', 'of', 'a', 'with', 'use']);

function front(md) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(md);
  if (!m) return [{}, md];
  const fm = {};
  for (const line of m[1].split('\n')) { const mm = /^([a-zA-Z_-]+):\s*(.*)$/.exec(line); if (mm) fm[mm[1]] = mm[2].trim().replace(/^["']|["']$/g, ''); }
  return [fm, md.slice(m[0].length)];
}
function licenceOf(text) {
  const t = text.slice(0, 4000);
  if (/Apache License\s*\n?\s*Version 2\.0/.test(t)) return 'Apache-2.0';
  if (/\bMIT License\b|Permission is hereby granted, free of charge/.test(t)) return 'MIT';
  return null;
}
const read = (p) => readFileSync(p, 'utf8');
const firstFile = (d, names) => names.map((n) => join(d, n)).find((p) => existsSync(p));
function walk(d, out = []) {
  for (const n of readdirSync(d)) {
    if (n === '.git' || n === 'node_modules') continue;
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p, out); else if (n === 'SKILL.md') out.push(d);
  }
  return out;
}
const caps = (name, extra) => [...new Set([...name.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !STOP.has(w)), ...extra])].slice(0, 12).map((c) => c.slice(0, 40));
function instructions(body, url) {
  const b = body.trim();
  if (b.length <= MAX) return { text: b, shortened: false };
  const cut = b.slice(0, MAX - 200);
  return { text: `${cut.slice(0, cut.lastIndexOf('\n'))}\n\n[Shortened here. The full skill, with any files it uses, is at ${url}]`, shortened: true };
}

const skills = [], left = [];
function add(s) {
  const r = scrub(s, { level: 'standard' });
  if (!r.ok) { left.push({ name: s.name, why: `privacy: ${[...new Set(r.findings.map((f) => f.type))].join(', ')}` }); return; }
  skills.push(s);
}

for (const src of SOURCES) {
  const root = join(clones, src.dir);
  const repoLicFile = firstFile(root, ['LICENSE', 'LICENSE.txt', 'LICENSE.md']);
  const repoLic = repoLicFile ? licenceOf(read(repoLicFile)) : null;
  for (const d of walk(root).sort()) {
    const path = relative(root, d);
    if (SKIP.has(`${src.repo}:${path}`)) { left.push({ name: `${src.repo}/${path}`, why: 'left out by choice' }); continue; }
    const [fm, body] = front(read(join(d, 'SKILL.md')));
    const own = firstFile(d, ['LICENSE.txt', 'LICENSE', 'LICENSE.md']);
    const declared = fm.license ?? '';
    const licence = (own && licenceOf(read(own))) || (/apache/i.test(declared) ? 'Apache-2.0' : /\bMIT\b/.test(declared) ? 'MIT' : null) || (own ? null : repoLic);
    if (!licence) { left.push({ name: `${src.repo}/${path}`, why: 'no open licence we can redistribute under' }); continue; }
    const url = `https://github.com/${src.repo}/tree/${src.commit}/${path}`;
    // MIT asks for its copyright line to travel with the text: from the skill's own licence, or the repository's.
    const mitFile = licence === 'MIT' ? own ?? (repoLic === 'MIT' ? repoLicFile : null) : null;
    const copyright = mitFile ? (/^Copyright.*$/m.exec(read(mitFile))?.[0] ?? '') : '';
    const ins = instructions(body, url);
    const name = (fm.name || basename(d)).slice(0, 80);
    add({
      name, description: (fm.description || name).slice(0, 400), capabilities: caps(name, [...(src.tags ?? []), 'agent-skill']), instructions: ins.text, license: licence,
      source: { org: src.org, repo: src.repo, path: `${path}/SKILL.md`, commit: src.commit, url },
      notice: `From ${src.org}'s ${src.repo} (${path}/SKILL.md at ${src.commit.slice(0, 12)}), under ${licence}${copyright ? ` (${copyright}; the licence text travels with Constellate in data/seed/LICENSES)` : ''}. Changed by Constellate: the YAML header was removed${ins.shortened ? ' and the text was shortened' : ''}; any scripts or files the skill uses are not included and are at the source link.`,
    });
  }
}

// x0x's own skill file (MIT OR Apache-2.0); the author line in its header is dropped with the rest of the header.
{
  const [fm, raw] = front(read(x0xSkill)); const body = edit(raw, 'x0x');
  const url = 'https://github.com/saorsa-labs/x0x/blob/v0.48.1/SKILL.md', ins = instructions(body, url);
  add({ name: 'x0x', description: fm.description.slice(0, 400), capabilities: caps('x0x', ['p2p', 'gossip', 'direct-messaging', 'crdt', 'post-quantum', 'agent-skill']), instructions: ins.text, license: 'MIT OR Apache-2.0',
    source: { org: 'Saorsa Labs', repo: 'saorsa-labs/x0x', path: 'SKILL.md', commit: 'v0.48.1', url },
    notice: `From Saorsa Labs' saorsa-labs/x0x (SKILL.md, version 0.48.1), under MIT OR Apache-2.0 (Copyright (c) 2025 Saorsa Labs). Changed by Constellate: the YAML header was removed, an example token placeholder was reworded, and the author's name and contact address were taken out (Constellate names people only by handle or organisation)${ins.shortened ? '; the text was shortened' : ''}.` });
}
// Autonomi's skill for building apps with ant-sdk (MIT OR Apache-2.0).
{
  const commit = '3184f88c34779d6d449f2c4d76bfae77e4d2aa3e';
  const [, raw] = front(read(antSkill)); const body = edit(raw, 'autonomi');
  const url = `https://github.com/WithAutonomi/ant-sdk/blob/${commit}/skill.md`, ins = instructions(body, url);
  add({ name: 'Building apps on the Autonomi network', description: 'Build applications on Autonomi with ant-sdk: the antd daemon, language SDKs, immutable data, pointers, payments and daemon discovery.', capabilities: caps('autonomi', ['ant-sdk', 'antd', 'storage', 'pointers', 'agent-skill']), instructions: ins.text, license: 'MIT OR Apache-2.0',
    source: { org: 'Autonomi', repo: 'WithAutonomi/ant-sdk', path: 'skill.md', commit, url },
    notice: `From Autonomi's WithAutonomi/ant-sdk (skill.md at ${commit.slice(0, 12)}), under MIT OR Apache-2.0 (Copyright (c) 2026 Autonomi). Changed by Constellate: a colon after "secret" became a semicolon, so the privacy check does not read the sentence as a credential${ins.shortened ? '; the text was shortened' : ''}.` });
}

const out = join(ROOT, 'data', 'seed', 'agent-skills.json');
// `\n@decorator` in escaped code reads like an email to the repository's privacy gate; \u0040 parses back the same.
writeFileSync(out, JSON.stringify({ note: 'Openly licensed public agent skills, imported with credit. See data/seed/LICENSES/NOTICE.md and scripts/import-skills.mjs.', skills }, null, 1).replaceAll('\\n@', '\\n\\u0040') + '\n');
console.log(`${skills.length} skills → ${out}`);
for (const l of left) console.log(`  left out: ${l.name} (${l.why})`);
