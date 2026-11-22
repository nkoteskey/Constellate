import { createHash } from 'node:crypto';
import type { Hub } from '../hub/hub.js';
import type { StoredRecord } from '../store/records.js';
import type { CheckpointBody, ProblemBody, TaskResultBody } from './problems.js';
import { secondChecker } from './second-checkers.js';
import { checkerId } from './checker-controls.js';
import { agentFamily } from './agent-step.js';
import { clientName } from '../hub/activity.js';

/**
 * Every result in one shape (docs/RESULTS.md), the way careful labs publish theirs:
 *   the claim; what was known before (we claim no priority); the evidence and who checked it; how to check it
 *   yourself; what is not established; and the limits, each with what would settle it.
 *
 * Two labels, kept apart: evidence says who checked it, novelty says whether it is new. A correct answer is not a
 * new one until someone has compared it with the current published tables.
 *
 * Each limit that someone can settle is an open step (`followUps`): another computer re-runs the check, an auditor
 * tries to overturn it, someone compares it with the tables. Agents get them from work_step with no arguments, so
 * no one has to ask.
 */

export const EVIDENCE = {
  independently_checked: 'Independently checked',
  one_engine: 'One engine',
  internal: 'Internal',
  disagreement: 'Checkers disagree',
} as const;
export type Evidence = keyof typeof EVIDENCE;

export const NOVELTY = {
  new: 'New',
  new_obtainable: 'New, but obtainable from known results',
  first_explicit: 'First explicit construction',
  concurrent: 'Concurrent',
  known: 'Known',
  candidate: 'Candidate',
} as const;
export type Novelty = keyof typeof NOVELTY;
/** When people disagree, the most cautious label shows (known beats concurrent beats … beats new). */
const CAUTION: Novelty[] = ['known', 'concurrent', 'new_obtainable', 'first_explicit', 'new'];

export type FollowUpStep = 'recheck' | 'audit' | 'novelty';
export interface Limit { limit: string; would_close: string; step?: FollowUpStep }

export interface ResultCard {
  /** Stable: "CR-" and the first 12 hex digits of the answer's record id. Survives the step being verified. */
  id: string;
  record: string; checkpoint: string | null; problem: string; problem_title: string; step: string; step_title: string;
  at: string;
  claim: string;
  before: string;
  evidence: { label: Evidence; text: string; checkers: string[]; computers: number; detail: string };
  novelty: { label: Novelty; text: string; says?: string; by: number };
  check_yourself: { answer_sha256: string; answer_chars: number; command: string; how: string };
  not_established: string[];
  limits: Limit[];
  audits: { held: number; overturned: number };
}

export const resultId = (recordId: string) => `CR-${recordId.slice(0, 12)}`;

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** What a verifier can't tell you, said once per kind of answer. */
const NOT_ESTABLISHED: Record<string, string> = {
  three_cubes: 'Anything about the other open numbers, or how often solutions occur.',
  perfect_cuboid: 'Anything about other cuboids, or a family of them.',
  wieferich: 'Whether further ones exist.',
  wall_sun_sun: 'Whether further ones exist.',
  ramsey_graph: 'The exact Ramsey number: this moves one bound only.',
  vdw_coloring: 'The exact van der Waerden number: this moves one bound only.',
  golomb_ruler: 'That the ruler is optimal.',
  cap_set: 'That the cap is the largest possible.',
  sat_assignment: 'Anything about other instances.',
  hadamard_gs: 'Anything about other orders; that this is the only kind of construction; how many inequivalent matrices exist.',
};

interface Cached { second: { ok: boolean; detail: string } | null; first: { ok: boolean; detail: string } }

export class Results {
  private cache = new Map<string, Cached>();
  constructor(private readonly hub: Hub) {}

  private async checks(problem: ProblemBody, chunkKey: string, rec: StoredRecord): Promise<Cached> {
    const hit = this.cache.get(rec.rec.id);
    if (hit) return hit;
    const chunk = problem.chunks.find((c) => c.key === chunkKey);
    const name = problem.definition_of_done.verifier;
    const v = this.hub.problems.verifiers.get(name);
    const output = (rec.rec.body as unknown as TaskResultBody).output;
    const first = chunk && v ? await v.check(chunk.check, output) : { ok: false, detail: 'unknown check' };
    const alt = secondChecker(name);
    const second = chunk && alt && first.ok ? await alt(chunk.check, output) : null;
    const out = { first, second };
    this.cache.set(rec.rec.id, out);
    return out;
  }

  /** Cards for one problem: every verified step, and answers that pass here but nobody else has checked yet. */
  async forProblem(problemId: string): Promise<ResultCard[]> {
    const store = this.hub.node.store;
    const p = this.hub.problems.get(problemId);
    if (!p) return [];
    const st = await this.hub.problems.state(problemId);
    const out: ResultCard[] = [];
    for (const c of st.chunks) {
      const candidates: { res: StoredRecord; cp: StoredRecord | null }[] = [];
      if (c.checkpoint) {
        const res = store.get((c.checkpoint.rec.body as unknown as CheckpointBody).result);
        if (res) candidates.push({ res, cp: c.checkpoint });
      } else {
        for (const res of c.pending) candidates.push({ res, cp: null });
        // Verified under an earlier checker version and rejected by this one: shown as a disagreement, never dropped quietly.
        const now = checkerId(st.problem.definition_of_done.verifier);
        for (const old of store.referencing(problemId, 'checkpoint')) {
          const ob = old.rec.body as unknown as CheckpointBody;
          const res = ob.chunk === c.key && ob.checker && ob.checker !== now ? store.get(ob.result) : undefined;
          if (!res || res.operatorId === old.operatorId) continue;
          const seen = candidates.find((x) => x.res.rec.id === res.rec.id);
          if (seen) seen.cp = old; else candidates.push({ res, cp: old });
        }
      }
      for (const { res, cp } of candidates) {
        const card = await this.card(p, st.problem, c.key, res, cp);
        if (card) out.push(card);
      }
    }
    return out;
  }

  async all(): Promise<ResultCard[]> {
    const out: ResultCard[] = [];
    for (const p of this.hub.problems.list()) out.push(...(await this.forProblem(p.rec.id)));
    return out.sort((a, b) => b.at.localeCompare(a.at));
  }

  /** One card by its CR- id (or the answer's record id). */
  async get(id: string): Promise<ResultCard | null> {
    const prefix = id.replace(/^CR-/, '');
    const res = this.hub.node.store.ofKind('task_result').find((s) => s.rec.id.startsWith(prefix));
    if (!res) return null;
    const b = res.rec.body as unknown as TaskResultBody;
    return (await this.forProblem(b.problem)).find((c) => c.record === res.rec.id) ?? null;
  }

  private async card(p: StoredRecord, problem: ProblemBody, chunkKey: string, res: StoredRecord, cp: StoredRecord | null): Promise<ResultCard | null> {
    const store = this.hub.node.store;
    const name = problem.definition_of_done.verifier;
    const v = this.hub.problems.verifiers.get(name);
    const chunk = problem.chunks.find((x) => x.key === chunkKey)!;
    const rb = res.rec.body as unknown as TaskResultBody;
    const { first, second } = await this.checks(problem, chunkKey, res);
    const pinnedEarlier = !!cp && !!(cp.rec.body as unknown as CheckpointBody).checker && (cp.rec.body as unknown as CheckpointBody).checker !== checkerId(name);
    if (!first.ok && !pinnedEarlier) return null; // an answer that doesn't pass here isn't a result

    const author = res.operatorId;
    const refs = (id: string) => store.referencing(id);
    const around = [...new Map([...refs(res.rec.id), ...(cp ? refs(cp.rec.id) : [])].map((r) => [r.rec.id, r])).values()];
    const followUp = (kind: string, step: FollowUpStep) => around.filter((r) => r.rec.kind === kind && (r.rec.body as { follow_up?: string }).follow_up === step && r.operatorId !== author);
    const rechecks = followUp('confirmation', 'recheck');
    const checkedElsewhere = new Set([...(cp ? store.referencing(p.rec.id, 'checkpoint').filter((x) => (x.rec.body as unknown as CheckpointBody).chunk === chunkKey).map((x) => x.operatorId) : []), ...rechecks.map((r) => r.operatorId)]);
    checkedElsewhere.delete(author);
    const cpb = cp?.rec.body as unknown as CheckpointBody | undefined;
    const checkers = [cpb?.checker ?? problem.definition_of_done.checker ?? checkerId(name), ...(second ? [`${name} (second checker)`] : [])];

    let label: Evidence;
    if (first.ok && second && !second.ok) label = 'disagreement';
    else if (!first.ok) label = 'disagreement'; // passed under an earlier checker, rejected by this one
    else if (!checkedElsewhere.size) label = 'internal';
    else label = second?.ok ? 'independently_checked' : 'one_engine';
    const evidenceText = {
      independently_checked: `Two separately written checkers accept it, and ${checkedElsewhere.size === 1 ? 'another computer' : `${checkedElsewhere.size} other computers`} re-ran the check.`,
      one_engine: `One checker accepts it, re-run on ${checkedElsewhere.size === 1 ? 'another computer' : `${checkedElsewhere.size} other computers`}; no second, separately written checker exists for this kind of answer.`,
      internal: 'It passes the check on this computer; no other computer has re-run it yet.',
      disagreement: !first.ok ? `It was verified under ${cpb?.checker ?? 'an earlier checker'}, and this computer's ${checkerId(name)} rejects it: ${first.detail}` : `The first checker accepts it and the second rejects it: ${second?.detail ?? ''}`,
    }[label];

    // Novelty: what people found when they compared it with the tables. The most cautious label shows.
    const nov = around.filter((r) => r.rec.kind === 'novelty' && r.operatorId !== author);
    const said = nov.map((r) => r.rec.body as { label: Novelty; says: string }).filter((b) => b.label in NOVELTY);
    const shown = CAUTION.find((l) => said.some((b) => b.label === l));
    const novelty = shown
      ? { label: shown, text: NOVELTY[shown], says: said.find((b) => b.label === shown)!.says, by: new Set(nov.map((r) => r.operatorId)).size }
      : { label: 'candidate' as Novelty, text: `${NOVELTY.candidate}: correct, not yet compared with the current tables`, by: 0 };

    const audits = followUp('confirmation', 'audit').length, overturned = followUp('contradiction', 'audit').length;
    const limits: Limit[] = [];
    if (label === 'internal') limits.push({ limit: 'No other computer has re-run the check.', would_close: 'Another computer re-runs both checkers and signs what it found.', step: 'recheck' });
    if (label === 'one_engine') limits.push({ limit: 'Only one checker exists for this kind of answer.', would_close: 'A second checker, written separately (ideally in another language), accepts it.' });
    if (label === 'disagreement') limits.push({ limit: 'The checkers disagree.', would_close: 'Someone finds which checker is wrong and says why.', step: 'audit' });
    if (/probable prime/.test(first.detail)) limits.push({ limit: 'p is shown to be a strong probable prime, not proven prime.', would_close: 'A primality proof for p, for example an ECPP certificate.' });
    if (novelty.label === 'candidate') limits.push({ limit: 'Not yet compared with the current published tables.', would_close: 'Someone compares it with the latest tables and records whether it is new, known or concurrent, with the source.', step: 'novelty' });
    if (!audits && !overturned) limits.push({ limit: 'Nobody has tried to overturn it.', would_close: 'An auditor on another computer tries to overturn it, for example by checking the problem statement and the source, and reports either way.', step: 'audit' });
    if (overturned) limits.push({ limit: `${overturned === 1 ? 'An auditor says' : `${overturned} auditors say`} it doesn't hold.`, would_close: 'The objection is answered or the result is withdrawn.', step: 'audit' });

    const src = problem.source;
    const before = src ? `${src.says} (${src.url}, read ${src.read}). We claim no priority over earlier work.` : 'No published source is attached to this problem. We claim no priority over earlier work.';
    const id = resultId(res.rec.id);
    return {
      id, record: res.rec.id, checkpoint: cp?.rec.id ?? null, problem: p.rec.id, problem_title: problem.title, step: chunkKey, step_title: chunk.title,
      at: (cp ?? res).rec.created,
      claim: `${chunk.title}: ${first.detail}.`,
      before,
      evidence: { label, text: evidenceText, checkers, computers: checkedElsewhere.size, detail: first.detail },
      novelty,
      check_yourself: {
        answer_sha256: sha(rb.output), answer_chars: rb.output.length,
        command: `npx -y constellate-mcp recheck ${id}`,
        how: `The answer is record ${res.rec.id}. The check: ${v?.shape ?? name}.`,
      },
      not_established: [NOT_ESTABLISHED[name] ?? 'Anything beyond this one answer.', 'That the way it was found would work again.'],
      limits, audits: { held: audits, overturned },
    };
  }

  /** The limits anyone can settle now, as open steps, skipping results this computer's own operator produced. */
  async followUps(limit = 3): Promise<{ result: string; problem_title: string; step: FollowUpStep; title: string; prompt: string }[]> {
    const me = this.hub.node.operatorId;
    const out: { result: string; problem_title: string; step: FollowUpStep; title: string; prompt: string }[] = [];
    const done = (card: ResultCard, step: FollowUpStep) => this.hub.node.store.referencing(card.checkpoint ?? card.record).concat(this.hub.node.store.referencing(card.record))
      .some((r) => r.operatorId === me && (r.rec.body as { follow_up?: string }).follow_up === step);
    for (const card of await this.all()) {
      if (this.hub.node.store.get(card.record)?.operatorId === me) continue; // nobody audits their own result
      for (const l of card.limits) {
        if (!l.step || done(card, l.step)) continue;
        out.push({ result: card.id, problem_title: card.problem_title, step: l.step, title: `${card.step_title}: ${l.limit}`, prompt: FOLLOW_UP_PROMPT[l.step](card) });
        if (out.length >= limit) return out;
        break; // one per result, so the list spans results
      }
    }
    return out;
  }

  /** Settle a follow-up: re-run the checks here, record an audit, or record what the tables say. */
  async submit(a: { result: string; step: string; verdict?: string; answer?: string; model?: string; client?: string }) {
    const card = await this.get(a.result);
    if (!card) throw new Error(`no result ${a.result}`);
    const target = this.hub.node.store.get(card.record)!;
    if (target.operatorId === this.hub.node.operatorId) throw new Error('this result is your own; someone else has to check it');
    const p = this.hub.problems.body(card.problem);
    const note = (a.answer ?? '').trim().slice(0, 2000);
    const ctx = { task: `${a.step} ${card.id}: ${card.problem_title}`, domain: [p.realm], environment: (a.model?.trim() || a.client || 'agent').slice(0, 80), agent: { client: clientName(a.client) === 'An agent' ? 'Agent' : clientName(a.client), ...(a.model?.trim() ? { model: a.model.trim().slice(0, 80) } : {}) } };
    const refs = [card.record, ...(card.checkpoint ? [card.checkpoint] : []), card.problem];
    if (a.step === 'recheck') {
      // This computer re-runs both checkers itself: the agent's say-so isn't the evidence.
      this.cache.delete(card.record);
      const { first, second } = await this.checks(p, card.step, target);
      const held = first.ok && (!second || second.ok);
      const body = { follow_up: 'recheck', checker: checkerId(p.definition_of_done.verifier), first: first.detail, second: second?.detail ?? null, ...(held ? { verdict: 'reproduced', note } : { reason: `${first.ok ? 'the second checker rejects it' : 'the check rejects it'}: ${(second && !second.ok ? second : first).detail}` }) };
      const { record } = await this.hub.node.submit({ kind: held ? 'confirmation' : 'contradiction', refs, context: ctx, body }, { publish: true });
      return { recorded: record.id, held, first: first.detail, second: second?.detail ?? null };
    }
    if (a.step === 'audit') {
      const v = (a.verdict ?? '').toLowerCase();
      if (v !== 'holds' && v !== 'overturned') throw new Error('an audit needs verdict "holds" or "overturned"');
      if (note.length < 20) throw new Error('say what you checked and what you found (the answer), in a sentence or two');
      const { record } = await this.hub.node.submit({ kind: v === 'holds' ? 'confirmation' : 'contradiction', refs, context: ctx, body: v === 'holds' ? { follow_up: 'audit', verdict: 'reproduced', note, family: agentFamily(a.model, a.client) } : { follow_up: 'audit', reason: note, family: agentFamily(a.model, a.client) } }, { publish: true });
      return { recorded: record.id, held: v === 'holds' };
    }
    if (a.step === 'novelty') {
      const label = (a.verdict ?? '').toLowerCase() as Novelty;
      if (!(label in NOVELTY) || label === 'candidate') throw new Error(`novelty needs verdict ${CAUTION.join(', ')}`);
      if (!/https?:\/\/\S+/.test(note)) throw new Error('say what you compared it with, including a link to the table or paper (the answer)');
      const { record } = await this.hub.node.submit({ kind: 'novelty', refs, context: ctx, body: { follow_up: 'novelty', label, says: note } }, { publish: true });
      return { recorded: record.id, label: NOVELTY[label] };
    }
    throw new Error('step is recheck, audit or novelty');
  }
}

const FOLLOW_UP_PROMPT: Record<FollowUpStep, (c: ResultCard) => string> = {
  recheck: (c) => `Re-run the checks on result ${c.id} (${c.claim}) on this computer: call work_step with follow_up "${c.id}" and step "recheck". This computer runs both checkers itself and signs what they say.`,
  audit: (c) => `Try to overturn result ${c.id}: ${c.claim} Read the problem's source and statement (${c.before}) and look for what would make the result wrong or not mean what it says: a misread bound, a wrong definition, an answer outside the stated range, a checker that is too lenient. Then call work_step with follow_up "${c.id}", step "audit", verdict "holds" or "overturned", and in answer what you checked and found. Refuted is a useful result too.`,
  novelty: (c) => `Is result ${c.id} new? ${c.claim} Compare it with the latest published tables and papers (start from ${c.before}). Then call work_step with follow_up "${c.id}", step "novelty", verdict one of new, new_obtainable (every ingredient was published, only the combination is new), first_explicit, concurrent or known, and in answer what you compared it with, with links.`,
};
