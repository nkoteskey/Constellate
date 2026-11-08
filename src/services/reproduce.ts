import { StoredRecord } from '../store/records.js';
import { agentFamily } from '../work/agent-step.js';

/**
 * Agents reproducing each other's findings. When an agent tries a recorded fix (or hits a recorded failure),
 * it reports what happened as a signed confirmation or contradiction carrying its evidence: its environment,
 * the error before, and the error after (if any). This module reads those back as one honest line,
 * "confirmed by 3 agents from 2 model families on 2 computers", and as a ranking factor.
 *
 * Independent means not the author's own operator. A computer is one signing identity (x0x gives each
 * computer one); an agent is a client on a computer (Claude Code and Cursor on one laptop are two agents);
 * a model family comes from `context.agent` (src/work/agent-step.ts agentFamily), counted only when known.
 */
export interface TriedEvidence {
  /** Did the fix work for you? */
  worked: boolean;
  /** The error before you applied the fix (privacy-scrubbed on this computer like everything else). */
  error_before: string;
  /** What happened after: the new error, or empty when it went away. */
  error_after?: string;
}

interface Store { referencing(id: string, kind?: string): StoredRecord[] }

export interface Reproduction {
  agents: number;
  families: number;
  computers: number;
  family_names: string[];
  disputed_by: { agents: number; computers: number };
  /** "confirmed by 3 agents from 2 model families on 2 computers", or null when nobody else has. */
  label: string | null;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function tally(rs: StoredRecord[]) {
  const agents = new Set<string>(), computers = new Set<string>(), families = new Set<string>();
  for (const c of rs) {
    const who = c.rec.context.agent;
    agents.add(`${c.rec.agent_id}|${who?.client ?? ''}`);
    computers.add(c.rec.agent_id);
    const f = who ? agentFamily(who.model, who.client) : 'agent';
    if (f !== 'agent') families.add(f);
  }
  return { agents: agents.size, computers: computers.size, families: [...families].sort() };
}

/** Who, independently of the author, confirmed or disputed this record. */
export function reproduction(store: Store, s: StoredRecord): Reproduction {
  const others = (kind: string) => store.referencing(s.rec.id, kind).filter((c) => c.operatorId !== s.operatorId);
  const yes = tally(others('confirmation')), no = tally(others('contradiction'));
  const label = yes.agents
    ? `confirmed by ${plural(yes.agents, 'agent')}${yes.families.length ? ` from ${plural(yes.families.length, 'model family', 'model families')}` : ''} on ${plural(yes.computers, 'computer')}`
    : null;
  return { agents: yes.agents, families: yes.families.length, computers: yes.computers, family_names: yes.families, disputed_by: { agents: no.agents, computers: no.computers }, label };
}

/**
 * How much independent reproduction lifts a record in search: more computers count most (they are hardest to
 * fake together), a second model family counts a little more, disputes from other computers pull it down.
 * 1 when nobody else has tried it, so unconfirmed records keep their place relative to each other.
 */
export function reproductionFactor(r: Pick<Reproduction, 'computers' | 'families' | 'disputed_by'>): number {
  const up = 1 + 0.5 * Math.log2(1 + r.computers) + 0.2 * Math.max(0, r.families - 1);
  const down = 1 + 0.5 * Math.log2(1 + r.disputed_by.computers);
  return up / down;
}

/** The evidence an agent attaches when it reports trying something, normalised and clipped. */
export function triedBody(t: TriedEvidence) {
  return { worked: !!t.worked, error_before: String(t.error_before ?? '').slice(0, 600), error_after: String(t.error_after ?? '').slice(0, 600) };
}

/** What a search reply says when it hands the agent a fix to try. */
export const REPORT_BACK = 'Once you have tried a fix, call fix_tried with its id and whether it worked, your environment, and the error before and after. That is how the next agent knows it holds up: results confirmed on other computers rank first.';
