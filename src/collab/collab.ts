import { Hub } from '../hub/hub.js';
import { ModelRunner } from '../contributor/models.js';
import { Board } from '../work/board.js';
import { VerifierRegistry } from '../work/verifiers.js';
import { verifyRecord } from '../core/record.js';
import { StoredRecord } from '../store/records.js';

/**
 * Supporting capabilities that sit across the five services:
 * verifiable context hand-off, mid-task help requests through the Swarm,
 * the disagreement court, and the huddle view.
 */
export interface HandoffBody { task: string; tried: string[]; state: string; next: string; to?: string }
export interface HelpBody { question: string; needs: string; verifier: string; check: Record<string, unknown>; bounty: number }
export interface RulingBody { case: [string, string]; decision: 'first' | 'second' | 'both_conditional' | 'undecided'; reasoning: string; confidence: number; needs_human: boolean; judge_family: string }

export class Collab {
  constructor(private readonly hub: Hub, private readonly verifiers: VerifierRegistry = hub.problems.verifiers) {}

  // ── Verifiable context hand-off ───────────────────────────────────
  /** A signed note: what was tried, the state reached, and the proof (refs to records that back it). */
  async handoff(note: HandoffBody, proof: string[], domain: string[]) {
    return this.hub.node.submit({ kind: 'handoff', context: { task: note.task, domain, environment: '' }, body: note, refs: proof }, { publish: true });
  }

  /** The next agent checks a hand-off before trusting it: signature, every proof present and valid, checkpoints re-verified. */
  async checkHandoff(id: string): Promise<{ trusted: boolean; problems: string[]; note?: HandoffBody }> {
    const s = this.hub.node.store.get(id);
    if (!s || s.rec.kind !== 'handoff') return { trusted: false, problems: ['unknown hand-off'] };
    const problems: string[] = [];
    const v = verifyRecord(s.rec);
    if (!v.ok) problems.push(`signature: ${v.reason}`);
    if (!s.rec.refs.length) problems.push('no proof attached');
    for (const r of s.rec.refs) {
      const p = this.hub.node.store.get(r);
      if (!p) { problems.push(`proof ${r.slice(0, 10)} not found`); continue; }
      if (p.rec.kind === 'checkpoint') {
        const prob = this.hub.problems.get((p.rec.body as { problem: string }).problem);
        if (!prob || !(await this.hub.problems.validCheckpoint(p, prob.rec.body as never))) problems.push(`checkpoint ${r.slice(0, 10)} does not re-verify`);
      }
      if (this.hub.trust.explain(p).contradictions > 0 && this.hub.trust.weight(p) === 0) problems.push(`proof ${r.slice(0, 10)} is contradicted`);
    }
    return { trusted: problems.length === 0, problems, note: s.rec.body as unknown as HandoffBody };
  }

  // ── Mid-task help requests through the Swarm ──────────────────────
  async askForHelp(body: HelpBody, board: Board, domain: string[], refs: string[] = []) {
    if (!this.verifiers.get(body.verifier)) throw new Error('help requests must name a verifier so the answer is checkable');
    const { record } = await this.hub.node.submit({ kind: 'help_request', context: { task: body.question, domain, environment: '' }, body, refs }, { publish: true });
    await board.ensure(`[help ${record.id.slice(0, 10)}] ${body.question.slice(0, 80)}`, { help: record.id, needs: body.needs });
    return record;
  }

  /** A specialist claims a help task from the board and answers it with its model. */
  async answerHelp(board: Board, runner: ModelRunner) {
    for (const t of await board.list()) {
      if (!t.tags.help || t.state === 'done') continue;
      const req = this.hub.node.store.get(t.tags.help);
      if (!req || req.operatorId === this.hub.node.operatorId) continue;
      if (t.tags.needs && t.tags.needs !== 'any' && t.tags.needs !== runner.size) continue;
      await board.claim(t.id, this.hub.node.agentId);
      const b = req.rec.body as unknown as HelpBody;
      const out = await runner.run(b.question);
      const { record } = await this.hub.node.submit({ kind: 'answer', context: { task: b.question.slice(0, 200), domain: req.rec.context.domain, environment: runner.id }, body: { question: b.question, answer: out.slice(0, 4000), proof: { type: 'test', detail: `checkable with verifier ${b.verifier}` } }, refs: [req.rec.id] }, { publish: true });
      return { task: t.id, answer: record.id };
    }
    return null;
  }

  /** The requester checks the answers it got; the first that passes is accepted (confirmed), and the task closes. */
  async acceptHelp(requestId: string, board: Board) {
    const req = this.hub.node.store.get(requestId)!;
    const b = req.rec.body as unknown as HelpBody;
    const v = this.verifiers.get(b.verifier)!;
    const mine = (a: StoredRecord, kind: 'confirmation' | 'contradiction') => this.hub.node.store.referencing(a.rec.id, kind).some((c) => c.operatorId === this.hub.node.operatorId);
    const answers = this.hub.node.store.referencing(requestId, 'answer').sort((x, y) => x.rec.created.localeCompare(y.rec.created));
    // Checked once: an answer already accepted stays accepted; one already found wanting isn't judged again.
    const done = answers.find((a) => mine(a, 'confirmation'));
    if (done) return { accepted: done.rec.id };
    for (const a of answers.filter((x) => !mine(x, 'contradiction'))) {
      if ((await v.check(b.check, (a.rec.body as { answer: string }).answer)).ok) {
        await this.hub.confirm(a.rec.id, { note: 'checked by the requester' }, { publish: true });
        const t = (await board.list()).find((x) => x.tags.help === requestId);
        if (t) await board.complete(t.id, this.hub.node.agentId);
        if (b.bounty && this.hub.economy) await this.hub.economy.pay(a.rec.agent_id, b.bounty, 'review_fee', [a.rec.id, requestId]);
        return { accepted: a.rec.id };
      }
      await this.hub.contradict(a.rec.id, 'did not pass the requester\'s check', {}, { publish: true });
    }
    return { accepted: null };
  }

  // ── Disagreement court ────────────────────────────────────────────
  /** Clashes the court should hear: records contradicted by someone, or results a verifier rejected. */
  cases(): [string, string][] {
    const out: [string, string][] = [];
    for (const c of this.hub.node.store.ofKind('contradiction')) out.push([c.rec.refs[0], c.rec.id]);
    return out.filter(([a, b]) => !this.ruling(a, b));
  }
  ruling(a: string, b: string) { return this.hub.node.store.ofKind('ruling').find((r) => { const c = (r.rec.body as unknown as RulingBody).case; return c[0] === a && c[1] === b; }); }

  /**
   * A third, independent agent (neither side's operator, and a model of its own)
   * hears both sides and decides; the reasoning is kept. Low confidence pulls a human in.
   */
  async hear(a: string, b: string, judge: ModelRunner): Promise<StoredRecord | null> {
    const A = this.hub.node.store.get(a), B = this.hub.node.store.get(b);
    if (!A || !B) throw new Error('unknown case');
    if (A.operatorId === this.hub.node.operatorId || B.operatorId === this.hub.node.operatorId) throw new Error('the court must be independent of both sides');
    const out = await judge.run(`Two agents disagree. Decide which is right, or whether both hold under different conditions.\nFIRST (environment: ${A.rec.context.environment}): ${JSON.stringify(A.rec.body).slice(0, 2000)}\nSECOND (environment: ${B.rec.context.environment}): ${JSON.stringify(B.rec.body).slice(0, 2000)}\nState each side's strongest case first. Decide on evidence you can check (the environments, the numbers, a concrete failing case), not on which sounds more confident; how many agents agree is not evidence. If the evidence here can't settle it, say UNDECIDED and name the one check that would.\nReply on line 1 with FIRST, SECOND, BOTH or UNDECIDED; line 2 a confidence 0-1; then your reasoning, ending with what you couldn't check.`, { maxTokens: 800 });
    const [l1 = '', l2 = '', ...rest] = out.split('\n');
    const decision = /first/i.test(l1) ? 'first' : /second/i.test(l1) ? 'second' : /both/i.test(l1) ? 'both_conditional' : 'undecided';
    const confidence = Math.max(0, Math.min(1, Number(l2) || 0));
    const body: RulingBody = { case: [a, b], decision, reasoning: rest.join('\n').trim().slice(0, 3000), confidence, needs_human: decision === 'undecided' || confidence < 0.6, judge_family: judge.family };
    const { record } = await this.hub.node.submit({ kind: 'ruling', context: { task: 'disagreement court', domain: A.rec.context.domain, environment: judge.id }, body: body as unknown as Record<string, unknown>, refs: [a, b] }, { publish: true });
    return this.hub.node.store.get(record.id) ?? null;
  }

  // ── Huddle view ───────────────────────────────────────────────────
  /** Which agents are teaming up on a problem, who handed off what, and each signed step. */
  huddle(problemId: string) {
    const store = this.hub.node.store;
    const steps: StoredRecord[] = [];
    const walk = (id: string, depth: number) => { for (const r of store.referencing(id)) { if (steps.includes(r) || depth > 3) continue; steps.push(r); walk(r.rec.id, depth + 1); } };
    walk(problemId, 0);
    steps.sort((x, y) => x.rec.created.localeCompare(y.rec.created));
    const agents = new Map<string, { agent: string; operator: string; human: boolean; steps: number; models: Set<string> }>();
    for (const s of steps) {
      const a = agents.get(s.rec.agent_id) ?? { agent: s.rec.agent_id, operator: s.operatorId, human: /^human\b/.test(s.rec.context.environment), steps: 0, models: new Set<string>() };
      a.steps++;
      if (s.rec.context.environment && !a.human) a.models.add(s.rec.context.environment);
      agents.set(s.rec.agent_id, a);
    }
    return {
      problem: problemId,
      agents: [...agents.values()].map((a) => ({ ...a, models: [...a.models] })),
      handoffs: steps.filter((s) => s.rec.kind === 'handoff').map((s) => ({ id: s.rec.id, from: s.rec.agent_id, to: (s.rec.body as { to?: string }).to ?? null, next: (s.rec.body as { next: string }).next })),
      steps: steps.map((s) => ({ id: s.rec.id, kind: s.rec.kind, by: s.rec.agent_id, at: s.rec.created, signed: true })),
    };
  }
}
