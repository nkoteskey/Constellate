import { RecordStore, StoredRecord } from '../store/records.js';
import { CheckpointBody } from '../work/problems.js';

/**
 * Attribution lineage: every result links back to the records, skills,
 * compute and people that produced it, so credit flows back fairly.
 * Shares are expressed per AGENT (who gets paid) and grouped by operator in views.
 */
export interface Contribution { agent: string; operator: string; role: string; record: string; share: number }

const MAX_DEPTH = 4;

/** Split one unit of credit for a record across its lineage. */
export function lineage(store: RecordStore, recordId: string): Contribution[] {
  const out: Contribution[] = [];
  const add = (s: StoredRecord, role: string, share: number) => out.push({ agent: s.rec.agent_id, operator: s.operatorId, role, record: s.rec.id, share });

  const walk = (id: string, weight: number, depth: number, role: string) => {
    const s = store.get(id);
    if (!s || weight < 1e-4) return;
    if (s.rec.kind === 'checkpoint') {
      // Checkpoint: 70% to whoever computed the result, 30% to the independent verifier.
      const b = s.rec.body as unknown as CheckpointBody;
      add(s, 'verification', weight * 0.3);
      walk(b.result, weight * 0.7, depth + 1, 'compute');
      return;
    }
    const upstream = depth < MAX_DEPTH ? s.rec.refs.filter((r) => { const k = store.get(r)?.rec.kind; return k && !['problem', 'review_request'].includes(k); }) : [];
    const skillRuns = store.referencing(id, 'skill_run').filter((r) => (r.rec.body as { used_in?: string }).used_in === id);
    const upstreamShare = upstream.length || skillRuns.length ? 0.3 : 0;
    add(s, role, weight * (1 - upstreamShare));
    const parts = [...upstream, ...skillRuns.map((r) => (r.rec.body as { skill: string }).skill)];
    for (const p of parts) walk(p, (weight * upstreamShare) / parts.length, depth + 1, store.get(p)?.rec.kind === 'skill' ? 'skill' : 'upstream');
  };
  walk(recordId, 1, 0, 'author');
  return out;
}

/** Turn an amount into integer payouts per agent; rounding dust goes to the largest share. */
export function splitAmount(contribs: Contribution[], amount: number): Map<string, number> {
  const per = new Map<string, number>();
  for (const c of contribs) per.set(c.agent, (per.get(c.agent) ?? 0) + c.share);
  const out = new Map<string, number>();
  let paid = 0;
  for (const [a, s] of per) { const v = Math.floor(amount * s); out.set(a, v); paid += v; }
  const top = [...per.entries()].sort((x, y) => y[1] - x[1])[0];
  if (top) out.set(top[0], (out.get(top[0]) ?? 0) + (amount - paid));
  return out;
}
