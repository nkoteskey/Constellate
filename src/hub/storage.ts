import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import type { Hub } from './hub.js';
import { SignedRecord, signRecord, merkle } from '../core/record.js';
import { canonicalBytes } from '../core/canonical.js';
import { makeBundle, openBundle, Batch } from '../store/bundle.js';
import { mcpMode } from '../mcp/mode.js';

/**
 * Storage and its cost (docs/STORAGE.md): how much this computer holds, packing it compactly, sharing
 * history with computers that are catching up, and (opt-in) letting old records from others go.
 */
const DAY = 86_400_000;
/** Kinds a person or agent comes back to: never pruned, wherever they came from. */
const KEEP = new Set(['problem', 'checkpoint', 'summary', 'skill', 'proposal', 'position', 'argument', 'ruling', 'profile', 'batch_root', 'identity_link', 'payout_address', 'gallery', 'piece']);

export class Storage {
  private readonly batchesFile: string;
  constructor(private readonly hub: Hub, home = process.env.CONSTELLATE_HOME ?? join(homedir(), '.constellate')) {
    this.batchesFile = join(home, 'records', 'batches.json');
  }

  /** The batch roots this computer signed, with the ids each covers (needed to rebuild proofs). */
  batches(): Batch[] {
    try {
      const saved = JSON.parse(readFileSync(this.batchesFile, 'utf8')) as { root: string; ids: string[] }[];
      return saved.map((b) => ({ root: this.hub.node.store.get(b.root)?.rec, ids: b.ids })).filter((b): b is Batch => !!b.root);
    } catch { return []; }
  }

  /** Sign one batch root over this computer's public records that no root covers yet. */
  async batchOwn(): Promise<SignedRecord | null> {
    const covered = new Set(this.batches().flatMap((b) => b.ids));
    const mine = this.hub.node.store.all().filter((s) => s.visibility === 'public' && s.rec.agent_id === this.hub.node.agentId && s.rec.kind !== 'batch_root' && s.rec.kind !== 'memory' && !covered.has(s.rec.id));
    if (mine.length < 2) return null; // a batch of one saves nothing
    const ids = mine.map((s) => s.rec.id);
    const m = merkle(ids);
    const times = mine.map((s) => s.rec.created).sort();
    const root = await signRecord({ kind: 'batch_root', context: { task: 'batch', domain: ['storage'], environment: '' }, body: { root: m.root, count: m.proofs.size, from: times[0], to: times.at(-1) } }, this.hub.node.signer);
    this.hub.node.store.add(root, 'public');
    await this.hub.node.relay(root).catch(() => {}); // peers learn it, so they can check proofs later
    const saved = (() => { try { return JSON.parse(readFileSync(this.batchesFile, 'utf8')) as { root: string; ids: string[] }[]; } catch { return []; } })();
    mkdirSync(dirname(this.batchesFile), { recursive: true });
    writeFileSync(this.batchesFile, JSON.stringify([...saved, { root: root.id, ids: [...m.proofs.keys()] }]));
    return root;
  }

  /** Batch this computer's records, then pack loose public records into a compact segment. */
  async compact() {
    await this.batchOwn();
    return this.hub.node.store.compact(this.batches());
  }

  /** History to share: public records (no private memory), newest first, with the roots their proofs need. */
  exportBundle(opts: { since?: string; max?: number; realms?: string[] } = {}): { bytes: Uint8Array; records: number } {
    const recs = this.hub.node.store.all()
      .filter((s) => s.visibility === 'public' && s.rec.kind !== 'memory' && (!opts.since || s.rec.created > opts.since))
      .filter((s) => !opts.realms?.length || opts.realms.some((r) => s.rec.context.domain.includes(r)) || KEEP.has(s.rec.kind))
      .sort((a, b) => b.rec.created.localeCompare(a.rec.created))
      .slice(0, opts.max ?? 5000)
      .map((s) => s.rec);
    const need = new Set(recs.filter((r) => r.batch).map((r) => r.batch!.root));
    const roots = [...need].map((id) => this.hub.node.store.get(id)?.rec).filter((r): r is SignedRecord => !!r);
    const ids = new Set(recs.map((r) => r.id));
    const mine = this.batches().filter((b) => b.ids.some((id) => ids.has(id)));
    return { bytes: makeBundle([...roots, ...recs], mine), records: recs.length };
  }

  /** Take in a bundle from a peer or the archive: roots first, every record verified and privacy-checked. */
  importBundle(bytes: Uint8Array, from: string): { added: number; known: number; refused: number } {
    const { roots, records } = openBundle(bytes);
    let added = 0, known = 0, refused = 0;
    for (const r of [...roots, ...records]) {
      if (this.hub.node.store.get(r.id)) { known++; continue; }
      if (this.hub.node.ingest(r, from)) added++; else refused++;
    }
    return { added, known, refused };
  }

  /**
   * Let old records from others go (opt-in). Never this computer's own, never the kinds people come back to,
   * never anything a kept record points at. Dry run unless `apply`.
   */
  prune(opts: { keepDays: number; apply?: boolean; now?: number }) {
    const cutoff = new Date((opts.now ?? Date.now()) - opts.keepDays * DAY).toISOString();
    const store = this.hub.node.store;
    const all = store.all();
    const pinned = new Set<string>();
    for (const s of all) if (KEEP.has(s.rec.kind) || s.rec.agent_id === this.hub.node.agentId) { pinned.add(s.rec.id); for (const r of s.rec.refs) pinned.add(r); for (const m of ((s.rec.body as { members?: string[] }).members ?? [])) pinned.add(m); }
    const go = all.filter((s) => s.visibility === 'public' && !pinned.has(s.rec.id) && s.rec.created < cutoff);
    const bytes = go.reduce((n, s) => n + canonicalBytes(s.rec).length, 0);
    if (opts.apply) for (const s of go) store.remove(s.rec.id);
    return { records: go.length, bytes, applied: !!opts.apply, cutoff };
  }

  /** What this computer holds and what it costs, in plain numbers. */
  status() {
    const all = this.hub.node.store.all();
    const pub = all.filter((s) => s.visibility === 'public');
    const disk = this.hub.node.store.diskUsage();
    const own = pub.filter((s) => s.rec.agent_id === this.hub.node.agentId).length;
    const sample = pub.slice(-500);
    const wire = sample.length ? Math.round(sample.reduce((n, s) => n + canonicalBytes(s.rec).length, 0) / sample.length) : 0;
    const packed = sample.length ? Math.round(makeBundle(sample.map((s) => s.rec), this.batches()).length / sample.length) : 0;
    return {
      records: { total: all.length, public: pub.length, private: all.length - pub.length, own, authors: new Set(pub.map((s) => s.rec.agent_id)).size, batch_roots: pub.filter((s) => s.rec.kind === 'batch_root').length },
      disk: { ...disk, total: disk.loose + disk.segments + disk.private },
      bytes_per_record: { as_sent: wire, packed },
      archive: this.hub.archive.constructor.name === 'AutonomiArchive' ? 'autonomi' : 'local',
      mcp: { mode: mcpMode(), note: mcpMode() === 'lean' ? '5 tools, about 1,300 tokens per agent session' : 'all tools, about 6,000 tokens per agent session' },
    };
  }
}
