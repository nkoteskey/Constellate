import { mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, existsSync, rmSync, statSync } from 'node:fs';
import { openBundle, makeBundle, Batch } from './bundle.js';
import { join } from 'node:path';
import { canonicalBytes, decodeCanonical } from '../core/canonical.js';
import { RecordKind, SignedRecord, verifyRecord } from '../core/record.js';

export type Visibility = 'public' | 'private';
export interface StoredRecord { rec: SignedRecord; operatorId: string; visibility: Visibility; receivedAt: number }

/**
 * The node's local view of the ledger. Every record is verified on the way in,
 * so the rest of the hub can treat anything in here as authentic (not as true:
 * truth is what reputation and confirmations are for).
 */
export class RecordStore {
  private byId = new Map<string, StoredRecord>();
  private byRef = new Map<string, Set<string>>();
  private listeners = new Set<(s: StoredRecord) => void>();

  constructor(private readonly dir?: string) {
    if (dir) {
      // Compact segments first (public history packed by compact()), then single files. Within each,
      // batch roots and signed records go before records that lean on a batch root.
      mkdirSync(join(dir, 'segments'), { recursive: true });
      try { for (const id of JSON.parse(readFileSync(join(dir, 'segments', 'removed.json'), 'utf8')) as string[]) this.removed.add(id); } catch { /* none removed */ }
      for (const f of readdirSync(join(dir, 'segments')).filter((x) => x.endsWith('.bundle')).sort()) {
        try {
          const { roots, records } = openBundle(readFileSync(join(dir, 'segments', f)));
          for (const r of [...roots, ...records]) if (!this.removed.has(r.id)) this.add(r, 'public', false, `segments/${f}`);
        } catch { /* a damaged segment is skipped, never fatal */ }
      }
      for (const v of ['public', 'private'] as const) {
        mkdirSync(join(dir, v), { recursive: true });
        const recs = readdirSync(join(dir, v)).filter((f) => f.endsWith('.cbor')).map((f) => decodeCanonical<SignedRecord>(readFileSync(join(dir, v, f))));
        for (const rec of recs.sort((a, b) => Number(!a.signature) - Number(!b.signature))) this.add(rec, v, false);
      }
    }
  }

  /** Where each record lives on disk when it's packed in a segment (so compaction and pruning know). */
  private segmentOf = new Map<string, string>();
  /** Ids pruned from segments (segments are immutable, so removal is remembered instead). */
  private removed = new Set<string>();

  onAdd(cb: (s: StoredRecord) => void) { this.listeners.add(cb); return () => this.listeners.delete(cb); }

  /**
   * Pick up records another process on this computer saved into the same folder: an agent's own Constellate
   * MCP server shares this store with the app, and without this the app wouldn't see what the agent shared
   * until it restarted. Each one is verified like any record. Returns how many were new.
   */
  rescan(): number {
    if (!this.dir) return 0;
    let added = 0;
    for (const v of ['public', 'private'] as const) {
      let names: string[] = [];
      try { names = readdirSync(join(this.dir, v)); } catch { continue; }
      for (const f of names) {
        if (!f.endsWith('.cbor')) continue;
        const id = f.slice(0, -5);
        if (this.byId.has(id) || this.removed.has(id)) continue;
        try { if (this.add(decodeCanonical<SignedRecord>(readFileSync(join(this.dir, v, f))), v, false)) added++; } catch { /* still being written: next time */ }
      }
    }
    return added;
  }

  /** Returns the stored entry, or null if the record failed verification. */
  add(rec: SignedRecord, visibility: Visibility = 'public', persist = true, segment?: string): StoredRecord | null {
    const v = verifyRecord(rec, { root: (id) => this.byId.get(id)?.rec });
    if (!v.ok) return null;
    if (segment) this.segmentOf.set(rec.id, segment);
    const existing = this.byId.get(rec.id);
    if (existing) {
      if (existing.visibility === 'private' && visibility === 'public') this.setVisibility(rec.id, 'public');
      return existing;
    }
    const s: StoredRecord = { rec, operatorId: v.operatorId, visibility, receivedAt: Date.now() };
    this.byId.set(rec.id, s);
    for (const r of rec.refs) { if (!this.byRef.has(r)) this.byRef.set(r, new Set()); this.byRef.get(r)!.add(rec.id); }
    if (persist && this.dir) writeFileSync(join(this.dir, visibility, `${rec.id}.cbor`), canonicalBytes(rec));
    for (const l of this.listeners) l(s);
    return s;
  }

  setVisibility(id: string, visibility: Visibility) {
    const s = this.byId.get(id);
    if (!s || s.visibility === visibility) return;
    if (this.dir) {
      const from = join(this.dir, s.visibility, `${id}.cbor`);
      if (existsSync(from)) renameSync(from, join(this.dir, visibility, `${id}.cbor`));
    }
    s.visibility = visibility;
  }

  remove(id: string) {
    const s = this.byId.get(id);
    if (!s) return;
    this.byId.delete(id);
    for (const r of s.rec.refs) this.byRef.get(r)?.delete(id);
    if (this.dir) rmSync(join(this.dir, s.visibility, `${id}.cbor`), { force: true });
    if (this.dir && this.segmentOf.has(id)) {
      this.removed.add(id); this.segmentOf.delete(id);
      writeFileSync(join(this.dir, 'segments', 'removed.json'), JSON.stringify([...this.removed]));
    }
  }

  /**
   * Pack loose public record files into one compact segment (keys once, binary, batch proofs) and
   * delete the files. Private records stay as they are. Returns what moved and the bytes before/after.
   */
  compact(batches: Batch[] = []): { records: number; before: number; after: number; segment: string | null } {
    if (!this.dir) return { records: 0, before: 0, after: 0, segment: null };
    const loose = this.all().filter((s) => s.visibility === 'public' && !this.segmentOf.has(s.rec.id) && existsSync(join(this.dir!, 'public', `${s.rec.id}.cbor`)));
    if (!loose.length) return { records: 0, before: 0, after: 0, segment: null };
    const before = loose.reduce((n, s) => n + statSync(join(this.dir!, 'public', `${s.rec.id}.cbor`)).size, 0);
    const need = new Set(loose.map((s) => s.rec.id));
    const bytes = makeBundle(loose.map((s) => s.rec), batches.filter((b) => b.ids.some((id) => need.has(id))).map((b) => ({ root: b.root, ids: b.ids })));
    const name = `${new Date().toISOString().replace(/[:.]/g, '-')}.bundle`;
    const tmp = join(this.dir, 'segments', `${name}.tmp`);
    writeFileSync(tmp, bytes);
    renameSync(tmp, join(this.dir, 'segments', name)); // the segment is complete before any file goes
    for (const s of loose) { this.segmentOf.set(s.rec.id, `segments/${name}`); rmSync(join(this.dir, 'public', `${s.rec.id}.cbor`), { force: true }); }
    return { records: loose.length, before, after: bytes.length, segment: name };
  }

  /** Bytes on disk, split by where they live. */
  diskUsage(): { loose: number; segments: number; private: number } {
    if (!this.dir) return { loose: 0, segments: 0, private: 0 };
    const sum = (sub: string, ext: string) => { try { return readdirSync(join(this.dir!, sub)).filter((f) => f.endsWith(ext)).reduce((n, f) => n + statSync(join(this.dir!, sub, f)).size, 0); } catch { return 0; } };
    return { loose: sum('public', '.cbor'), segments: sum('segments', '.bundle'), private: sum('private', '.cbor') };
  }

  get(id: string) { return this.byId.get(id); }
  all(): StoredRecord[] { return [...this.byId.values()]; }
  ofKind<K extends RecordKind>(kind: K, opts: { includePrivate?: boolean } = {}): StoredRecord[] {
    return this.all().filter((s) => s.rec.kind === kind && (opts.includePrivate || s.visibility === 'public'));
  }
  /** Records that reference `id` (confirmations, answers fixing a failure, checkpoints of a problem...). */
  referencing(id: string, kind?: RecordKind): StoredRecord[] {
    return [...(this.byRef.get(id) ?? [])].map((x) => this.byId.get(x)!).filter((s) => s && (!kind || s.rec.kind === kind));
  }
  get size() { return this.byId.size; }
}
