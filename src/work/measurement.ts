import { z } from 'zod';
import type { StoredRecord } from '../store/records.js';

/**
 * Judging measured results (docs/X0X_HOME_TEST.md, docs/RESULTS.md). A measurement is not a witness: it is a spread
 * of numbers from many computers. So a claim like "eager degree 3 lowers idle upload" counts only when:
 * - both arms (the change and the baseline) have at least `min` different computers,
 * - they ran in the same hours (cohorts), so the network was the same for both: the equal-compute rule,
 * - and the result is published as the spread, not one number: median and the middle half (25th to 75th percentile).
 * "Separated" means the middle halves don't overlap; anything else is reported as "within the spread".
 */
export const MeasurementBody = z.object({
  test: z.string().max(40),
  minutes: z.number().min(1).max(60),
  arm: z.string().regex(/^[\w.-]{1,40}$/),
  os: z.string().max(20),
  cohort_hour: z.string().regex(/^\d{4}-\d\d-\d\dT\d\d:00Z$/),
  nat_type: z.string().max(20),
  metrics: z.record(z.number().finite()).refine((m) => Object.keys(m).length <= 40 && Object.keys(m).every((k) => /^[a-z0-9_]{1,40}$/.test(k)), 'metric names are short snake_case'),
});
export type MeasurementBody = z.infer<typeof MeasurementBody>;

export interface Spread { n: number; median: number; p25: number; p75: number }
const q = (s: number[], p: number) => { const i = (s.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i); return s[lo] + (s[hi] - s[lo]) * (i - lo); };
export function spread(xs: number[]): Spread | null {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  return s.length ? { n: s.length, median: q(s, 0.5), p25: q(s, 0.25), p75: q(s, 0.75) } : null;
}

/** Valid reports for one test: one per computer, arm and hour (the latest), as {operator, body}. */
export function reports(records: StoredRecord[], test: string) {
  const latest = new Map<string, { operator: string; at: string; b: MeasurementBody }>();
  for (const r of records) {
    if (r.rec.kind !== 'measurement') continue;
    const p = MeasurementBody.safeParse(r.rec.body);
    if (!p.success || p.data.test !== test) continue;
    const k = `${r.operatorId}|${p.data.arm}|${p.data.cohort_hour}`;
    const prev = latest.get(k);
    if (!prev || r.rec.created > prev.at) latest.set(k, { operator: r.operatorId, at: r.rec.created, b: p.data });
  }
  return [...latest.values()];
}

/** Every arm with its computers and the spread of each metric; plus NAT types, as counts. */
export function summary(records: StoredRecord[], test: string) {
  const rs = reports(records, test);
  const arms = new Map<string, typeof rs>();
  for (const r of rs) arms.set(r.b.arm, [...(arms.get(r.b.arm) ?? []), r]);
  const nat: Record<string, number> = {};
  for (const r of rs) nat[r.b.nat_type] = (nat[r.b.nat_type] ?? 0) + 1;
  return {
    test, sessions: rs.length, computers: new Set(rs.map((r) => r.operator)).size, nat_types: nat,
    arms: [...arms].map(([arm, list]) => {
      const keys = [...new Set(list.flatMap((r) => Object.keys(r.b.metrics)))].sort();
      return { arm, computers: new Set(list.map((r) => r.operator)).size, hours: [...new Set(list.map((r) => r.b.cohort_hour))].sort(), metrics: Object.fromEntries(keys.map((k) => [k, spread(list.map((r) => r.b.metrics[k]))])) };
    }),
  };
}

export interface Comparison { status: 'not_enough' | 'measured'; metric: string; arm: string; baseline: Spread | null; changed: Spread | null; change: number | null; separated: boolean; hours: number; detail: string }

/** One arm against the baseline on one metric, counting only hours where both ran. */
export function compare(records: StoredRecord[], test: string, arm: string, metric: string, opts: { min?: number; baseline?: string } = {}): Comparison {
  const min = opts.min ?? 5, base = opts.baseline ?? 'baseline';
  const rs = reports(records, test);
  const hoursOf = (a: string) => new Set(rs.filter((r) => r.b.arm === a).map((r) => r.b.cohort_hour));
  const shared = [...hoursOf(arm)].filter((h) => hoursOf(base).has(h));
  const pick = (a: string) => rs.filter((r) => r.b.arm === a && shared.includes(r.b.cohort_hour) && Number.isFinite(r.b.metrics[metric]));
  const A = pick(arm), B = pick(base);
  const ca = new Set(A.map((r) => r.operator)).size, cb = new Set(B.map((r) => r.operator)).size;
  const sa = spread(A.map((r) => r.b.metrics[metric])), sb = spread(B.map((r) => r.b.metrics[metric]));
  if (ca < min || cb < min || !sa || !sb) {
    return { status: 'not_enough', metric, arm, baseline: sb, changed: sa, change: null, separated: false, hours: shared.length, detail: `needs ${min} computers in each arm in the same hours; has ${ca} and ${cb}` };
  }
  const change = sb.median ? (sa.median - sb.median) / Math.abs(sb.median) : null;
  const separated = sa.p75 < sb.p25 || sa.p25 > sb.p75;
  const pct = change === null ? '' : `${change > 0 ? '+' : ''}${Math.round(change * 100)}%`;
  return { status: 'measured', metric, arm, baseline: sb, changed: sa, change, separated, hours: shared.length, detail: `${metric}: median ${sb.median.toFixed(2)} → ${sa.median.toFixed(2)} ${pct} over ${shared.length} shared hour${shared.length === 1 ? '' : 's'}, ${cb} and ${ca} computers; ${separated ? 'the middle halves don’t overlap' : 'within the spread'}` };
}
