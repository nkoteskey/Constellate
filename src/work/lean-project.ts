import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { homedir } from 'node:os';
import type { Verifier } from './verifiers.js';

/**
 * Re-checking a published Lean 4 proof (docs/LEAN_PROJECTS.md): a lent computer clones the project at a pinned
 * commit, builds it with Lean and Mathlib, and asks Lean which axioms each named theorem rests on. A theorem passes
 * when it depends only on Lean's three standard axioms (propext, Classical.choice, Quot.sound): no `sorry`, no
 * added axiom. The verifier repeats the whole build itself and the two reports must agree.
 *
 * Building a project runs its code, so only projects on this reviewed list, at exactly these commits, are built.
 * It needs Lean installed (elan, which provides `lake`) and room for Mathlib (several GB), so only computers that
 * have it take these steps.
 */
export interface LeanProjectSpec { repo: string; commit: string; module: string; theorems: string[]; axioms?: string[]; timeout_ms?: number }

export const LEAN_PROJECTS: { repo: string; commit: string; why: string }[] = [
  { repo: 'https://github.com/physical-superintelligence/aaronson-ambainis', commit: '2a6ceaef872ae993708950f951989134084b851a', why: 'Claimed proof of the Aaronson–Ambainis conjecture (Lean 4.33, Mathlib); reviewed for the network to re-check.' },
];
export const STANDARD_AXIOMS = ['propext', 'Classical.choice', 'Quot.sound'];

const NAME = /^[A-Za-z_][A-Za-z0-9_.'!?]*$/;
const reviewed = (s: LeanProjectSpec) => LEAN_PROJECTS.some((p) => p.repo === s.repo && p.commit === s.commit);

/** `lake`, if Lean is installed (CONSTELLATE_LAKE overrides; "off" disables). */
export function lakeBinary(): string | null {
  const o = process.env.CONSTELLATE_LAKE;
  if (o === 'off') return null;
  if (o) return existsSync(o) ? o : null;
  const n = process.platform === 'win32' ? 'lake.exe' : 'lake';
  for (const dir of [...(process.env.PATH ?? '').split(delimiter), join(homedir(), '.elan', 'bin')]) if (dir && existsSync(join(dir, n))) return join(dir, n);
  return null;
}

function run(cmd: string, args: string[], cwd: string | undefined, timeoutMs: number): Promise<{ code: number; out: string }> {
  return new Promise((res) => {
    const p = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; if (out.length > 4e6) out = out.slice(-2e6); });
    p.stderr.on('data', (d) => { out += d; if (out.length > 4e6) out = out.slice(-2e6); });
    const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.on('error', (e) => { clearTimeout(t); res({ code: -1, out: `${out}\n${e.message}` }); });
    p.on('close', (code) => { clearTimeout(t); res({ code: code ?? -1, out }); });
  });
}

/** Parse Lean's `#print axioms` lines into theorem → axioms. */
export function parseAxioms(text: string): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const line of text.split('\n')) {
    const dep = line.match(/^'([^']+)' depends on axioms: \[([^\]]*)\]/);
    if (dep) { m.set(dep[1], dep[2].split(',').map((x) => x.trim()).filter(Boolean).sort()); continue; }
    const none = line.match(/^'([^']+)' does not depend on any axioms/);
    if (none) m.set(none[1], []);
  }
  return m;
}

/** Validate a spec before anything runs. */
export function specProblem(s: Partial<LeanProjectSpec>): string | null {
  if (typeof s.repo !== 'string' || !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(s.repo)) return 'repo must be a https://github.com/owner/name URL';
  if (typeof s.commit !== 'string' || !/^[0-9a-f]{40}$/.test(s.commit)) return 'commit must be a full 40-character hash';
  if (typeof s.module !== 'string' || !NAME.test(s.module)) return 'module must be a Lean module name';
  if (!Array.isArray(s.theorems) || !s.theorems.length || s.theorems.some((t) => typeof t !== 'string' || !NAME.test(t))) return 'theorems must be Lean declaration names';
  if (!reviewed(s as LeanProjectSpec)) return 'this project and commit aren’t on the reviewed list (src/work/lean-project.ts), so it isn’t built';
  return null;
}

/**
 * Build the project and report each theorem's axioms, as Lean prints them. Cached per commit and theorem set,
 * so a computer that both works and verifies builds once.
 */
export async function checkLeanProject(s: LeanProjectSpec, home = process.env.CONSTELLATE_HOME ?? join(homedir(), '.constellate')): Promise<string> {
  const bad = specProblem(s); if (bad) throw new Error(bad);
  const lake = lakeBinary(); if (!lake) throw new Error('Lean isn’t installed on this computer (install elan to provide lake)');
  const root = join(home, 'lean-projects');
  const dir = join(root, `${s.repo.split('/').slice(-2).join('-')}-${s.commit.slice(0, 12)}`);
  const cacheFile = join(dir, '.constellate-axioms.json');
  const key = [...s.theorems].sort().join(',');
  try { const c = JSON.parse(readFileSync(cacheFile, 'utf8')) as Record<string, string>; if (c[key]) return c[key]; } catch { /* not built yet */ }
  const timeout = s.timeout_ms ?? 4 * 3600_000;
  mkdirSync(root, { recursive: true });
  if (!existsSync(join(dir, '.git'))) {
    const c = await run('git', ['clone', '--quiet', s.repo, dir], undefined, 30 * 60_000);
    if (c.code !== 0) throw new Error(`couldn’t clone ${s.repo}: ${c.out.slice(-300)}`);
  }
  const co = await run('git', ['checkout', '--quiet', '--detach', s.commit], dir, 5 * 60_000);
  const head = await run('git', ['rev-parse', 'HEAD'], dir, 60_000);
  if (co.code !== 0 || head.out.trim() !== s.commit) throw new Error(`couldn’t check out ${s.commit}`);
  await run(lake, ['exe', 'cache', 'get'], dir, 60 * 60_000); // Mathlib's prebuilt files; a full build works without them, slowly
  const b = await run(lake, ['build', s.module], dir, timeout);
  if (b.code !== 0) throw new Error(`lake build ${s.module} failed: ${b.out.slice(-600)}`);
  const probe = join(dir, '.constellate-axioms.lean');
  writeFileSync(probe, `import ${s.module}\n${s.theorems.map((t) => `#print axioms ${t}`).join('\n')}\n`);
  const p = await run(lake, ['env', 'lean', probe], dir, 60 * 60_000);
  const found = parseAxioms(p.out);
  const missing = s.theorems.filter((t) => !found.has(t) && ![...found.keys()].some((k) => k.endsWith(`.${t}`)));
  if (missing.length) throw new Error(`Lean didn’t report axioms for ${missing.join(', ')}: ${p.out.slice(-400)}`);
  const report = [`${s.repo} @ ${s.commit}`, ...[...found].map(([t, ax]) => `'${t}' depends on axioms: [${ax.join(', ')}]`)].join('\n');
  let cache: Record<string, string> = {}; try { cache = JSON.parse(readFileSync(cacheFile, 'utf8')); } catch { /* new */ }
  writeFileSync(cacheFile, JSON.stringify({ ...cache, [key]: report }));
  return report;
}

/** Each theorem rests only on the allowed axioms, and both reports say so. */
export function judge(s: LeanProjectSpec, mine: string, theirs: string) {
  const allowed = new Set(s.axioms ?? STANDARD_AXIOMS);
  const a = parseAxioms(mine), b = parseAxioms(theirs);
  const pick = (m: Map<string, string[]>, t: string) => m.get(t) ?? [...m].find(([k]) => k.endsWith(`.${t}`))?.[1];
  for (const t of s.theorems) {
    const ax = pick(a, t);
    if (!ax) return { ok: false, detail: `no axiom report for ${t}` };
    const extra = ax.filter((x) => !allowed.has(x));
    if (extra.length) return { ok: false, detail: `${t} rests on ${extra.join(', ')}${extra.includes('sorryAx') ? ' (an unfinished proof)' : ''}` };
    const other = pick(b, t);
    if (!other || other.join(',') !== ax.join(',')) return { ok: false, detail: `the report for ${t} doesn’t match this computer’s own build` };
  }
  return { ok: true, detail: `rebuilt at ${s.commit.slice(0, 12)}: ${s.theorems.join(', ')} rest only on ${[...allowed].join(', ')}` };
}

export const leanProjectVerifier: Verifier = {
  name: 'lean_project',
  machineOnly: true,
  shape: 'check {"repo", "commit", "module", "theorems": [..]} for a reviewed project (LEAN_PROJECTS); the work is a full Lean build, done by computers with Lean installed',
  available: () => !!lakeBinary(),
  work: async (spec) => checkLeanProject(spec as unknown as LeanProjectSpec),
  async check(spec, output) {
    const s = spec as unknown as LeanProjectSpec;
    const bad = specProblem(s); if (bad) return { ok: false, detail: bad };
    if (!lakeBinary()) return { ok: false, detail: 'Lean isn’t installed on this computer, so it can’t re-check this step' };
    try { return judge(s, await checkLeanProject(s), output); } catch (e) { return { ok: false, detail: (e as Error).message.slice(0, 400) }; }
  },
};
