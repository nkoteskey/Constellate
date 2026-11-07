import { mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, existsSync, rmSync } from 'node:fs';
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
      for (const v of ['public', 'private'] as const) {
        mkdirSync(join(dir, v), { recursive: true });
        for (const f of readdirSync(join(dir, v))) {
          if (!f.endsWith('.cbor')) continue;
          const rec = decodeCanonical<SignedRecord>(readFileSync(join(dir, v, f)));
          this.add(rec, v, false);
        }
      }
    }
  }

  onAdd(cb: (s: StoredRecord) => void) { this.listeners.add(cb); return () => this.listeners.delete(cb); }

  /** Returns the stored entry, or null if the record failed verification. */
  add(rec: SignedRecord, visibility: Visibility = 'public', persist = true): StoredRecord | null {
    const v = verifyRecord(rec);
    if (!v.ok) return null;
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
