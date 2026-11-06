import { z } from 'zod';
import { HubNode } from '../hub/node.js';
import { StoredRecord } from '../store/records.js';
import { bm25, envSimilarity } from './search.js';
import { TrustModel } from './trust.js';
import { hashInputs } from '../privacy/scrub.js';
import { RecordContext } from '../core/record.js';
import type { KnowledgeGraph } from '../graph/graph.js';

export const FailureBody = z.object({
  approach: z.string().max(600),
  outcome: z.enum(['error', 'wrong_result', 'too_slow', 'too_costly']),
  error_summary: z.string().max(600),
  confidence: z.number().min(0).max(1).default(0.7),
});
export type FailureBody = z.infer<typeof FailureBody>;

export const AnswerBody = z.object({
  question: z.string().max(600),
  answer: z.string().max(4000),
  proof: z.object({ type: z.enum(['test', 'benchmark', 'proof', 'reproduction', 'citation']), detail: z.string().max(1000) }),
});
export type AnswerBody = z.infer<typeof AnswerBody>;

export interface CtxInput { task: string; domain: string[]; environment: string; inputs_text?: string }
export function toContext(c: CtxInput): RecordContext {
  return { task: c.task, domain: c.domain, environment: c.environment, ...(c.inputs_text ? { inputs_hash: hashInputs(c.inputs_text) } : {}) };
}

const DAY = 86400_000;
const ageDays = (s: StoredRecord) => Math.max(0, (Date.now() - Date.parse(s.rec.created)) / DAY);

/**
 * The failure ledger and the verified answer cache: two halves of one idea,
 * what didn't work and what did. Reads are free and local.
 */
export class Ledger {
  constructor(private readonly node: HubNode, private trust: TrustModel, private readonly graph?: KnowledgeGraph) {}
  setTrust(t: TrustModel) { this.trust = t; }

  async reportFailure(ctx: CtxInput, body: z.input<typeof FailureBody>, opts: { publish?: boolean; refs?: string[]; evidence?: string[] } = {}) {
    return this.node.submit({ kind: 'failure', context: toContext(ctx), body: FailureBody.parse(body), refs: opts.refs, evidence: opts.evidence }, { publish: opts.publish });
  }

  async submitAnswer(ctx: CtxInput, body: z.input<typeof AnswerBody>, opts: { publish?: boolean; fixes?: string[]; evidence?: string[] } = {}) {
    return this.node.submit({ kind: 'answer', context: toContext(ctx), body: AnswerBody.parse(body), refs: opts.fixes, evidence: opts.evidence }, { publish: opts.publish });
  }

  private rank(kind: 'failure' | 'answer', query: string, domain: string[] = [], environment = '', limit = 5) {
    const recs = this.node.store.ofKind(kind);
    const text = (s: StoredRecord) => {
      const b = s.rec.body as Record<string, string>;
      return [s.rec.context.task, s.rec.context.domain.join(' '), b.approach, b.error_summary, b.question, b.answer, s.rec.context.environment].filter(Boolean).join(' ');
    };
    const rel = bm25(query, recs.map((s) => ({ id: s.rec.id, text: text(s), tags: s.rec.context.domain })), { tags: domain });
    const scored = recs.filter((s) => rel.has(s.rec.id)).map((s) => {
      const t = this.trust.explain(s);
      const env = environment ? envSimilarity(environment, s.rec.context.environment) : 0;
      const score = rel.get(s.rec.id)! * (0.25 + this.trust.weight(s)) * (1 + env) * (this.graph ? this.graph.nodeFactor(s.rec.id) : 1);
      return { s, t, env, score };
    });
    return scored.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  searchFailures(query: string, opts: { domain?: string[]; environment?: string; limit?: number } = {}) {
    return this.rank('failure', query, opts.domain, opts.environment, opts.limit ?? 5).map(({ s, t, env }) => {
      const b = s.rec.body as FailureBody;
      return {
        id: s.rec.id, task: s.rec.context.task, approach: b.approach, outcome: b.outcome, error_summary: b.error_summary,
        environment: s.rec.context.environment, env_match: round(env), confidence: b.confidence,
        weight: round(t.weight), confirmations: t.confirmations, contradictions: t.contradictions, age_days: Math.floor(ageDays(s)),
        fixed_by: this.node.store.referencing(s.rec.id, 'answer').map((a) => a.rec.id).slice(0, 3),
        neighbours: this.graph?.neighbours(s.rec.id, 3) ?? [],
      };
    });
  }

  lookupAnswers(question: string, opts: { domain?: string[]; environment?: string; limit?: number } = {}) {
    return this.rank('answer', question, opts.domain, opts.environment, opts.limit ?? 3).map(({ s, t, env }) => {
      const b = s.rec.body as AnswerBody;
      return {
        id: s.rec.id, question: b.question, answer: b.answer, proof: b.proof, environment: s.rec.context.environment, env_match: round(env),
        weight: round(t.weight), confirmations: t.confirmations, contradictions: t.contradictions, age_days: Math.floor(ageDays(s)), fixes: s.rec.refs,
        neighbours: this.graph?.neighbours(s.rec.id, 3) ?? [],
      };
    });
  }
}

const round = (n: number) => Math.round(n * 100) / 100;
