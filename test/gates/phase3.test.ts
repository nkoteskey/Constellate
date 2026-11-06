import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hub } from '../../src/hub/hub.js';
import { LocalSigner } from '../../src/core/identity.js';
import { RecordStore } from '../../src/store/records.js';
import { LocalArchive } from '../../src/store/archive.js';
import { MemoryNetwork } from '../../src/transport/bus.js';
import { Problems, CheckpointBody, TaskResultBody } from '../../src/work/problems.js';
import { MemoryBoard } from '../../src/work/board.js';
import { Worker, runSwarm } from '../../src/work/worker.js';
import { MockRunner, Budget } from '../../src/contributor/models.js';
import { decide, POLITE, pickLocalModel } from '../../src/contributor/device.js';
import { KeyVault } from '../../src/contributor/keyvault.js';
import { readFileSync } from 'node:fs';

/** GATE 3: a small problem runs start to finish across mixed models, survives a pause and resumes from its checkpoint. */
const MOD = 1_000_000_007;
const sumSq = (a: number, b: number) => { let s = 0n; for (let i = BigInt(a); i <= BigInt(b); i++) s = (s + i * i) % BigInt(MOD); return s.toString(); };
const solve = (prompt: string) => { const m = prompt.match(/from (\d+) to (\d+)/)!; return `The answer is ${sumSq(+m[1], +m[2])}`; };
const reviewer = (prompt: string) => (prompt.includes('You are verifying') ? 'YES, recomputed.' : solve(prompt));

const chunks = Array.from({ length: 6 }, (_, i) => ({
  key: `c${i + 1}`, title: `Block ${i + 1}`,
  prompt: `Compute the sum of i^2 for i from ${i * 5000 + 1} to ${(i + 1) * 5000}, modulo ${MOD}. End with the number.`,
  check: { from: i * 5000 + 1, to: (i + 1) * 5000, mod: MOD },
  needs: { size: (i === 5 ? 'large' : 'any') as 'large' | 'any' },
}));

describe('GATE 3 — work engine', () => {
  const dirs = { A: mkdtempSync(join(tmpdir(), 'cA-')), B: mkdtempSync(join(tmpdir(), 'cB-')) };
  const keys = { A: LocalSigner.generate(), B: LocalSigner.generate(), C: LocalSigner.generate(), D: LocalSigner.generate() };
  const archive = new LocalArchive();
  const board = new MemoryBoard();

  it('runs across mixed models, rejects a wrong answer, pauses, and resumes from checkpoints', async () => {
    // ── Session 1 ────────────────────────────────────────────────
    let net = new MemoryNetwork();
    const mk = (k: LocalSigner, dir?: string) => new Hub({ signer: k, bus: net.bus(), archive, store: new RecordStore(dir), preview: false });
    const proposer = mk(keys.C);
    const A = mk(keys.A, dirs.A), B = mk(keys.B, dirs.B);
    const { record: problem } = await new Problems(proposer).propose({
      title: 'Sum of squares to 30,000', hook: 'A warm-up the whole swarm can check', goal: 'Sum of i^2 for i ≤ 30000 mod p, in six checkable blocks',
      realm: 'maths_physics', definition_of_done: { verifier: 'sum_squares_mod', description: 'Each block recomputed exactly' }, chunks,
    }, { publish: true });
    await proposer.live.checkpoint();

    // llama is a small model that gets its first answer wrong.
    const llama = new MockRunner('ollama:llama3.2:3b', 'llama', 'small', (p, n) => (p.includes('You are verifying') ? 'YES' : n === 0 ? 'The answer is 42' : solve(p)));
    const qwen = new MockRunner('mlx:qwen3-14b', 'qwen', 'small', reviewer);
    const wA = new Worker(A, llama, new Problems(A), board);
    const wB = new Worker(B, qwen, new Problems(B), board);
    const log1 = await runSwarm(problem.id, [wA, wB], { until: async () => (await new Problems(A).state(problem.id)).done >= 3 });
    expect(log1.some((l) => l.outcome === 'rejected')).toBe(true); // wrong answer caught by a different family
    const before = await new Problems(A).state(problem.id);
    expect(before.done).toBeGreaterThanOrEqual(3);
    expect(before.done).toBeLessThan(6);
    const doneBefore = before.chunks.filter((c) => c.checkpoint).map((c) => c.key);
    await A.live.checkpoint(); await B.live.checkpoint();
    wA.stop(); wB.stop();
    await A.close(); await B.close(); await proposer.close();

    // ── Session 2: A restarts from disk, B is gone, D joins fresh with a large Claude-family model ──
    net = new MemoryNetwork();
    const A2 = mk(keys.A, dirs.A);
    const D = mk(keys.D);
    for (const id of [keys.A.agentId, keys.B.agentId, keys.C.agentId]) await D.live.catchUp(id);
    const st = await new Problems(D).state(problem.id);
    expect(st.done).toBe(before.done); // a newcomer computes the same progress from signed records alone
    const claude = new MockRunner('anthropic:claude-opus-5-5', 'claude', 'large', reviewer, 2);
    const budget = new Budget(1000);
    const wA2 = new Worker(A2, new MockRunner('ollama:llama3.2:3b', 'llama', 'small', (p) => (p.includes('You are verifying') ? 'YES' : solve(p))), new Problems(A2), board);
    const wD = new Worker(D, claude, new Problems(D), board, { budget });
    // D needs A's session-1 records too; A2 already has them on disk, and gossip carries new ones.
    await runSwarm(problem.id, [wA2, wD], { maxSteps: 100 });

    const final = await new Problems(D).state(problem.id);
    expect(final.done).toBe(6);
    expect((await new Problems(A2).state(problem.id)).done).toBe(6);
    for (const c of final.chunks) {
      const cp = c.checkpoint!.rec.body as unknown as CheckpointBody;
      const res = D.node.store.get(cp.result)!.rec.body as unknown as TaskResultBody;
      expect(res.family).not.toBe(cp.verifier_family);
    }
    // nothing checkpointed before the pause was redone
    const results = D.node.store.referencing(problem.id, 'task_result').map((r) => r.rec.body as unknown as TaskResultBody);
    for (const k of doneBefore) expect(results.filter((r) => r.chunk === k).length).toBeLessThanOrEqual(2);
    expect(results.filter((r) => r.chunk === 'c6').every((r) => r.family === 'claude')).toBe(true); // the large-only block
    expect(budget.report().spent_cents).toBeGreaterThan(0);
  }, 120_000);
});

describe('contributor app', () => {
  it('is polite by default and says why it is paused', () => {
    expect(decide(POLITE, { onAC: false, batteryPct: 90 }, 0).message).toBe('Paused: plug in to keep contributing.');
    expect(decide(POLITE, { onAC: true, batteryPct: 90 }, 0.9).state).toBe('waiting');
    expect(decide(POLITE, { onAC: true, batteryPct: 90 }, 0.1).state).toBe('contributing');
    expect(decide({ ...POLITE, hours: [22, 7] }, { onAC: true, batteryPct: null }, 0, 12).state).toBe('waiting');
  });
  it('picks a model that fits the machine', () => {
    expect(pickLocalModel({ platform: 'darwin', arch: 'arm64', cpu: 'Apple M3', cores: 8, memGB: 16, appleSilicon: true }).model).toBe('qwen3:14b');
    expect(pickLocalModel({ platform: 'linux', arch: 'x64', cpu: 'x', cores: 8, memGB: 32, appleSilicon: false }).model).toBe('gpt-oss:20b'); // fast on CPU: mixture of experts
    expect(pickLocalModel({ platform: 'linux', arch: 'x64', cpu: 'x', cores: 2, memGB: 4, appleSilicon: false }).runtime).toBe('none');
  });
  it('stops at the spending cap', async () => {
    const b = new Budget(3);
    const paid = new MockRunner('x', 'claude', 'large', () => 'ok', 2);
    b.charge(paid);
    expect(b.canAfford(paid)).toBe(false);
    expect(() => b.charge(paid)).toThrow(/cap/);
  });
  it('keeps API keys encrypted on the device', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kv-'));
    const v = new KeyVault(join(dir, 'keys.json'));
    v.set('anthropic', 'sk-ant-api03-secret-value');
    expect(readFileSync(join(dir, 'keys.json'), 'utf8')).not.toContain('secret-value');
    expect(new KeyVault(join(dir, 'keys.json')).get('anthropic')).toBe('sk-ant-api03-secret-value');
  });
});
