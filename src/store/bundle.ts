import { canonicalBytes, decodeCanonical } from '../core/canonical.js';
import { SignedRecord, merkle, recordId } from '../core/record.js';
import { fromB64, fromHex, toB64, toHex } from '../util/bytes.js';

/**
 * Compact bundles: how Constellate stores records at rest, archives them and sends history to a
 * computer that's catching up (docs/STORAGE.md). Live records on the wire are unchanged.
 *
 *  - each author's 1,952-byte public key is stored once per bundle, not in every record;
 *  - keys, signatures and proofs are binary, not base64 text;
 *  - records covered by an author's batch_root carry a Merkle proof (~32 bytes per level)
 *    instead of their own 3,309-byte signature.
 * Opening a bundle rebuilds ordinary records; every one is verified again on the way in.
 */
export interface BundleV2 {
  v: 2;
  app: 'constellate';
  created: string;
  keys: Record<string, Uint8Array>;
  roots: SignedRecord[];
  records: Compact[];
}
type Compact = Omit<SignedRecord, 'author' | 'signature' | 'id' | 'batch'> & { sig?: Uint8Array; root?: string; i?: number; path?: Uint8Array[] };

/** A batch to apply: the author's signed batch_root and the ids it covers. */
export interface Batch { root: SignedRecord; ids: string[] }

/** Build a bundle. Records covered by one of `batches` drop their own signature for a proof. */
export function makeBundle(records: SignedRecord[], batches: Batch[] = []): Uint8Array {
  const proofs = new Map<string, { root: string; i: number; path: string[] }>();
  for (const b of batches) {
    const m = merkle(b.ids);
    if (m.root !== (b.root.body as { root: string }).root) throw new Error('batch root does not match its ids');
    for (const [id, p] of m.proofs) proofs.set(id, { root: b.root.id, ...p });
  }
  const keys: Record<string, Uint8Array> = {};
  const out: Compact[] = [];
  const rootIds = new Set(batches.map((b) => b.root.id));
  for (const r of records) {
    if (rootIds.has(r.id)) continue;
    keys[r.agent_id] ??= fromB64(r.author);
    const { author: _a, signature, id: _id, batch, ...core } = r;
    const p = proofs.get(r.id) ?? (batch && !signature ? batch : undefined);
    out.push(p ? { ...core, root: p.root, i: p.i, path: p.path.map(fromHex) } : { ...core, sig: fromB64(signature) });
  }
  const roots = [...new Map([...batches.map((b) => b.root), ...records.filter((r) => r.kind === 'batch_root')].map((r) => [r.id, r])).values()];
  return canonicalBytes({ v: 2, app: 'constellate', created: new Date().toISOString(), keys, roots, records: out } satisfies BundleV2);
}

/** Open a bundle back into ordinary records (roots first). Callers verify each one, e.g. via store.add. */
export function openBundle(bytes: Uint8Array): { roots: SignedRecord[]; records: SignedRecord[] } {
  const b = decodeCanonical<BundleV2>(bytes);
  if (b.v !== 2 || b.app !== 'constellate' || !Array.isArray(b.records)) throw new Error('not a Constellate bundle');
  const records: SignedRecord[] = [];
  for (const c of b.records) {
    const key = b.keys[c.agent_id];
    if (!key) continue;
    const { sig, root, i, path, ...core } = c;
    const author = toB64(key);
    const full = { ...core, author } as Omit<SignedRecord, 'id' | 'signature'>;
    const id = recordId(full as never); // the content hash of the core, exactly as signRecord computes it
    records.push(sig ? { ...full, id, signature: toB64(sig) } : { ...full, id, signature: '', batch: { root: root!, i: i!, path: (path ?? []).map(toHex) } });
  }
  return { roots: b.roots ?? [], records };
}

/** True when these bytes look like a v2 bundle (v1 snapshots are a different shape). */
export function isBundle(bytes: Uint8Array): boolean {
  try { const b = decodeCanonical<{ v?: number; app?: string }>(bytes); return b.v === 2 && b.app === 'constellate'; } catch { return false; }
}

