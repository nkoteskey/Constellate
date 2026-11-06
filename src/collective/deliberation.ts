import { Hub } from '../hub/hub.js';
import { StoredRecord } from '../store/records.js';
import { ModelRunner } from '../contributor/models.js';

/**
 * Deliberation track for questions that can't be machine-checked. The swarm
 * doesn't declare truth; it produces a map: positions (steelmanned first),
 * arguments for and against, cruxes, where model families agree and split,
 * and how humans rate argument quality. Positions are re-run over time and
 * shifts are kept.
 */
export interface QuestionBody { type: 'deliberation'; question: string; hook: string; realm: string }
export interface PositionBody { question: string; slot: string; statement: string; family: string; confidence: number; cruxes: string[] }
export interface ArgumentBody { position: string; stance: 'for' | 'against'; text: string; family: string }

const isHuman = (s: StoredRecord) => /^human\b/.test(s.rec.context.environment);

export class Deliberation {
  constructor(private readonly hub: Hub) {}

  async ask(question: string, hook = '', realm = 'philosophy_ethics') {
    return this.hub.node.submit({ kind: 'proposal', context: { task: question, domain: [realm, 'deliberation'], environment: '' }, body: { type: 'deliberation', question, hook, realm } }, { publish: true });
  }

  questions() { return this.hub.node.store.ofKind('proposal').filter((s) => (s.rec.body as { type?: string }).type === 'deliberation'); }

  /** State a position. `slot` groups re-runs of the same position over time. */
  async position(questionId: string, p: Omit<PositionBody, 'question'>, environment: string) {
    return this.hub.node.submit({ kind: 'position', context: { task: p.statement.slice(0, 200), domain: ['deliberation'], environment }, body: { question: questionId, ...p }, refs: [questionId] }, { publish: true });
  }

  /** Steelman first: a defender (other operator) confirms the statement is one they'd accept, before critique counts. */
  endorseSteelman(positionId: string) { return this.hub.confirm(positionId, { note: 'steelman accepted' }, { publish: true }); }

  async argue(positionId: string, a: Omit<ArgumentBody, 'position'>, environment: string) {
    return this.hub.node.submit({ kind: 'argument', context: { task: a.text.slice(0, 200), domain: ['deliberation'], environment }, body: { position: positionId, ...a }, refs: [positionId] }, { publish: true });
  }

  /** Humans judge argument quality, 1..5. */
  async rate(argumentId: string, score: number) {
    return this.hub.node.submit({ kind: 'rating', context: { task: 'rate argument', domain: ['deliberation'], environment: 'human' }, body: { argument: argumentId, score: Math.max(1, Math.min(5, Math.round(score))) }, refs: [argumentId] }, { publish: true });
  }

  /** Have a model state and defend positions (model diversity: call with runners from different families). */
  async contribute(questionId: string, runner: ModelRunner) {
    const q = this.hub.node.store.get(questionId)!.rec.body as unknown as QuestionBody;
    const out = await runner.run(`Question: ${q.question}\nState your position in one sentence on the first line, then a confidence 0-1 on the second line, then up to three cruxes (what would change your mind), one per line starting with "- ".`, { maxTokens: 600 });
    const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
    const statement = lines[0] ?? '';
    const confidence = Math.max(0, Math.min(1, Number(lines[1]) || 0.5));
    const cruxes = lines.filter((l) => l.startsWith('- ')).map((l) => l.slice(2)).slice(0, 3);
    return this.position(questionId, { slot: `${runner.family}:${statement.slice(0, 40).toLowerCase()}`, statement, family: runner.family, confidence, cruxes }, runner.id);
  }

  map(questionId: string) {
    const store = this.hub.node.store;
    const q = store.get(questionId);
    if (!q) throw new Error('unknown question');
    const positions = store.referencing(questionId, 'position');
    const slots = new Map<string, StoredRecord[]>();
    for (const p of positions) { const k = (p.rec.body as unknown as PositionBody).slot; if (!slots.has(k)) slots.set(k, []); slots.get(k)!.push(p); }
    const cruxCount = new Map<string, Set<string>>();
    const rows = [...slots.values()].map((hist) => {
      hist.sort((a, b) => Date.parse(a.rec.created) - Date.parse(b.rec.created));
      const latest = hist.at(-1)!;
      const b = latest.rec.body as unknown as PositionBody;
      for (const c of b.cruxes) { const k = c.toLowerCase(); if (!cruxCount.has(k)) cruxCount.set(k, new Set()); cruxCount.get(k)!.add(b.family); }
      const steelmanned = store.referencing(latest.rec.id, 'confirmation').some((c) => c.operatorId !== latest.operatorId);
      const args = hist.flatMap((h) => store.referencing(h.rec.id, 'argument')).map((a) => {
        const ab = a.rec.body as unknown as ArgumentBody;
        const ratings = store.referencing(a.rec.id, 'rating').filter(isHuman);
        const byOp = new Map(ratings.map((r) => [r.operatorId, (r.rec.body as { score: number }).score]));
        const scores = [...byOp.values()];
        return { id: a.rec.id, stance: ab.stance, text: ab.text, family: ab.family, by: isHuman(a) ? 'human' : 'agent', ratings: scores.length, quality: scores.length ? Math.round((scores.reduce((x, y) => x + y, 0) / scores.length) * 10) / 10 : null };
      }).sort((x, y) => (y.quality ?? 0) - (x.quality ?? 0));
      return {
        id: latest.rec.id, statement: b.statement, family: b.family, confidence: b.confidence, cruxes: b.cruxes, steelmanned,
        history: hist.map((h) => ({ id: h.rec.id, at: h.rec.created, confidence: (h.rec.body as unknown as PositionBody).confidence, statement: (h.rec.body as unknown as PositionBody).statement })),
        arguments: steelmanned ? args : [], arguments_waiting_for_steelman: steelmanned ? 0 : args.length,
      };
    });
    const families = [...new Set(rows.map((r) => r.family))];
    return {
      id: questionId, question: (q.rec.body as unknown as QuestionBody).question, hook: (q.rec.body as unknown as QuestionBody).hook,
      model_families: families,
      positions: rows,
      shared_cruxes: [...cruxCount.entries()].filter(([, f]) => f.size > 1).map(([c, f]) => ({ crux: c, families: [...f] })),
      agreement: families.length > 1 && new Set(rows.map((r) => r.statement.toLowerCase())).size === 1 ? 'all families agree' : `${rows.length} positions across ${families.length} model families`,
    };
  }

  /**
   * Revisit a debate as models and evidence change: the runner re-states its own
   * family's positions in light of the arguments and people's ratings so far.
   * A new position is recorded only when it actually shifted, and the old one
   * stays in the history.
   */
  async rerun(questionId: string, runner: ModelRunner): Promise<number> {
    const m = this.map(questionId);
    let shifted = 0;
    for (const p of m.positions.filter((x) => x.family === runner.family)) {
      const args = p.arguments.slice(0, 6).map((a) => `- ${a.stance} (rated ${a.quality ?? 'unrated'}/5 by people): ${a.text}`).join('\n');
      const out = await runner.run(`A debate: "${m.question}".\nYour family's current position: "${p.statement}" (confidence ${p.confidence}).\nArguments so far:\n${args || '(none yet)'}\n\nRestate the position you now hold, in one sentence, and your confidence from 0 to 1. Change it only if the arguments warrant. Reply as JSON: {"statement": "...", "confidence": 0.0, "cruxes": ["..."]}`, { maxTokens: 400 });
      const j = (() => { try { return JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1)) as { statement?: string; confidence?: number; cruxes?: string[] }; } catch { return null; } })();
      if (!j?.statement || typeof j.confidence !== 'number') continue;
      const confidence = Math.max(0, Math.min(1, j.confidence));
      if (j.statement.trim() === p.statement && Math.abs(confidence - p.confidence) < 0.05) continue;
      const slot = (this.hub.node.store.get(p.id)!.rec.body as unknown as PositionBody).slot;
      await this.position(questionId, { slot, statement: j.statement.trim().slice(0, 600), family: runner.family, confidence, cruxes: (j.cruxes ?? p.cruxes).slice(0, 4).map((c) => String(c).slice(0, 200)) }, `${runner.id} (re-run)`);
      shifted++;
    }
    return shifted;
  }

  /** Re-run every debate on a schedule (default weekly). */
  scheduleReruns(runner: ModelRunner, everyMs = 7 * 86_400_000) {
    const t = setInterval(() => { for (const q of this.questions()) void this.rerun(q.rec.id, runner).catch(() => 0); }, everyMs);
    t.unref?.();
    return () => clearInterval(t);
  }
}
