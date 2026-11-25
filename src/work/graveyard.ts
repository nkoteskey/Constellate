import type { Hub } from '../hub/hub.js';
import type { StoredRecord } from '../store/records.js';
import type { ProblemBody, TaskResultBody } from './problems.js';

/**
 * In memoriam: what was tried on a problem and didn't work, kept on the problem's page so nobody tries it again
 * blind (docs/OPEN_PROBLEMS.md, "Dead ends and known obstacles").
 *
 * - **Dead ends**: an agent reports an approach it showed can't work (work_step with `dead_end`). Signed, public,
 *   tied to the problem.
 * - **Rejected answers**: a different model family's check said no, with its reason.
 * - **Overturned results**: an auditor showed a verified result doesn't hold.
 * - **Struck ranges**: a search report whose spot check failed.
 *
 * A refutation is worth as much as a checked step: a dead end another operator confirmed, and an overturn another
 * operator confirmed, earn the same credit as a verified result (Collective.refuted). Unconfirmed, they're listed
 * and earn nothing yet, like any unchecked answer.
 *
 * Confirmed dead ends become the problem's known obstacles, with those the problem was posted with, and every
 * step prompt handed to an agent carries them.
 */
export type GraveKind = 'dead_end' | 'rejected' | 'overturned' | 'struck';
export interface Grave { kind: GraveKind; id: string; step?: string; what: string; why: string; by: string; at: string; confirmed_by: number; credited: boolean }
export interface Obstacle { says: string; source?: string; from: 'posted' | 'dead_end'; id?: string }

const clip = (s: unknown, n: number) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/** Other operators who confirmed a record (not its own operator). */
function confirmers(hub: Hub, r: StoredRecord): number {
  return new Set(hub.node.store.referencing(r.rec.id, 'confirmation').filter((c) => c.operatorId !== r.operatorId).map((c) => c.operatorId)).size;
}

export function isDeadEnd(r: StoredRecord, problem?: string): boolean {
  const b = r.rec.body as { problem?: string };
  return r.rec.kind === 'failure' && !!b.problem && (!problem || b.problem === problem) && r.rec.refs.includes(b.problem);
}

export function graveyard(hub: Hub, problem: string): Grave[] {
  const store = hub.node.store, out: Grave[] = [];
  for (const r of store.referencing(problem)) {
    if (isDeadEnd(r, problem)) {
      const b = r.rec.body as { approach: string; error_summary: string; step?: string };
      const n = confirmers(hub, r);
      out.push({ kind: 'dead_end', id: r.rec.id, ...(b.step ? { step: b.step } : {}), what: clip(b.approach, 300), why: clip(b.error_summary, 400), by: r.operatorId, at: r.rec.created, confirmed_by: n, credited: n > 0 });
    } else if (r.rec.kind === 'verification' && (r.rec.body as { ok?: boolean }).ok === false) {
      const b = r.rec.body as { chunk: string; result: string; reason?: string };
      const res = store.get(b.result);
      out.push({ kind: 'rejected', id: r.rec.id, step: b.chunk, what: clip(res ? (res.rec.body as unknown as TaskResultBody).output : 'an answer', 200), why: clip(b.reason, 300), by: res?.operatorId ?? '', at: r.rec.created, confirmed_by: 0, credited: false });
    } else if (r.rec.kind === 'contradiction' && (r.rec.body as { follow_up?: string }).follow_up === 'audit') {
      const n = confirmers(hub, r);
      out.push({ kind: 'overturned', id: r.rec.id, what: clip(r.rec.context.task, 200), why: clip((r.rec.body as { reason?: string }).reason, 400), by: r.operatorId, at: r.rec.created, confirmed_by: n, credited: n > 0 });
    } else if ((r.rec.kind as string) === 'range_report' && hub.ranges?.standing(r) === 'struck') {
      const b = r.rec.body as { chunk?: string; from?: number; to?: number };
      out.push({ kind: 'struck', id: r.rec.id, ...(b.chunk ? { step: b.chunk } : {}), what: `a search of ${b.from}–${b.to} reporting nothing there`, why: 'a spot check on another computer found it wrong', by: r.operatorId, at: r.rec.created, confirmed_by: 0, credited: false });
    }
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

/** What's known not to work: posted with the problem, plus dead ends someone else confirmed. */
export function obstacles(hub: Hub, problem: string): Obstacle[] {
  const p = hub.problems.get(problem);
  const posted = ((p?.rec.body as unknown as ProblemBody | undefined)?.obstacles ?? []).map((o) => ({ says: o.says, ...(o.source ? { source: o.source } : {}), from: 'posted' as const }));
  const found = graveyard(hub, problem).filter((g) => g.kind === 'dead_end' && g.credited).map((g) => ({ says: `${g.what}: ${g.why}`.slice(0, 400), from: 'dead_end' as const, id: g.id }));
  return [...posted, ...found];
}

/** Report a dead end on a problem: an approach that can't work, and why. */
export async function reportDeadEnd(hub: Hub, a: { problem: string; step?: string; approach: string; why: string; model?: string }) {
  const p = hub.problems.get(a.problem);
  if (!p) throw new Error('unknown problem');
  const body = p.rec.body as unknown as ProblemBody;
  if (a.step && !body.chunks.some((c) => c.key === a.step)) throw new Error(`no step "${a.step}" in this problem`);
  const approach = clip(a.approach, 600), why = clip(a.why, 600);
  if (approach.length < 8 || why.length < 20) throw new Error('say what the approach was, and why it can’t work (a sentence or two each)');
  const { record } = await hub.node.submit({
    kind: 'failure', refs: [a.problem],
    context: { task: `${body.title}${a.step ? ` / ${a.step}` : ''}`, domain: [body.realm], environment: clip(a.model ?? 'agent', 80) },
    body: { approach, outcome: 'wrong_result', error_summary: why, confidence: 0.6, problem: a.problem, ...(a.step ? { step: a.step } : {}) },
  }, { publish: true });
  return { reported: record.id };
}
