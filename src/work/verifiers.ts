import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Machine checks for "definition of done". Only problems with checkable
 * progress enter the queue, so every problem names one of these.
 * Every node re-runs the check itself before accepting a checkpoint.
 */
export interface Verifier {
  readonly name: string;
  check(spec: Record<string, unknown>, output: string): Promise<{ ok: boolean; detail: string }>;
}

const lastToken = (s: string) => s.trim().split(/\s+/).pop() ?? '';

/** Exact answers with a known expected value. */
export const exactVerifier: Verifier = {
  name: 'exact',
  async check(spec, output) {
    const want = String(spec.expected ?? '');
    const got = lastToken(output);
    return got === want ? { ok: true, detail: 'exact match' } : { ok: false, detail: `expected ${want}, got ${got.slice(0, 40)}` };
  },
};

/** Recomputes a deterministic quantity (the toy problem used by the Phase 3 gate). */
export const sumSquaresModVerifier: Verifier = {
  name: 'sum_squares_mod',
  async check(spec, output) {
    const { from, to, mod } = spec as { from: number; to: number; mod: number };
    let s = 0n;
    for (let i = BigInt(from); i <= BigInt(to); i++) s = (s + i * i) % BigInt(mod);
    const got = lastToken(output);
    return got === s.toString() ? { ok: true, detail: 'recomputed' } : { ok: false, detail: `recomputed ${s}, got ${got}` };
  },
};

/**
 * Lean 4: the output is a proof file. Done means the local `lean` binary
 * accepts it and it contains no `sorry`/`admit`. Needs a Lean toolchain on
 * the verifying machine (not available in the build session).
 */
export const leanVerifier: Verifier = {
  name: 'lean',
  async check(spec, output) {
    if (/\bsorry\b|\badmit\b/.test(output)) return { ok: false, detail: 'proof contains sorry/admit' };
    const statement = String(spec.statement ?? '');
    if (statement && !output.includes(statement)) return { ok: false, detail: 'proof does not state the required theorem' };
    const dir = mkdtempSync(join(tmpdir(), 'constellate-lean-'));
    const file = join(dir, 'Proof.lean');
    writeFileSync(file, output);
    const bin = process.env.CONSTELLATE_LEAN ?? 'lean';
    return new Promise((res) => {
      const p = spawn(bin, [file], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (out += d));
      const timer = setTimeout(() => p.kill(), Number(spec.timeout_ms ?? 120_000));
      p.on('error', () => { clearTimeout(timer); res({ ok: false, detail: 'lean is not installed on this machine' }); });
      p.on('close', (code) => { clearTimeout(timer); res(code === 0 ? { ok: true, detail: 'lean accepted the proof' } : { ok: false, detail: out.slice(0, 400) }); });
    });
  },
};

export class VerifierRegistry {
  private m = new Map<string, Verifier>();
  constructor(vs: Verifier[] = [exactVerifier, sumSquaresModVerifier, leanVerifier]) { for (const v of vs) this.m.set(v.name, v); }
  register(v: Verifier) { this.m.set(v.name, v); }
  get(name: string) { return this.m.get(name); }
  names() { return [...this.m.keys()]; }
}
