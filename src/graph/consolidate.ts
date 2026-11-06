import { Hub } from '../hub/hub.js';
import { ModelRunner } from '../contributor/models.js';
import { canonicalBytes, sha256Hex } from '../core/canonical.js';
import { titleOf } from './graph.js';
import { utf8 } from '../util/bytes.js';

/**
 * Consolidation ("sleep"): periodically distil dense clusters of related
 * records into a short signed summary that links to its sources. Summaries are
 * archived permanently, with a Pointer per cluster to the latest summary, so the
 * network gets wiser, not just bigger. A model writes the summary when one is
 * attached; otherwise an extractive summary is used.
 */
export class Consolidator {
  private timer?: NodeJS.Timeout;
  constructor(private readonly hub: Hub, private readonly runner?: ModelRunner, private readonly opts: { minSize?: number; maxMembers?: number } = {}) {}

  static clusterKey(members: string[]) { return sha256Hex(utf8([...members].sort()[0])).slice(0, 32); }
  static pointerName(key: string) { return `constellate/cluster/${key}`; }

  private latestSummary(key: string) {
    return this.hub.node.store.ofKind('summary').filter((s) => (s.rec.body as { cluster: string }).cluster === key).sort((a, b) => b.rec.created.localeCompare(a.rec.created))[0];
  }

  async sleep(): Promise<{ summarised: number; skipped: number }> {
    let summarised = 0, skipped = 0;
    for (const members of this.hub.graph.clusters(this.opts.minSize ?? 4)) {
      const key = Consolidator.clusterKey(members);
      const prev = this.latestSummary(key);
      const covered = new Set(prev ? (prev.rec.body as { members: string[] }).members : []);
      if (members.every((m) => covered.has(m))) { skipped++; continue; }
      const use = members.slice(0, this.opts.maxMembers ?? 80);
      const lines = use.map((id) => { const s = this.hub.node.store.get(id)!; return `- [${s.rec.kind}] ${titleOf(s)}${s.rec.kind === 'failure' ? ` → ${(s.rec.body as { error_summary: string }).error_summary}` : s.rec.kind === 'answer' ? ` → ${(s.rec.body as { answer: string }).answer}` : ''}`; });
      const realms = [...new Set(use.map((id) => this.hub.graph.realmOf(id)))].filter((r) => r !== 'unknown');
      const summary = this.runner
        ? await this.runner.run(`Summarise what these related records together teach, in at most 5 sentences. Plain words, no new claims.\n${lines.join('\n')}`, { maxTokens: 500 })
        : extractive(use.map((id) => this.hub.node.store.get(id)!.rec.kind), lines);
      const domain = [...new Set(use.flatMap((id) => this.hub.node.store.get(id)!.rec.context.domain))].slice(0, 12);
      const { record } = await this.hub.node.submit({
        kind: 'summary',
        context: { task: `consolidate ${use.length} related records`, domain, environment: this.runner?.id ?? 'extractive' },
        body: { cluster: key, title: titleOf(this.hub.node.store.get(use[0])!), summary: summary.slice(0, 2000), members: use, realms, supersedes: prev?.rec.id ?? null },
        refs: use,
      }, { publish: true });
      const addr = await this.hub.archive.put(canonicalBytes(record));
      await this.hub.archive.setPointer(Consolidator.pointerName(key), addr);
      summarised++;
    }
    return { summarised, skipped };
  }

  /** The scheduled job: sleep every `everyMs` (default 6 h). */
  schedule(everyMs = 6 * 3600_000) { this.timer = setInterval(() => void this.sleep().catch(() => {}), everyMs); this.timer.unref?.(); return () => clearInterval(this.timer); }
}

function extractive(kinds: string[], lines: string[]) {
  const n = (k: string) => kinds.filter((x) => x === k).length;
  return `${lines.length} related records: ${n('failure')} failures, ${n('answer')} answers, ${n('checkpoint')} checkpoints. Key points:\n${lines.slice(0, 6).join('\n')}`;
}
