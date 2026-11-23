import { createHash, randomInt } from 'node:crypto';
import type { Hub } from '../hub/hub.js';
import type { StoredRecord } from '../store/records.js';
import { fromGraph6, hasClique, toGraph6 } from './combinatorics.js';

/**
 * Lent computers searching for witnesses, honestly (#32, docs/OPEN_PROBLEMS.md). A search is split into numbered
 * ranges of candidates, each tried by a stated, deterministic method (a kernel). A computer that searches a range
 * reports one fingerprint per block of candidates. The fingerprint is a hash of each candidate's score (how far it
 * is from being a witness), so it can only be produced by doing the work. Another identity re-runs a random sample
 * of the blocks: matching fingerprints make "nothing in this range" credible, and the range is credited; a mismatch
 * marks the report as skipped work and the range is searched again. A find becomes an ordinary answer, checked like
 * any other.
 */
export interface SearchSpec { kernel: string; range_size: number; block_size: number; params: Record<string, number> }
export interface Kernel {
  name: string;
  method: string;
  /** How many candidates the whole search has. */
  total(p: Record<string, number>): number;
  /** Candidate i's score (0 means it's a witness) and, for a witness, the answer in the step's check format. */
  score(p: Record<string, number>, i: number): { score: number; answer?: string };
}

/**
 * Van der Waerden colourings by the periodic method: a pattern of `period` bits coloured 1..n (colour(j) = bit
 * j mod period, two colours). Score: how many k-term progressions are one colour.
 */
export const vdwPeriodic: Kernel = {
  name: 'vdw_periodic', method: 'two-colourings of 1..n repeating a pattern of `period` bits; every pattern in order',
  total: (p) => 2 ** p.period,
  score(p, i) {
    const c = Array.from({ length: p.n }, (_, j) => (i >> (j % p.period)) & 1);
    let mono = 0;
    for (let d = 1; (p.k - 1) * d < p.n; d++) for (let a = 0; a + (p.k - 1) * d < p.n; a++) {
      let same = true;
      for (let t = 1; t < p.k && same; t++) same = c[a + t * d] === c[a];
      if (same) mono++;
    }
    return mono ? { score: mono } : { score: 0, answer: c.join('') };
  },
};

/** Ramsey graphs among circulant graphs on n vertices: candidate i is the connection set (bits of i over 1..n/2). */
export const ramseyCirculant: Kernel = {
  name: 'ramsey_circulant', method: 'circulant graphs on n vertices, every connection set in order',
  total: (p) => 2 ** Math.floor(p.n / 2),
  score(p, i) {
    const near = (d: number) => (i >> (Math.min(d, p.n - d) - 1)) & 1;
    const g6 = toGraph6(p.n, (a, b) => !!near(b - a));
    const g = fromGraph6(g6);
    if ('error' in g) return { score: 99 };
    const all = (1n << BigInt(p.n)) - 1n;
    const comp = g.adj.map((x, v) => all & ~x & ~(1n << BigInt(v)));
    const s = hasClique(g.adj, p.s) ? 1 : 0, t = hasClique(comp, p.t) ? 2 : 0;
    return s + t ? { score: s + t } : { score: 0, answer: g6 };
  },
};

export const KERNELS: Record<string, Kernel> = { [vdwPeriodic.name]: vdwPeriodic, [ramseyCirculant.name]: ramseyCirculant };

const blockDigest = (scores: number[]) => createHash('sha256').update(Buffer.from(new Uint32Array(scores).buffer)).digest('hex').slice(0, 16);

/** Search one range: a fingerprint per block, and any witness found. */
export function searchRange(spec: SearchSpec, range: number, opts: { skipBlocks?: Set<number> } = {}) {
  const k = KERNELS[spec.kernel];
  if (!k) throw new Error(`unknown search kernel ${spec.kernel}`);
  const from = range * spec.range_size, to = Math.min(k.total(spec.params), from + spec.range_size);
  const digests: string[] = [];
  let found: string | undefined;
  for (let b = from, bi = 0; b < to; b += spec.block_size, bi++) {
    const scores: number[] = [];
    if (opts.skipBlocks?.has(bi)) { digests.push('0'.repeat(16)); continue; } // only for tests: a lazy computer
    for (let i = b; i < Math.min(to, b + spec.block_size); i++) { const r = k.score(spec.params, i); scores.push(r.score); if (r.answer && !found) found = r.answer; }
    digests.push(blockDigest(scores));
  }
  return { from, to, digests, found };
}

export const rangesOf = (spec: SearchSpec) => Math.ceil((KERNELS[spec.kernel]?.total(spec.params) ?? 0) / spec.range_size);

interface ReportBody { problem: string; chunk: string; kernel: string; range: number; from: number; to: number; block_size: number; digests: string[]; found: boolean }
interface CheckBody { report: string; blocks: number[]; ok: boolean; mismatch?: number[] }

export class RangeSearch {
  constructor(private readonly hub: Hub) {}

  private reports(problem: string, chunk?: string) { return this.hub.node.store.referencing(problem, 'range_report').filter((r) => !chunk || (r.rec.body as unknown as ReportBody).chunk === chunk); }
  checks(report: string) { return this.hub.node.store.referencing(report, 'range_check'); }

  /** A report's standing: credited once another identity's spot check matched, struck when any spot check failed. */
  standing(report: StoredRecord): 'credited' | 'unchecked' | 'struck' {
    const cs = this.checks(report.rec.id).filter((c) => c.operatorId !== report.operatorId);
    if (cs.some((c) => !(c.rec.body as unknown as CheckBody).ok)) return 'struck';
    return cs.length ? 'credited' : 'unchecked';
  }

  /** The next range nobody has covered (a struck report doesn't count as covering it). */
  nextRange(problem: string, chunk: string, spec: SearchSpec): number | null {
    const covered = new Set(this.reports(problem, chunk).filter((r) => this.standing(r) !== 'struck').map((r) => (r.rec.body as unknown as ReportBody).range));
    for (let r = 0; r < rangesOf(spec); r++) if (!covered.has(r)) return r;
    return null;
  }

  /** Search a range and publish the report. Returns the witness when one turned up. */
  async search(problem: string, chunk: string, spec: SearchSpec, range: number, opts: { skipBlocks?: Set<number> } = {}) {
    const r = searchRange(spec, range, opts);
    const body: ReportBody = { problem, chunk, kernel: spec.kernel, range, from: r.from, to: r.to, block_size: spec.block_size, digests: r.digests, found: !!r.found };
    const { record } = await this.hub.node.submit({ kind: 'range_report', context: { task: `search ${chunk}: range ${range}`, domain: ['maths_physics'], environment: spec.kernel }, body: body as unknown as Record<string, unknown>, refs: [problem] }, { publish: true });
    return { report: record.id, found: r.found };
  }

  /** Re-run a random sample of another identity's blocks and sign what was found. */
  async spotCheck(reportId: string, spec: SearchSpec, sample = 3) {
    const rep = this.hub.node.store.get(reportId);
    if (!rep || rep.rec.kind !== 'range_report') throw new Error('no such report');
    if (rep.operatorId === this.hub.node.operatorId) throw new Error('a report is spot-checked by someone else');
    const b = rep.rec.body as unknown as ReportBody;
    const k = KERNELS[b.kernel];
    const n = b.digests.length;
    const blocks = [...new Set(Array.from({ length: Math.min(sample, n) }, () => randomInt(n)))];
    const mismatch: number[] = [];
    for (const bi of blocks) {
      const start = b.from + bi * b.block_size, end = Math.min(b.to, start + b.block_size);
      const scores: number[] = [];
      for (let i = start; i < end; i++) scores.push(k.score(spec.params, i).score);
      if (blockDigest(scores) !== b.digests[bi]) mismatch.push(bi);
    }
    const body: CheckBody = { report: reportId, blocks, ok: !mismatch.length, ...(mismatch.length ? { mismatch } : {}) };
    await this.hub.node.submit({ kind: 'range_check', context: { task: `spot check range ${b.range}`, domain: ['maths_physics'], environment: b.kernel }, body: body as unknown as Record<string, unknown>, refs: [reportId, b.problem] }, { publish: true });
    return body;
  }

  /** Reports by others that nobody else has checked yet: work for a lent computer. */
  unchecked(problem: string) {
    const me = this.hub.node.operatorId;
    return this.reports(problem).filter((r) => r.operatorId !== me && this.standing(r) === 'unchecked' && !this.checks(r.rec.id).some((c) => c.operatorId === me));
  }

  /** Candidates this operator searched in ranges that were credited: what an honest empty range earns. */
  credited(operator: string): number {
    return this.hub.node.store.ofKind('range_report' as never).filter((r) => r.operatorId === operator && this.standing(r) === 'credited')
      .reduce((n, r) => n + ((r.rec.body as unknown as ReportBody).to - (r.rec.body as unknown as ReportBody).from), 0);
  }

  /** Coverage of a step's search: ranges credited, unchecked, struck, and how many there are. */
  coverage(problem: string, chunk: string, spec: SearchSpec) {
    const rs = this.reports(problem, chunk);
    const by = { credited: 0, unchecked: 0, struck: 0 };
    for (const r of rs) by[this.standing(r)]++;
    return { ...by, ranges: rangesOf(spec), method: KERNELS[spec.kernel]?.method ?? spec.kernel };
  }
}
