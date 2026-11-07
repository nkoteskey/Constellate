import { z } from 'zod';
import { Hub } from '../hub/hub.js';
import { Constitution } from './constitution.js';
import { CheckpointBody, ProblemBody, TaskResultBody } from '../work/problems.js';

const HOURS_PER_RESULT = 0.25;     // credit for a verified task result, unless the chunk says otherwise
const HOURS_PER_VERIFICATION = 0.1;

/**
 * Collective problem solving: propose with a definition of done, pledge
 * compute, vote. Votes are weighted by compute an operator has pledged AND
 * actually delivered (verified work), tied to operator identity, so fake
 * agents and empty pledges cannot steer the queue. Compute then splits across
 * the top problems in proportion to their votes.
 */
export class Collective {
  readonly constitution: Constitution;
  private assigned = new Map<string, number>();

  constructor(private readonly hub: Hub, constitution?: Constitution) {
    this.constitution = constitution ?? new Constitution(hub);
  }

  async propose(body: z.input<typeof ProblemBody> & { license?: string }) {
    const parsed = ProblemBody.parse(body);
    const check = await this.constitution.checkProposal({ ...parsed, license: body.license ?? 'CC-BY-4.0' });
    if (!check.ok) return { problem: null, check }; // blocked proposals are never broadcast
    const { record } = await this.hub.problems.propose(parsed, { publish: true });
    await this.constitution.record(record.id, 'start', record.id, check);
    return { problem: record, check };
  }

  pledge(hoursPerWeek: number) {
    return this.hub.node.submit({ kind: 'pledge', context: { task: 'compute pledge', domain: ['compute'], environment: '' }, body: { hours_per_week: Math.max(0, Math.min(168 * 64, hoursPerWeek)) } }, { publish: true });
  }

  vote(problemId: string) {
    if (!this.hub.problems.get(problemId)) throw new Error(`unknown problem ${problemId}`);
    return this.hub.node.submit({ kind: 'vote', context: { task: 'vote', domain: ['collective'], environment: '' }, body: { problem: problemId, support: true }, refs: [problemId] }, { publish: true });
  }

  pledged(op: string): number {
    const ps = this.hub.node.store.ofKind('pledge').filter((s) => s.operatorId === op).sort((a, b) => Date.parse(b.rec.created) - Date.parse(a.rec.created));
    return ps.length ? (ps[0].rec.body as { hours_per_week: number }).hours_per_week : 0;
  }

  /** Verified compute an operator has delivered, in hours. */
  delivered(op: string): number {
    let h = 0;
    for (const cp of this.hub.node.store.ofKind('checkpoint')) {
      const b = cp.rec.body as unknown as CheckpointBody;
      const res = this.hub.node.store.get(b.result);
      if (cp.operatorId === op) h += HOURS_PER_VERIFICATION;
      if (res?.operatorId === op) {
        const prob = this.hub.problems.get(b.problem);
        const chunk = prob && (prob.rec.body as unknown as ProblemBody).chunks.find((c) => c.key === (res.rec.body as unknown as TaskResultBody).chunk);
        h += Number((chunk?.check as { cost_hours?: number } | undefined)?.cost_hours ?? HOURS_PER_RESULT);
      }
    }
    return h;
  }

  voteWeight(op: string): number {
    const compute = Math.min(this.pledged(op), this.delivered(op));
    return Math.sqrt(compute) + 0.5 * this.hub.reputation.reputation(op);
  }

  /** Who currently supports this: each person's latest vote counts, and a vote with support:false withdraws theirs. */
  supporters(problemId: string): string[] {
    const latest = new Map<string, { at: string; support: boolean }>();
    for (const v of this.hub.node.store.referencing(problemId, 'vote')) {
      const p = latest.get(v.operatorId);
      if (!p || v.rec.created >= p.at) latest.set(v.operatorId, { at: v.rec.created, support: (v.rec.body as { support?: boolean }).support !== false });
    }
    return [...latest].filter(([, x]) => x.support).map(([op]) => op);
  }

  tally(problemId: string) {
    const latest = new Map<string, number>();
    for (const op of this.supporters(problemId)) latest.set(op, this.voteWeight(op));
    let w = 0; for (const x of latest.values()) w += x;
    return { voters: latest.size, weight: Math.round(w * 1000) / 1000 };
  }

  /** The queue: cleared, unfinished problems by vote weight, top `k` sharing compute in proportion to votes. */
  async queue(k = 3) {
    const rows = [];
    for (const p of this.hub.problems.list()) {
      const st = await this.hub.problems.state(p.rec.id);
      const c = this.constitution.status(p.rec.id);
      rows.push({ id: p.rec.id, title: st.problem.title, realm: st.problem.realm, progress: { done: st.done, total: st.total }, constitution: c, votes: this.tally(p.rec.id) });
    }
    const eligible = rows.filter((r) => r.constitution.state === 'cleared' && r.progress.done < r.progress.total && r.votes.weight > 0).sort((a, b) => b.votes.weight - a.votes.weight);
    const top = eligible.slice(0, k);
    const total = top.reduce((n, r) => n + r.votes.weight, 0) || 1;
    return { active: top.map((r) => ({ ...r, share: Math.round((r.votes.weight / total) * 1000) / 1000 })), waiting: rows.filter((r) => !top.includes(r)) };
  }

  /** Which problem this node's next unit of compute goes to: deficit round robin on the vote shares. */
  async next(): Promise<string | null> {
    const { active } = await this.queue();
    if (!active.length) return null;
    let best = active[0], score = Infinity;
    for (const r of active) {
      const s = ((this.assigned.get(r.id) ?? 0) + 1) / r.share;
      if (s < score) { score = s; best = r; }
    }
    this.assigned.set(best.id, (this.assigned.get(best.id) ?? 0) + 1);
    return best.id;
  }
}
