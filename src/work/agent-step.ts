import type { Hub } from '../hub/hub.js';
import type { TaskResultBody } from './problems.js';
import { familyOf } from '../contributor/catalog.js';

/**
 * A connected agent (Claude Code, Cursor…) takes a step of a live problem, the same way a lent computer does
 * (src/work/worker.ts): it picks an open step, does the work with its own model, and submits the answer as a
 * signed task_result. A computer running a DIFFERENT model family then checks it, machine check plus its own
 * judgement, before it becomes a verified checkpoint. The agent never sees a step's check (an exact check
 * holds the answer), only how it will be checked; and it can't verify its own work.
 *
 * Only problems the constitution has cleared, only steps nobody has answered yet, and not steps the machine
 * itself does (like rebuilding a Lean proof).
 */
export interface OpenStep { problem: string; problem_title: string; realm: string; step: string; title: string; prompt: string; checked_by: string; done_means: string; progress: string }
export interface MyStep { problem: string; problem_title: string; step: string; status: 'waiting for a check' | 'verified' | 'rejected'; reason?: string; result: string; at: string }

/** The model family an answer counts as, so a different family checks it. */
export function agentFamily(model?: string, client?: string): string {
  const m = (model ?? '').trim();
  if (m) { const f = familyOf(m); if (f !== 'unknown') return f; }
  const c = (client ?? '').toLowerCase();
  if (c.includes('claude')) return 'claude';
  if (c.includes('codex') || c.includes('openai')) return 'openai';
  if (c.includes('gemini')) return 'gemini';
  return 'agent';
}

export async function openSteps(hub: Hub, opts: { problem?: string; limit?: number } = {}): Promise<OpenStep[]> {
  const out: OpenStep[] = [];
  const cons = hub.collective.constitution;
  const problems = opts.problem ? hub.problems.list().filter((p) => p.rec.id === opts.problem) : hub.problems.list();
  for (const p of problems) {
    if (cons.status(p.rec.id).state !== 'cleared') continue;
    const st = await hub.problems.state(p.rec.id);
    const verifier = hub.problems.verifiers.get(st.problem.definition_of_done.verifier);
    if (!verifier || verifier.work) continue; // the machine does these steps itself
    for (const c of st.chunks) {
      if (c.checkpoint || c.pending.length) continue;
      const chunk = st.problem.chunks.find((x) => x.key === c.key)!;
      out.push({
        problem: p.rec.id, problem_title: st.problem.title, realm: st.problem.realm, step: c.key, title: chunk.title,
        prompt: chunk.prompt.slice(0, 6000), checked_by: `${st.problem.definition_of_done.verifier} (by machine), then judged by a model from a different family`,
        done_means: st.problem.definition_of_done.description, progress: `${st.done}/${st.total} verified`,
      });
      if (out.length >= (opts.limit ?? 3)) return out;
      break; // one step per problem, so the list spans problems
    }
  }
  return out;
}

/** Submit an answer for an open step. Published as a signed result; checked later by a different model family. */
export async function submitStep(hub: Hub, a: { problem: string; step: string; answer: string; model?: string; client?: string }) {
  const cons = hub.collective.constitution;
  if (!hub.problems.get(a.problem)) throw new Error('unknown problem');
  if (cons.status(a.problem).state !== 'cleared') throw new Error('this problem isn’t cleared by the constitution check, so it isn’t open for work');
  const st = await hub.problems.state(a.problem);
  const c = st.chunks.find((x) => x.key === a.step);
  if (!c) throw new Error(`no step "${a.step}" in this problem`);
  if (c.checkpoint) throw new Error('this step is already verified');
  if (c.pending.length) throw new Error('someone has already answered this step and it’s waiting for a check; pick another with work_step');
  const verifier = hub.problems.verifiers.get(st.problem.definition_of_done.verifier);
  if (verifier?.work) throw new Error('the machine does this step itself; it isn’t open to agents');
  const answer = a.answer.trim();
  if (!answer) throw new Error('the answer is empty');
  const family = agentFamily(a.model, a.client);
  const model = (a.model?.trim() || a.client || 'agent').slice(0, 80);
  const body: TaskResultBody = { problem: a.problem, chunk: a.step, output: answer.slice(0, 20_000), model, family };
  const { record } = await hub.node.submit({ kind: 'task_result', context: { task: `${st.problem.title} / ${a.step}`, domain: [st.problem.realm], environment: model }, body: body as unknown as Record<string, unknown>, refs: [a.problem] }, { publish: true });
  // Tell lent computers the step is taken (advisory, like theirs).
  try { const chunk = st.problem.chunks.find((x) => x.key === a.step)!; await hub.board.claim(await hub.board.ensure(`[${a.problem.slice(0, 12)}] ${chunk.title}`, { problem: a.problem, chunk: a.step, size: chunk.needs.size }), hub.node.agentId); } catch { /* the board is a hint */ }
  return { result: record.id, family };
}

/** This computer's recent answers and how each went. */
export function mySteps(hub: Hub, limit = 8): MyStep[] {
  const me = hub.node.operatorId;
  return hub.node.store.ofKind('task_result').filter((s) => s.operatorId === me).sort((x, y) => y.rec.created.localeCompare(x.rec.created)).slice(0, limit).map((s) => {
    const b = s.rec.body as unknown as TaskResultBody;
    const title = (hub.problems.get(b.problem)?.rec.body as { title?: string } | undefined)?.title ?? '';
    const refs = hub.node.store.referencing(s.rec.id);
    const verified = refs.some((r) => r.rec.kind === 'checkpoint');
    const no = refs.find((r) => r.rec.kind === 'verification' && (r.rec.body as { ok?: boolean }).ok === false);
    return { problem: b.problem, problem_title: title, step: b.chunk, result: s.rec.id, at: s.rec.created, status: verified ? 'verified' : no ? 'rejected' : 'waiting for a check', ...(no && !verified ? { reason: String((no.rec.body as { reason?: string }).reason ?? '').slice(0, 300) } : {}) };
  });
}
