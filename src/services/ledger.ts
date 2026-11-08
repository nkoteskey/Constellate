import { z } from 'zod';
import { HubNode } from '../hub/node.js';
import { StoredRecord } from '../store/records.js';
import { bm25, envSimilarity } from './search.js';
import { TrustModel } from './trust.js';
import { hashInputs } from '../privacy/scrub.js';
import { RecordContext } from '../core/record.js';
import type { KnowledgeGraph } from '../graph/graph.js';
import { reproduction, reproductionFactor } from './reproduce.js';

export const FailureBody = z.object({
  approach: z.string().max(600),
  outcome: z.enum(['error', 'wrong_result', 'too_slow', 'too_costly']),
  error_summary: z.string().max(600),
  confidence: z.number().min(0).max(1).default(0.7),
});
export type FailureBody = z.infer<typeof FailureBody>;

/**
 * One piece of evidence behind an answer's claim: where it is (a link, a record id or a citation), the exact place
 * inside it, and whether it supports or contradicts the claim. `origin` names the original study or run when the
 * source only retells another, so ten articles retelling one study count as one independent origin, not ten.
 */
export const ClaimSource = z.object({
  source: z.string().min(1).max(400),
  locator: z.string().min(1).max(200).describe('Section, table, page, row, line or test name.'),
  relation: z.enum(['supports', 'contradicts']),
  note: z.string().max(400).optional(),
  origin: z.string().max(400).optional(),
});
export type ClaimSource = z.infer<typeof ClaimSource>;

export const CLAIM_KINDS = ['observation', 'inference', 'hypothesis'] as const;
export const CLAIM_STATUSES = ['supported', 'refuted', 'contested', 'unresolved'] as const;

/**
 * An answer. The claim fields are optional, so short answers stay short, but when given they must agree with
 * each other (the same bookkeeping rules as the Research Loop method's run checker):
 * supported needs a supporting source, refuted a contradicting one, contested both; an inference or hypothesis
 * says its limits. Unresolved is a legitimate answer: it keeps the uncertainty visible instead of hiding it.
 */
export const AnswerBody = z.object({
  question: z.string().max(600),
  answer: z.string().max(4000),
  proof: z.object({ type: z.enum(['test', 'benchmark', 'proof', 'reproduction', 'citation']), detail: z.string().max(1000) }),
  claim: z.enum(CLAIM_KINDS).optional(),
  status: z.enum(CLAIM_STATUSES).optional(),
  sources: z.array(ClaimSource).max(12).optional(),
  limits: z.string().max(600).optional(),
}).superRefine((b, ctx) => {
  const rel = new Set((b.sources ?? []).map((s) => s.relation));
  const need = (ok: boolean, message: string) => { if (!ok) ctx.addIssue({ code: z.ZodIssueCode.custom, message }); };
  if (b.status === 'supported') need(rel.has('supports'), 'a supported claim needs at least one source that supports it');
  if (b.status === 'refuted') need(rel.has('contradicts'), 'a refuted claim needs at least one source that contradicts it');
  if (b.status === 'contested') need(rel.has('supports') && rel.has('contradicts'), 'a contested claim needs a source on each side');
  if (b.claim === 'inference' || b.claim === 'hypothesis') need(!!b.limits?.trim(), `an ${b.claim === 'inference' ? 'inference' : 'hypothesis'} needs its limits: where it hasn't been tested`);
});

/** How many independent origins stand behind a claim, counting sources that retell the same original once. */
export function independentOrigins(sources: ClaimSource[] = [], relation: ClaimSource['relation'] = 'supports') {
  const key = (s: string) => s.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/[#?].*$/, '').replace(/\/+$/, '');
  return new Set(sources.filter((s) => s.relation === relation).map((s) => key(s.origin || s.source))).size;
}
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
      return [s.rec.context.task, s.rec.context.domain.join(' '), b.approach, b.original, b.error_summary, b.question, b.answer, s.rec.context.environment].filter(Boolean).join(' ');
    };
    const rel = bm25(query, recs.map((s) => ({ id: s.rec.id, text: text(s), tags: s.rec.context.domain })), { tags: domain });
    const scored = recs.filter((s) => rel.has(s.rec.id)).map((s) => {
      const t = this.trust.explain(s);
      const env = environment ? envSimilarity(environment, s.rec.context.environment) : 0;
      // Independent reproduction (other computers, other model families) lifts a record; disputes pull it down.
      const rep = reproduction(this.node.store, s);
      const score = rel.get(s.rec.id)! * (0.25 + this.trust.weight(s)) * (1 + env) * (this.graph ? this.graph.nodeFactor(s.rec.id) : 1) * reproductionFactor(rep);
      return { s, t, env, score, rep };
    });
    return scored.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  searchFailures(query: string, opts: { domain?: string[]; environment?: string; limit?: number } = {}) {
    return this.rank('failure', query, opts.domain, opts.environment, opts.limit ?? 5).map(({ s, t, env, rep }) => {
      const b = s.rec.body as FailureBody;
      const fixes = this.node.store.referencing(s.rec.id, 'answer').map((a) => ({ a, r: reproduction(this.node.store, a) }))
        .sort((x, y) => reproductionFactor(y.r) - reproductionFactor(x.r) || this.trust.weight(y.a) - this.trust.weight(x.a)).slice(0, 3);
      return {
        id: s.rec.id, task: s.rec.context.task, approach: b.approach, outcome: b.outcome, error_summary: b.error_summary,
        original: (b as { original?: string }).original, applies_when: (b as { applies_when?: string }).applies_when,
        environment: s.rec.context.environment, env_match: round(env), confidence: b.confidence,
        weight: round(t.weight), confirmations: t.confirmations, contradictions: t.contradictions, confirmed: rep.label, age_days: Math.floor(ageDays(s)),
        fixed_by: fixes.map(({ a }) => a.rec.id),
        // The fixes themselves, best reproduced first, so the agent can try one and report back (fix_tried).
        fixes: fixes.map(({ a, r }) => { const ab = a.rec.body as AnswerBody & { headline?: string }; return { id: a.rec.id, fix: (ab.headline ?? ab.answer).slice(0, 300), confirmed: r.label, disputed_on_computers: r.disputed_by.computers }; }),
        neighbours: this.graph?.neighbours(s.rec.id, 3) ?? [],
      };
    });
  }

  lookupAnswers(question: string, opts: { domain?: string[]; environment?: string; limit?: number } = {}) {
    return this.rank('answer', question, opts.domain, opts.environment, opts.limit ?? 3).map(({ s, t, env, rep }) => {
      const b = s.rec.body as AnswerBody;
      return {
        id: s.rec.id, question: b.question, answer: b.answer, headline: (b as { headline?: string }).headline, proof: b.proof, source: s.rec.evidence[0] ?? null,
        // Licensed seed data says so on every result (data/seed/LICENSES).
        ...((b as { license?: string }).license ? { license: (b as { license?: string }).license, attribution: (b as { attribution?: string }).attribution } : {}), environment: s.rec.context.environment, env_match: round(env),
        weight: round(t.weight), confirmations: t.confirmations, contradictions: t.contradictions, confirmed: rep.label, disputed_on_computers: rep.disputed_by.computers, age_days: Math.floor(ageDays(s)), fixes: s.rec.refs,
        neighbours: this.graph?.neighbours(s.rec.id, 3) ?? [],
        ...(b.claim || b.status || b.sources?.length ? {
          claim: { kind: b.claim ?? null, status: b.status ?? null, limits: b.limits ?? null, sources: b.sources ?? [],
            independent: { supporting: independentOrigins(b.sources, 'supports'), contradicting: independentOrigins(b.sources, 'contradicts') } },
        } : {}),
      };
    });
  }

  /** What the network learned: consolidated summaries ("sleep"), each linking to the records it distils. */
  learned(query: string, opts: { limit?: number } = {}) {
    const sums = this.node.store.ofKind('summary');
    const latest = new Map<string, StoredRecord>();
    for (const s of sums) { const k = (s.rec.body as { cluster: string }).cluster; const p = latest.get(k); if (!p || p.rec.created < s.rec.created) latest.set(k, s); }
    const docs = [...latest.values()].filter((s) => !(s.rec.body as { retired?: boolean }).retired);
    const rel = bm25(query, docs.map((s) => { const b = s.rec.body as { title: string; summary: string }; return { id: s.rec.id, text: `${b.title} ${b.summary} ${s.rec.context.domain.join(' ')}`, tags: s.rec.context.domain }; }));
    return docs.filter((s) => rel.has(s.rec.id)).sort((a, b) => rel.get(b.rec.id)! - rel.get(a.rec.id)!).slice(0, opts.limit ?? 2).map((s) => {
      const b = s.rec.body as { title: string; summary: string; members: string[]; realms: string[]; rules?: unknown[]; traps?: unknown[]; fix?: unknown };
      return { id: s.rec.id, topic: (s.rec.body as { cluster: string }).cluster, title: b.title, summary: b.summary, sources: b.members.length, realms: b.realms, domain: s.rec.context.domain, members: b.members.slice(0, 5), rules: b.rules ?? [], traps: b.traps ?? [], fix: b.fix ?? null, ...topicContext(this.node.store, b.members) };
    });
  }
}

const round = (n: number) => Math.round(n * 100) / 100;

/** Which projects a distilled topic comes from, and its newest lesson's date: "x0x · Sep 2026" tells a reader what it's about. */
export function topicContext(store: { get(id: string): StoredRecord | undefined }, members: string[]) {
  const envs = members.map((id) => store.get(id)?.rec.context.environment ?? '');
  const projects = [...new Set(envs.map((e) => e.match(/^[\w.-]+\/([\w.-]+)/)?.[1] ?? (e.match(/^(\w+) \([^)]+\): AI-generated paper/)?.[1] ? `${e.match(/^(\w+) /)![1]} papers` : undefined)).filter((x): x is string => !!x))];
  const dates = envs.map((e) => e.match(/(\d{4}-\d{2}-\d{2})/)?.[1]).filter((x): x is string => !!x).sort();
  return { projects, latest: dates.at(-1) ?? null };
}
