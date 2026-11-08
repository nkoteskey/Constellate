import type { Hub } from './hub.js';
import { localSavings, networkSavings, operatorSavings } from './savings.js';

/**
 * The metrics from the design. Network-derived numbers are computed from public
 * signed records; behaviour numbers (did an agent check the hub before acting,
 * shares, time to first contribution) are counted on this node only and never
 * leave it unless the operator chooses to publish them.
 */
const LOOKUPS = new Set(['failures_search', 'answers_lookup', 'skills_find', 'graph_recall', 'memory_get', 'handoff_check', 'problems_status']);
const WRITES = new Set(['failures_report', 'answers_submit', 'skills_publish', 'review_request', 'help_request', 'proposals_submit', 'handoff_create', 'records_link', 'fix_tried']);
const WEEK = 7 * 86_400_000;
/** Below this many independent tries, the hit rate isn't shown as a number: too few to say. */
export const HIT_RATE_MIN_TRIES = 10;

type Store = Hub['node']['store'];

/**
 * How often a fix from Constellate worked when someone else tried it: every fix_tried report (a confirmation or
 * contradiction carrying what was tried) on an answer, from an operator other than the answer's author. Only public,
 * signed records count, so anyone can recompute it. Below HIT_RATE_MIN_TRIES the rate is null, never a guess.
 */
export function fixHitRate(store: Store, min = HIT_RATE_MIN_TRIES) {
  const tries = store.all().filter((s) => s.visibility === 'public' && (s.rec.kind === 'confirmation' || s.rec.kind === 'contradiction') && (s.rec.body as { tried?: unknown }).tried)
    .filter((s) => { const t = store.get(s.rec.refs[0]); return t?.rec.kind === 'answer' && t.operatorId !== s.operatorId; });
  const worked = tries.filter((s) => s.rec.kind === 'confirmation').length;
  return {
    tried: tries.length, worked, by_operators: new Set(tries.map((s) => s.operatorId)).size,
    rate: tries.length >= min ? Math.round((worked / tries.length) * 1000) / 1000 : null,
    how: `Share of fix_tried reports on answers, by operators other than the author, that said it worked. Shown once there are ${HIT_RATE_MIN_TRIES} tries.`,
  };
}

export class Metrics {
  private sessions = new Map<string, { looked: boolean; tasks: number; checkedFirst: number; inTask: boolean }>();
  private events: { type: 'share' | 'invite'; who: string; at: number }[] = [];
  private firstContribution: number[] = [];

  constructor(private readonly hub: Hub) {}

  /** Called for every MCP tool call. A "task" ends at a write; it counts as checked-first if a lookup came before it. */
  toolCall(session: string, tool: string) {
    const s = this.sessions.get(session) ?? { looked: false, tasks: 0, checkedFirst: 0, inTask: false };
    if (LOOKUPS.has(tool)) { s.looked = true; s.inTask = true; }
    if (WRITES.has(tool)) { s.tasks++; if (s.looked) s.checkedFirst++; s.looked = false; s.inTask = false; }
    this.sessions.set(session, s);
  }
  event(type: 'share' | 'invite', who: string) { this.events.push({ type, who, at: Date.now() }); }
  firstContributionSeconds(sec: number) { if (Number.isFinite(sec) && sec >= 0 && sec < 86_400) this.firstContribution.push(sec); }

  report(now = Date.now()) {
    const recs = this.hub.node.store.all().filter((s) => s.visibility === 'public');
    const human = (s: (typeof recs)[number]) => /^human\b/.test(s.rec.context.environment);
    const week = (k: number) => recs.filter((s) => { const t = Date.parse(s.rec.created); return t <= now - k * WEEK && t > now - (k + 1) * WEEK; });
    const ops = (rs: typeof recs) => new Set(rs.map((s) => s.operatorId));
    const thisWeek = week(0), lastWeek = week(1);
    const content = recs.filter((s) => !['confirmation', 'contradiction', 'use', 'receipt', 'vote', 'rating', 'message', 'link'].includes(s.rec.kind));
    const confirmed = content.filter((s) => this.hub.node.store.referencing(s.rec.id, 'confirmation').some((c) => c.operatorId !== s.operatorId));
    const prevOps = ops(lastWeek), nowOps = ops(thisWeek);
    const tasks = [...this.sessions.values()].reduce((n, s) => n + s.tasks, 0);
    const checked = [...this.sessions.values()].reduce((n, s) => n + s.checkedFirst, 0);
    const contributors = ops(recs).size || 1;
    const sorted = [...this.firstContribution].sort((a, b) => a - b);
    return {
      agents_connected_this_week: new Set(thisWeek.filter((s) => !human(s)).map((s) => s.rec.agent_id)).size,
      share_of_tasks_checking_hub_first: tasks ? Math.round((checked / tasks) * 1000) / 1000 : null,
      tasks_observed: tasks,
      records_confirmed: confirmed.length,
      records_confirmed_share: content.length ? Math.round((confirmed.length / content.length) * 1000) / 1000 : null,
      contributors_returning_within_a_week: [...prevOps].filter((o) => nowOps.has(o)).length,
      shares_and_invites_per_contributor: Math.round((this.events.length / contributors) * 100) / 100,
      median_seconds_to_first_contribution: sorted.length ? sorted[Math.floor(sorted.length / 2)] : null,
      // The number that matters to an agent deciding whether to look here first.
      fix_hit_rate: fixHitRate(this.hub.node.store),
      // What shared lessons saved (src/hub/savings.ts): from public records, and this computer's own agents locally.
      saved: {
        network: networkSavings(this.hub.node.store),
        this_computer: { ...localSavings(), avoided: operatorSavings(this.hub.node.store, this.hub.node.operatorId).for_them.avoided },
      },
    };
  }
}
