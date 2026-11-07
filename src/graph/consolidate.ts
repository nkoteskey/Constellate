import { Hub } from '../hub/hub.js';
import { ModelRunner } from '../contributor/models.js';
import { canonicalBytes, sha256Hex } from '../core/canonical.js';
import { titleOf } from './graph.js';
import { utf8 } from '../util/bytes.js';
import type { StoredRecord } from '../store/records.js';

/**
 * Consolidation ("sleep"): periodically distil dense clusters of related
 * records into a short signed summary that links to its sources. Summaries are
 * archived permanently, with a Pointer per cluster to the latest summary, so the
 * network gets wiser, not just bigger. A model writes the summary when one is
 * attached; otherwise an extractive summary is used.
 */
export class Consolidator {
  private timer?: NodeJS.Timeout;
  constructor(private readonly hub: Hub, private readonly runner?: ModelRunner, private readonly opts: { minSize?: number; maxSize?: number; maxMembers?: number; written?: WrittenSummaries } = {}) {}

  /** A cluster's identity across rebuilds: the hash of its members' sources. */
  static sourceKey(recs: StoredRecord[]) { return sha256Hex(utf8(recs.map((s) => s.rec.evidence[0] ?? s.rec.id).sort().join('\n'))).slice(0, 24); }

  static clusterKey(members: string[]) { return sha256Hex(utf8([...members].sort()[0])).slice(0, 32); }
  static pointerName(key: string) { return `constellate/cluster/${key}`; }

  private latestSummary(key: string) {
    return this.hub.node.store.ofKind('summary').filter((s) => (s.rec.body as { cluster: string }).cluster === key).sort((a, b) => b.rec.created.localeCompare(a.rec.created))[0];
  }

  async sleep(): Promise<{ summarised: number; skipped: number }> {
    let summarised = 0, skipped = 0;
    const minSize = this.opts.minSize ?? 4, maxSize = this.opts.maxSize ?? 40;
    const groups: string[][] = [];
    for (const all of this.hub.graph.clusters(minSize)) {
      // Only lessons are distilled: what failed and what fixed it. Votes and work traffic are not knowledge.
      const lessons = all.filter((id) => LESSONS.has(this.hub.node.store.get(id)?.rec.kind ?? ''));
      // A sprawling component is many topics chained together: split it into topic-sized groups.
      groups.push(...(lessons.length > maxSize ? this.split(lessons, maxSize) : [lessons]));
    }
    for (const members of groups) {
      if (members.length < minSize) continue;
      if (members.length > maxSize) { skipped++; continue; }
      const key = Consolidator.clusterKey(members);
      const prev = this.latestSummary(key);
      const covered = new Set(prev ? (prev.rec.body as { members: string[] }).members : []);
      if (members.every((m) => covered.has(m))) { skipped++; continue; }
      const use = members.slice(0, this.opts.maxMembers ?? 80);
      const lines = use.map((id) => { const s = this.hub.node.store.get(id)!; return `- [${s.rec.kind}] ${titleOf(s)}${s.rec.kind === 'failure' ? ` → ${(s.rec.body as { error_summary: string }).error_summary}` : s.rec.kind === 'answer' ? ` → ${(s.rec.body as { answer: string }).answer}` : ''}`; });
      const realms = [...new Set(use.map((id) => this.hub.graph.realmOf(id)))].filter((r) => r !== 'unknown');
      const pre = this.opts.written?.[Consolidator.sourceKey(use.map((id) => this.hub.node.store.get(id)!))];
      const summary = pre ? pre.summary : this.runner
        ? await this.runner.run(`Summarise what these related records together teach, in at most 5 sentences. Plain words, no new claims.\n${lines.join('\n')}`, { maxTokens: 500 })
        : extractive(use.map((id) => this.hub.node.store.get(id)!));
      const domain = [...new Set(use.flatMap((id) => this.hub.node.store.get(id)!.rec.context.domain))].slice(0, 12);
      const { record } = await this.hub.node.submit({
        kind: 'summary',
        context: { task: `consolidate ${use.length} related records`, domain, environment: pre ? 'written summary (reviewed, data/seed/cluster-summaries.json)' : this.runner?.id ?? 'extractive' },
        // A topic page (src/graph/pages.ts): rules with evidence and status, traps, the fix verbatim, links.
        body: { cluster: key, title: pre?.title ?? headline(use.map((id) => this.hub.node.store.get(id)!)), summary: summary.slice(0, 2000), members: use, realms, supersedes: prev?.rec.id ?? null, ...this.hub.pages.build(use, key) },
        refs: use,
      }, { publish: true });
      const addr = await this.hub.archive.put(canonicalBytes(record));
      await this.hub.archive.setPointer(Consolidator.pointerName(key), addr);
      summarised++;
    }
    return { summarised, skipped };
  }

  /**
   * Split a large component into communities by label propagation over its
   * strongest links (deterministic: fixed order, ties to the smaller label).
   * Anything still too big is cut along a breadth-first walk, which keeps
   * neighbours together.
   */
  split(members: string[], maxSize: number): string[][] {
    const inside = new Set(members);
    // Stable across rebuilds: order and break ties by each lesson's source, not its (time-dependent) id; count links, not decaying weights.
    const key = new Map(members.map((id) => { const r = this.hub.node.store.get(id)?.rec; return [id, r?.evidence[0] ?? id]; }));
    const adj = new Map(members.map((id) => [id, this.hub.graph.neighbours(id, 64).filter((n) => inside.has(n.id) && n.link !== 'contradicts').map((n) => ({ ...n, weight: 1 }))]));
    const label = new Map(members.map((id) => [id, key.get(id)!]));
    const order = [...members].sort((a, b) => key.get(a)!.localeCompare(key.get(b)!));
    for (let round = 0; round < 20; round++) {
      let changed = false;
      for (const id of order) {
        const score = new Map<string, number>();
        for (const n of adj.get(id)!) score.set(label.get(n.id)!, (score.get(label.get(n.id)!) ?? 0) + n.weight);
        let best = label.get(id)!, bestScore = score.get(best) ?? 0;
        for (const [l, v] of score) if (v > bestScore || (v === bestScore && l < best)) { best = l; bestScore = v; }
        if (best !== label.get(id)) { label.set(id, best); changed = true; }
      }
      if (!changed) break;
    }
    const byLabel = new Map<string, string[]>();
    for (const id of order) { const l = label.get(id)!; byLabel.set(l, [...(byLabel.get(l) ?? []), id]); }
    const out: string[][] = [];
    for (const group of byLabel.values()) {
      if (group.length <= maxSize) { out.push(group.sort()); continue; }
      // Breadth-first from the best-connected lesson, cut into neighbourly chunks.
      const g = new Set(group);
      const start = [...group].sort((a, b) => adj.get(b)!.length - adj.get(a)!.length || key.get(a)!.localeCompare(key.get(b)!))[0];
      const seen = new Set([start]); const walk = [start];
      for (let i = 0; i < walk.length; i++) for (const n of adj.get(walk[i])!) if (g.has(n.id) && !seen.has(n.id)) { seen.add(n.id); walk.push(n.id); }
      for (const id of group) if (!seen.has(id)) walk.push(id);
      const parts = Math.ceil(walk.length / maxSize), size = Math.ceil(walk.length / parts);
      for (let i = 0; i < walk.length; i += size) out.push(walk.slice(i, i + size).sort());
    }
    return out;
  }

  /** The scheduled job: sleep every `everyMs` (default 6 h). */
  schedule(everyMs = 6 * 3600_000) {
    void this.sleep().catch(() => {}); this.timer = setInterval(() => void this.sleep().catch(() => {}), everyMs); this.timer.unref?.(); return () => clearInterval(this.timer); }
}

/** Summaries written ahead of time for known clusters, keyed by Consolidator.sourceKey. */
export type WrittenSummaries = Record<string, { title: string; summary: string }>;

const LESSONS = new Set(['failure', 'answer']);
const clip = (t: string, n = 180) => { const x = t.replace(/\s+/g, ' ').trim(); return x.length > n ? `${x.slice(0, n - 1).trimEnd()}…` : x; };

/** The cluster's name: its earliest failure, the thing everything else builds on. */
function headline(recs: StoredRecord[]) {
  const first = [...recs].sort((a, b) => a.rec.created.localeCompare(b.rec.created)).find((s) => s.rec.kind === 'failure') ?? recs[0];
  return clip(titleOf(first), 140);
}

/** Without a model: say plainly what went wrong and what fixed it, quoting the records. */
function extractive(recs: StoredRecord[]) {
  const byTime = [...recs].sort((a, b) => a.rec.created.localeCompare(b.rec.created) || a.rec.id.localeCompare(b.rec.id));
  const fails = byTime.filter((s) => s.rec.kind === 'failure').map((s) => s.rec.body as { approach: string; error_summary: string });
  const fixes = byTime.filter((s) => s.rec.kind === 'answer').map((s) => s.rec.body as { answer: string; headline?: string });
  const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
  const parts = [`${recs.length} linked lessons: ${n(fails.length, 'thing that went wrong', 'things that went wrong')} and ${n(fixes.length, 'fix', 'fixes')}.`];
  if (fails.length) parts.push(`What went wrong: ${fails.slice(0, 3).map((f) => clip(f.approach)).join(' / ')}`);
  if (fixes.length) parts.push(`What fixed it: ${fixes.slice(0, 3).map((f) => clip(f.headline ?? f.answer)).join(' / ')}`);
  return parts.join('\n');
}
