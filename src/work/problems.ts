import { z } from 'zod';
import { Hub } from '../hub/hub.js';
import { StoredRecord } from '../store/records.js';
import { VerifierRegistry } from './verifiers.js';

export const ChunkSpec = z.object({
  key: z.string().max(64),
  title: z.string().max(200),
  prompt: z.string().max(8000),
  check: z.record(z.unknown()),
  needs: z.object({ size: z.enum(['small', 'large', 'any']).default('any') }).default({ size: 'any' }),
});
export type ChunkSpec = z.infer<typeof ChunkSpec>;

export const REALMS = ['maths_physics', 'life_sciences', 'planet_energy', 'philosophy_ethics', 'art_creativity', 'software', 'knowledge'] as const;

export const ProblemBody = z.object({
  title: z.string().max(200),
  hook: z.string().max(140).default(''),
  goal: z.string().max(2000),
  realm: z.enum(REALMS),
  definition_of_done: z.object({ verifier: z.string(), description: z.string().max(1000) }),
  chunks: z.array(ChunkSpec).min(1).max(500),
});
export type ProblemBody = z.infer<typeof ProblemBody>;

export interface TaskResultBody { problem: string; chunk: string; output: string; model: string; family: string }
export interface CheckpointBody { problem: string; chunk: string; seq: number; result: string; verifier_model: string; verifier_family: string; machine_check: string }

export interface ChunkState {
  key: string;
  checkpoint?: StoredRecord;
  pending: StoredRecord[]; // results awaiting verification
  rejected: string[];
}

/**
 * Problem state is derived purely from signed records, so any node (or a
 * restarted one, or a newcomer) computes the same progress and work resumes
 * from the last checkpoint with nothing lost.
 */
export class Problems {
  private checked = new Map<string, boolean>(); // checkpoint id -> re-verified locally
  constructor(private readonly hub: Hub, readonly verifiers = new VerifierRegistry()) {}

  async propose(body: z.input<typeof ProblemBody>, opts: { publish?: boolean } = {}) {
    const b = ProblemBody.parse(body);
    if (!this.verifiers.get(b.definition_of_done.verifier)) throw new Error(`unknown verifier "${b.definition_of_done.verifier}": only problems with checkable progress enter the queue`);
    return this.hub.node.submit({ kind: 'problem', context: { task: b.title, domain: [b.realm], environment: '' }, body: b }, opts);
  }

  list() { return this.hub.node.store.ofKind('problem'); }
  get(id: string) { const s = this.hub.node.store.get(id); return s?.rec.kind === 'problem' ? s : undefined; }
  body(id: string) { return this.get(id)!.rec.body as unknown as ProblemBody; }

  /** Re-run the machine check locally before believing any checkpoint (distrust by default). */
  async validCheckpoint(cp: StoredRecord, problem: ProblemBody): Promise<boolean> {
    if (this.checked.has(cp.rec.id)) return this.checked.get(cp.rec.id)!;
    const b = cp.rec.body as unknown as CheckpointBody;
    const res = this.hub.node.store.get(b.result);
    let ok = false;
    if (res && res.rec.kind === 'task_result') {
      const rb = res.rec.body as unknown as TaskResultBody;
      const chunk = problem.chunks.find((c) => c.key === b.chunk);
      const verifier = this.verifiers.get(problem.definition_of_done.verifier);
      ok = !!chunk && !!verifier && rb.chunk === b.chunk && rb.problem === b.problem
        && rb.family !== b.verifier_family // checked by a model that thinks differently
        && res.operatorId !== cp.operatorId // and by someone else
        && (await verifier.check(chunk.check, rb.output)).ok;
    }
    this.checked.set(cp.rec.id, ok);
    return ok;
  }

  async state(problemId: string): Promise<{ problem: ProblemBody; chunks: ChunkState[]; done: number; total: number }> {
    const problem = this.body(problemId);
    const store = this.hub.node.store;
    const results = store.referencing(problemId, 'task_result');
    const cps = store.referencing(problemId, 'checkpoint').sort((a, b) => Date.parse(a.rec.created) - Date.parse(b.rec.created) || a.rec.id.localeCompare(b.rec.id));
    const rejections = store.referencing(problemId, 'verification');
    const chunks: ChunkState[] = [];
    for (const c of problem.chunks) {
      let checkpoint: StoredRecord | undefined;
      for (const cp of cps) if ((cp.rec.body as unknown as CheckpointBody).chunk === c.key && (await this.validCheckpoint(cp, problem))) { checkpoint = cp; break; }
      const rejected = rejections.filter((r) => (r.rec.body as { chunk: string }).chunk === c.key).map((r) => (r.rec.body as { result: string }).result);
      const pending = checkpoint ? [] : results.filter((r) => (r.rec.body as unknown as TaskResultBody).chunk === c.key && !rejected.includes(r.rec.id));
      chunks.push({ key: c.key, checkpoint, pending, rejected });
    }
    return { problem, chunks, done: chunks.filter((c) => c.checkpoint).length, total: chunks.length };
  }

  /** Small summary for tools and the problem viewer. */
  async summary(problemId: string) {
    const s = await this.state(problemId);
    const contributors = new Set<string>();
    for (const r of this.hub.node.store.referencing(problemId)) contributors.add(r.operatorId);
    return {
      id: problemId, title: s.problem.title, hook: s.problem.hook, realm: s.problem.realm, goal: s.problem.goal,
      definition_of_done: s.problem.definition_of_done,
      progress: { done: s.done, total: s.total },
      checkpoints: s.chunks.filter((c) => c.checkpoint).map((c) => ({ chunk: c.key, id: c.checkpoint!.rec.id, at: c.checkpoint!.rec.created })),
      open_calls: s.chunks.filter((c) => !c.checkpoint).map((c) => ({ chunk: c.key, waiting_for: c.pending.length ? 'verification by a different model family' : 'a worker' })),
      contributors: contributors.size,
    };
  }
}
