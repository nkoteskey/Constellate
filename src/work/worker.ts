import { Hub } from '../hub/hub.js';
import { ModelRunner, Budget } from '../contributor/models.js';
import { decide, Policy, Power, Status } from '../contributor/device.js';
import { Board } from './board.js';
import { CheckpointBody, Problems, TaskResultBody } from './problems.js';
import type { Constitution } from '../collective/constitution.js';

export interface WorkerOptions {
  policy?: Policy;
  power?: () => Power;
  budget?: Budget;
  /** Treat the machine as idle regardless of load (tests, dedicated boxes). */
  ignoreLoad?: boolean;
  /** When set, work only on problems the constitution has cleared, and check every result before it becomes a checkpoint. */
  constitution?: Constitution;
}

export type StepOutcome = 'verified' | 'rejected' | 'worked' | 'idle' | 'paused';

/**
 * A contributor: one model on one machine, listening to the Board.
 * Each step it prefers verification (cheap, unblocks others) and only then
 * claims new work that fits its model size. Results, verifications and
 * checkpoints are signed records; the Board is only a coordination hint.
 */
export class Worker {
  status: Status = { state: 'waiting', message: 'Starting.' };
  private stopped = false;

  constructor(readonly hub: Hub, readonly runner: ModelRunner, readonly problems: Problems, readonly board: Board, private readonly opts: WorkerOptions = {}) {}

  private allowed(): boolean {
    const p = this.opts.policy;
    if (!p) { this.status = { state: 'contributing', message: 'Contributing.' }; return true; }
    this.status = decide(p, this.opts.power?.() ?? { onAC: null, batteryPct: null }, this.opts.ignoreLoad ? 0 : undefined);
    return this.status.state === 'contributing';
  }

  private charge(): boolean {
    if (!this.opts.budget) return true;
    if (!this.opts.budget.canAfford(this.runner)) { this.status = { state: 'paused', message: 'Paused: spending cap reached.' }; return false; }
    this.opts.budget.charge(this.runner);
    return true;
  }

  async step(problemId: string): Promise<StepOutcome> {
    if (this.stopped || !this.allowed()) return 'paused';
    const cons = this.opts.constitution;
    if (cons && cons.status(problemId).state !== 'cleared') return 'idle';
    const st = await this.problems.state(problemId);
    const verifier = this.problems.verifiers.get(st.problem.definition_of_done.verifier)!;
    const me = this.hub.node.operatorId;

    // 1. Verify someone else's result with a different model family.
    for (const c of st.chunks) {
      for (const r of c.pending) {
        const rb = r.rec.body as unknown as TaskResultBody;
        if (rb.family === this.runner.family || r.operatorId === me) continue;
        if (verifier.available && !verifier.available()) continue; // e.g. no Lean here: leave it for a computer that has it
        if (!verifier.machineOnly && !this.charge()) return 'paused';
        const chunk = st.problem.chunks.find((x) => x.key === c.key)!;
        const machine = await verifier.check(chunk.check, rb.output);
        const opinion = verifier.machineOnly ? (machine.ok ? 'YES' : 'NO') : machine.ok
          ? await this.runner.run(`You are verifying another model's answer.\nTask: ${chunk.prompt}\nAnswer: ${rb.output}\nReply YES if the answer is correct, otherwise NO and why.`, { maxTokens: 512 })
          : 'NO';
        const agrees = machine.ok && /^\s*yes\b/i.test(opinion);
        const ctx = { task: `verify ${st.problem.title} / ${c.key}`, domain: [st.problem.realm], environment: this.runner.id };
        if (agrees && cons) {
          const cc = await cons.checkCheckpoint(st.problem, rb);
          if (cc.ok && cc.needs_human) {
            // Review-only (e.g. every life-sciences checkpoint): hold this exact result until a human clears it.
            const asked = this.hub.node.store.referencing(r.rec.id, 'constitution_check').length > 0;
            if (!asked) { await cons.record(r.rec.id, 'checkpoint', problemId, cc); return 'idle'; }
            if (cons.status(problemId).state !== 'cleared') return 'idle';
          } else if (!cc.ok) {
            await cons.record(r.rec.id, 'checkpoint', problemId, cc); // pauses the problem for human review
            // The flagged result itself is never accepted; after review the chunk is redone.
            await this.hub.node.submit({ kind: 'verification', context: { task: `verify ${st.problem.title} / ${c.key}`, domain: [st.problem.realm], environment: this.runner.id }, body: { problem: problemId, chunk: c.key, result: r.rec.id, ok: false, reason: `constitution: ${cc.findings.map((f) => f.rule).join(', ')}`, verifier_family: this.runner.family }, refs: [problemId, r.rec.id] }, { publish: true });
            return 'rejected';
          }
        }
        if (agrees) {
          const body: CheckpointBody = { problem: problemId, chunk: c.key, seq: st.done + 1, result: r.rec.id, verifier_model: this.runner.id, verifier_family: this.runner.family, machine_check: machine.detail };
          await this.hub.node.submit({ kind: 'checkpoint', context: ctx, body: body as unknown as Record<string, unknown>, refs: [problemId, r.rec.id] }, { publish: true });
          const task = (await this.board.list()).find((t) => t.tags.problem === problemId && t.tags.chunk === c.key);
          if (task) await this.board.complete(task.id, this.hub.node.agentId);
          return 'verified';
        }
        await this.hub.node.submit({ kind: 'verification', context: ctx, body: { problem: problemId, chunk: c.key, result: r.rec.id, ok: false, reason: machine.ok ? opinion.slice(0, 300) : machine.detail, verifier_family: this.runner.family }, refs: [problemId, r.rec.id] }, { publish: true });
        return 'rejected';
      }
    }

    // 2. Claim open work that fits this model.
    for (const c of st.chunks) {
      if (c.checkpoint || c.pending.length) continue;
      const chunk = st.problem.chunks.find((x) => x.key === c.key)!;
      // Machine work (e.g. rebuilding a Lean proof) runs on computers that can do it, whatever their model size.
      if (verifier.work) { if (verifier.available && !verifier.available()) continue; }
      else if (chunk.needs.size !== 'any' && chunk.needs.size !== this.runner.size) continue;
      const taskId = await this.board.ensure(`[${problemId.slice(0, 12)}] ${chunk.title}`, { problem: problemId, chunk: c.key, size: chunk.needs.size });
      if (!verifier.work && !this.charge()) return 'paused';
      await this.board.claim(taskId, this.hub.node.agentId);
      let output: string, model = this.runner.id, family = this.runner.family;
      if (verifier.work) {
        try { output = await verifier.work(chunk.check); } catch (e) { output = `could not complete: ${(e as Error).message.slice(0, 2000)}`; }
        model = 'lean-kernel (lake build)'; family = 'machine';
      } else output = await this.runner.run(chunk.prompt);
      const body: TaskResultBody = { problem: problemId, chunk: c.key, output: output.slice(0, 20_000), model, family };
      await this.hub.node.submit({ kind: 'task_result', context: { task: `${st.problem.title} / ${c.key}`, domain: [st.problem.realm], environment: model }, body: body as unknown as Record<string, unknown>, refs: [problemId] }, { publish: true });
      return 'worked';
    }
    return 'idle';
  }

  stop() { this.stopped = true; this.status = { state: 'paused', message: 'Paused by you.' }; }
}

/** Drive a set of workers round-robin until the problem is done or `maxSteps` pass. */
export async function runSwarm(problemId: string, workers: Worker[], opts: { maxSteps?: number; until?: () => Promise<boolean> | boolean } = {}) {
  const log: { worker: string; outcome: StepOutcome }[] = [];
  for (let i = 0; i < (opts.maxSteps ?? 200); i++) {
    if (opts.until && (await opts.until())) break;
    const w = workers[i % workers.length];
    log.push({ worker: w.runner.id, outcome: await w.step(problemId) });
    const st = await w.problems.state(problemId);
    if (st.done === st.total) break;
  }
  return log;
}
