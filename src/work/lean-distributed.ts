import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * Checking a huge Lean proof across many computers (docs/DISTRIBUTED_LEAN.md).
 *
 * Lean builds a project module by module, and a module needs only the compiled files (.olean) of what it imports.
 * So the import graph splits into slices: groups of modules that can be built once the slices they import from are
 * done. Each slice is a step. A slice counts once at least `quorum` independent computers built it and got the same
 * fingerprint for every output file; downstream slices then build on exactly those agreed files, so nobody repeats
 * the whole build and no single computer can slip in a bad file. The last step asks Lean which axioms the target
 * theorems rest on, also on several computers.
 *
 * This file is the part that needs no Lean: reading the import graph, cutting it into slices, and deciding agreement.
 */
export interface LeanModule { name: string; imports: string[]; /** Rough build cost (lines of source). */ cost: number }
export interface Slice { key: string; modules: string[]; after: string[]; cost: number; level: number }

/** Every `import` of a Lean file (header only: imports come before any other command). */
export function importsOf(source: string): string[] {
  const out: string[] = [];
  const text = source.replace(/\/-[\s\S]*?-\//g, ''); // block comments
  for (const raw of text.split('\n')) {
    const line = raw.replace(/--.*$/, '').trim();
    if (!line) continue;
    if (/^(prelude|module)\b/.test(line)) continue;
    const m = /^(?:public\s+|meta\s+)*import\s+(?:all\s+)?(.+)$/.exec(line);
    if (!m) break; // the header is over
    out.push(...m[1].split(/\s+/).filter(Boolean));
  }
  return out;
}

/** The project's own modules and their imports, read from the .lean files under `root` (names from paths). */
export function readProject(root: string): LeanModule[] {
  const mods: LeanModule[] = [];
  const walk = (dir: string) => {
    for (const f of readdirSync(dir)) {
      if (f.startsWith('.') || f === 'build' || f === 'lake-packages') continue;
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (f.endsWith('.lean') && f !== 'lakefile.lean') {
        const src = readFileSync(p, 'utf8');
        mods.push({ name: relative(root, p).slice(0, -5).split(sep).join('.'), imports: importsOf(src), cost: src.split('\n').length });
      }
    }
  };
  walk(root);
  return mods;
}

/**
 * Cut the graph into slices of at most `maxCost`. Modules go in dependency order (by level: one more than their
 * deepest import inside the project); a slice holds modules of one level, so its modules never wait for each other,
 * and it waits for the slices holding what they import. Imports from outside the project (Mathlib, Lean itself)
 * are dependencies every builder fetches the usual way. A cycle is an error, as it is for Lean.
 */
export function planSlices(mods: LeanModule[], opts: { maxCost?: number } = {}): Slice[] {
  const maxCost = opts.maxCost ?? 20_000;
  const byName = new Map(mods.map((m) => [m.name, m]));
  const level = new Map<string, number>();
  const visiting = new Set<string>();
  const lv = (n: string): number => {
    const known = level.get(n);
    if (known !== undefined) return known;
    if (visiting.has(n)) throw new Error(`import cycle through ${n}`);
    visiting.add(n);
    const deps = byName.get(n)!.imports.filter((i) => byName.has(i));
    const l = deps.length ? 1 + Math.max(...deps.map(lv)) : 0;
    visiting.delete(n);
    level.set(n, l);
    return l;
  };
  for (const m of mods) lv(m.name);
  const levels = new Map<number, LeanModule[]>();
  for (const m of mods) levels.set(level.get(m.name)!, [...(levels.get(level.get(m.name)!) ?? []), m]);
  const slices: Slice[] = [];
  const sliceOf = new Map<string, string>();
  for (const l of [...levels.keys()].sort((a, b) => a - b)) {
    const ms = levels.get(l)!.sort((a, b) => a.name.localeCompare(b.name));
    let cur: LeanModule[] = [], cost = 0;
    const flush = () => {
      if (!cur.length) return;
      const key = `L${l}-${slices.filter((s) => s.level === l).length + 1}`;
      const after = [...new Set(cur.flatMap((m) => m.imports.filter((i) => byName.has(i)).map((i) => sliceOf.get(i)!)))].sort();
      for (const m of cur) sliceOf.set(m.name, key);
      slices.push({ key, modules: cur.map((m) => m.name), after, cost, level: l });
      cur = []; cost = 0;
    };
    for (const m of ms) { if (cur.length && cost + m.cost > maxCost) flush(); cur.push(m); cost += m.cost; }
    flush();
  }
  return slices;
}

/** Longest chain of slices: the least wall-clock time however many computers join, in slice builds. */
export function criticalPath(slices: Slice[]): number {
  const depth = new Map<string, number>();
  for (const s of slices) depth.set(s.key, 1 + Math.max(0, ...s.after.map((a) => depth.get(a) ?? 0)));
  return Math.max(0, ...depth.values());
}

/** One computer's report for a slice: the fingerprint (sha256) of every output file it built. */
export interface SliceReport { slice: string; operator: string; toolchain: string; outputs: Record<string, string> }
export interface Agreement { status: 'agreed' | 'waiting' | 'disputed'; outputs?: Record<string, string>; builders: number; detail: string }

const canon = (o: Record<string, string>) => JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]));

/**
 * Whether a slice's outputs are agreed: at least `quorum` different operators, on the same toolchain, reported
 * exactly the same fingerprints. Different fingerprints are a dispute, shown and never resolved by vote: someone
 * has to find out why (a nondeterministic build, a bad computer, or a different toolchain).
 */
export function agreement(slice: Slice, reports: SliceReport[], quorum = 2): Agreement {
  const mine = reports.filter((r) => r.slice === slice.key);
  const firstPer = new Map<string, SliceReport>();
  for (const r of mine) if (!firstPer.has(r.operator)) firstPer.set(r.operator, r); // one vote per operator
  const valid = [...firstPer.values()].filter((r) => slice.modules.every((m) => /^[0-9a-f]{64}$/.test(r.outputs[m] ?? '')));
  const groups = new Map<string, SliceReport[]>();
  for (const r of valid) { const k = `${r.toolchain}|${canon(r.outputs)}`; groups.set(k, [...(groups.get(k) ?? []), r]); }
  const sameToolchain = new Map<string, number>();
  for (const k of groups.keys()) sameToolchain.set(k.split('|')[0], (sameToolchain.get(k.split('|')[0]) ?? 0) + 1);
  if ([...sameToolchain.values()].some((n) => n > 1)) return { status: 'disputed', builders: valid.length, detail: 'computers on the same toolchain built different files' };
  const best = [...groups.values()].sort((a, b) => b.length - a.length)[0] ?? [];
  if (best.length >= quorum) return { status: 'agreed', outputs: best[0].outputs, builders: best.length, detail: `${best.length} computers built identical files with ${best[0].toolchain}` };
  return { status: 'waiting', builders: valid.length, detail: `${valid.length} of ${quorum} independent builds` };
}

/** The slices as problem steps: each waits for the slices it imports from (ChunkSpec.after), then the axiom check. */
export function sliceSteps(spec: { repo: string; commit: string; theorems: string[]; target: string }, slices: Slice[]) {
  const steps = slices.map((s) => ({
    key: s.key, title: `Build ${s.modules.length} module${s.modules.length === 1 ? '' : 's'} (${s.cost.toLocaleString('en')} lines), level ${s.level}`,
    prompt: `Build these modules of ${spec.repo} at ${spec.commit} with the agreed files of the slices they import, and report the sha256 of each output: ${s.modules.slice(0, 40).join(', ')}${s.modules.length > 40 ? ', …' : ''}`,
    check: { repo: spec.repo, commit: spec.commit, modules: s.modules }, after: s.after, needs: { size: 'large' as const },
  }));
  steps.push({
    key: 'axioms', title: `Which axioms ${spec.theorems.join(', ')} rest on`,
    prompt: `With every slice agreed, ask Lean which axioms ${spec.theorems.join(', ')} depend on (#print axioms) after importing ${spec.target}.`,
    check: { repo: spec.repo, commit: spec.commit, modules: [spec.target], theorems: spec.theorems } as never,
    after: slices.filter((s) => !slices.some((o) => o.after.includes(s.key))).map((s) => s.key), needs: { size: 'large' as const },
  });
  return steps;
}
