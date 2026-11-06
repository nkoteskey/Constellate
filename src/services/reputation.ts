import { RecordStore, StoredRecord } from '../store/records.js';
import { TrustModel } from './trust.js';
import { envSimilarity } from './search.js';

export interface ReputationOptions {
  /** Operators this node trusts a priori: its own operator, x0x contacts marked trusted, deposit holders. */
  preTrusted: () => string[];
  /** Days for an unconfirmed record to lose half its weight. */
  halfLifeDays?: number;
  now?: () => number;
}

const ALPHA = 0.15;          // restart probability towards pre-trusted operators
const ITER = 25;
const NEWCOMER = 0.01;       // weight of an unproven identity
const NEWCOMER_CAP = 0.2;    // all unproven confirmers together can add at most this
const GLOBAL_SPILL = 0.1;    // how much reputation from other domains counts

/**
 * Trust and anti-poisoning.
 * - Reputation per operator, per domain, computed EigenTrust-style from
 *   confirmations, seeded only from pre-trusted operators. A Sybil clique
 *   that only confirms itself receives no inflow, so it stays near zero.
 * - Confirmations, not votes: one operator counts once per record, however many keys it has.
 * - Agreeing with trusted confirmers (co-confirming) earns weight: confirming is useful work.
 * - Contradictions stay visible; they only subtract when environments match.
 * - Decay: weight halves every `halfLifeDays` since the last confirmation.
 */
export class Reputation implements TrustModel {
  private cache?: { size: number; at: number; rep: Map<string, Map<string, number>> };
  private readonly halfLife: number;
  private readonly now: () => number;

  constructor(private readonly store: RecordStore, private readonly opts: ReputationOptions) {
    this.halfLife = opts.halfLifeDays ?? 180;
    this.now = opts.now ?? Date.now;
  }

  private domainsOf(s: StoredRecord) { return s.rec.context.domain.length ? s.rec.context.domain.map((d) => d.toLowerCase()) : ['general']; }

  /** Distinct-operator confirmations of a record (author's own operator excluded). */
  private confirmers(s: StoredRecord, kind: 'confirmation' | 'contradiction' = 'confirmation') {
    const out = new Map<string, StoredRecord>();
    for (const c of this.store.referencing(s.rec.id, kind)) {
      if (c.operatorId === s.operatorId) continue;
      const prev = out.get(c.operatorId);
      if (!prev || Date.parse(c.rec.created) > Date.parse(prev.rec.created)) out.set(c.operatorId, c);
    }
    return out;
  }

  private compute() {
    if (this.cache && this.cache.size === this.store.size && this.now() - this.cache.at < 5_000) return this.cache.rep;
    const edges = new Map<string, Map<string, Map<string, number>>>(); // domain -> from -> to -> w
    const ops = new Set<string>(this.opts.preTrusted());
    const add = (d: string, from: string, to: string, w: number) => {
      if (from === to) return;
      ops.add(from); ops.add(to);
      if (!edges.has(d)) edges.set(d, new Map());
      const m = edges.get(d)!;
      if (!m.has(from)) m.set(from, new Map());
      m.get(from)!.set(to, (m.get(from)!.get(to) ?? 0) + w);
    };
    for (const s of this.store.all()) {
      if (s.rec.kind === 'confirmation' || s.rec.kind === 'contradiction' || s.visibility !== 'public') continue;
      ops.add(s.operatorId);
      const conf = [...this.confirmers(s).keys()];
      for (const d of [...this.domainsOf(s), '*']) {
        for (const c of conf) add(d, c, s.operatorId, 1);
        // co-confirmation: confirmers vouch for each other a little
        for (const a of conf) for (const b of conf) if (a !== b) add(d, a, b, 0.5 / conf.length);
      }
    }
    const pre = this.opts.preTrusted();
    const rep = new Map<string, Map<string, number>>();
    for (const [d, m] of edges) rep.set(d, eigentrust([...ops], m, pre));
    this.cache = { size: this.store.size, at: this.now(), rep };
    return rep;
  }

  /** Operator reputation in a domain, 0..1 (pre-trusted operators sit at the top). */
  reputation(operator: string, domain = '*'): number {
    if (this.opts.preTrusted().includes(operator)) return 1;
    const r = this.compute();
    const d = r.get(domain.toLowerCase())?.get(operator) ?? 0;
    const g = r.get('*')?.get(operator) ?? 0;
    return Math.min(1, d * (1 - GLOBAL_SPILL) + g * GLOBAL_SPILL);
  }

  private repIn(op: string, s: StoredRecord) {
    return Math.max(...this.domainsOf(s).map((d) => this.reputation(op, d)));
  }

  weight(s: StoredRecord): number { return this.explain(s).weight; }

  explain(s: StoredRecord) {
    const conf = this.confirmers(s);
    const contra = this.confirmers(s, 'contradiction');
    let w = NEWCOMER + this.repIn(s.operatorId, s);
    let newcomer = 0;
    let last = Date.parse(s.rec.created);
    for (const [op, c] of conf) {
      const r = this.repIn(op, c);
      if (r < 0.05) newcomer += NEWCOMER; else w += r;
      last = Math.max(last, Date.parse(c.rec.created));
    }
    w += Math.min(newcomer, NEWCOMER_CAP);
    for (const [op, c] of contra) {
      // Contradiction is a feature: only an operator who saw the same conditions can subtract.
      if (envSimilarity(c.rec.context.environment, s.rec.context.environment) >= 0.5) w -= this.repIn(op, c);
    }
    const ageDays = Math.max(0, (this.now() - last) / 86_400_000);
    w = Math.max(0, w) * Math.pow(0.5, ageDays / this.halfLife);
    return { weight: w, confirmations: conf.size, contradictions: contra.size, author_reputation: Math.round(this.repIn(s.operatorId, s) * 1000) / 1000 };
  }

  /** Profile for the reputation tool / Me view. */
  profile(operator: string) {
    const domains = new Set<string>();
    for (const s of this.store.all()) if (s.operatorId === operator) for (const d of this.domainsOf(s)) domains.add(d);
    return { operator, overall: round(this.reputation(operator)), by_domain: Object.fromEntries([...domains].map((d) => [d, round(this.reputation(operator, d))])) };
  }
}

function eigentrust(ops: string[], m: Map<string, Map<string, number>>, pre: string[]): Map<string, number> {
  const idx = new Map(ops.map((o, i) => [o, i]));
  const n = ops.length;
  const p = new Float64Array(n);
  const preIn = pre.filter((o) => idx.has(o));
  for (const o of preIn) p[idx.get(o)!] = 1 / preIn.length;
  let t = Float64Array.from(p);
  const rows = [...m.entries()].map(([from, tos]) => {
    const total = [...tos.values()].reduce((a, b) => a + b, 0);
    return { i: idx.get(from)!, outs: [...tos.entries()].map(([to, w]) => [idx.get(to)!, w / total] as const) };
  });
  for (let k = 0; k < ITER; k++) {
    const next = new Float64Array(n);
    let leaked = 0;
    const hasOut = new Set(rows.map((r) => r.i));
    for (const r of rows) for (const [j, w] of r.outs) next[j] += (1 - ALPHA) * t[r.i] * w;
    for (let i = 0; i < n; i++) if (!hasOut.has(i)) leaked += (1 - ALPHA) * t[i];
    for (let i = 0; i < n; i++) next[i] += (ALPHA + leaked) * p[i];
    t = next;
  }
  // Scale so the best non-pre-trusted operator lands near 1 relative to the pre-trusted mass.
  const out = new Map<string, number>();
  const base = preIn.length ? 1 / preIn.length : 1;
  ops.forEach((o, i) => out.set(o, Math.min(1, t[i] / (base * ALPHA))));
  return out;
}

const round = (n: number) => Math.round(n * 1000) / 1000;
