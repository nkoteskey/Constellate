import { canonicalBytes, decodeCanonical } from '../core/canonical.js';
import { SignedRecord } from '../core/record.js';
import { Archive } from '../store/archive.js';
import { HubNode } from './node.js';
import { X0xClient } from '../x0x/client.js';
import { utf8, fromUtf8 } from '../util/bytes.js';
import { makeBundle, openBundle } from '../store/bundle.js';
import type { Storage } from './storage.js';

/** v1 listed one archived chunk per record; v2 lists compact bundles (many records per paid upload). */
interface Manifest { agent_id: string; updated: string; records?: { id: string; addr: string }[]; bundles?: { addr: string; count: number; to: string }[] }

/**
 * Live state and permanence. Each node keeps a manifest of its published
 * records: the records themselves are archived permanently (Autonomi), the
 * manifest is archived too, and a Pointer named after the agent always
 * resolves to the latest manifest. The pointer's current address is also
 * mirrored into the agent's x0x KV store for fast live reads.
 * A late joiner catches up from pointers without anyone replaying gossip.
 */
export class LiveState {
  private storeId?: string;
  constructor(private readonly node: HubNode, private readonly archive: Archive, private readonly x0x?: X0xClient, private readonly storage?: () => Storage) {}

  static pointerName(agentId: string) { return `constellate/agent/${agentId}/manifest`; }

  /**
   * Archive what this computer published since the last checkpoint as ONE compact bundle (one paid upload,
   * not one per record), append it to the manifest, and point this agent's Pointer at the new manifest.
   */
  async checkpoint(): Promise<string> {
    const prev = await this.manifest(this.node.agentId);
    const since = prev?.bundles?.at(-1)?.to ?? '';
    const done = new Set((prev?.records ?? []).map((r) => r.id));
    await this.storage?.().batchOwn();
    const mine = this.node.store.all().filter((s) => s.visibility === 'public' && s.rec.agent_id === this.node.agentId && s.rec.kind !== 'memory' && s.rec.created > since && !done.has(s.rec.id));
    const bundles = [...(prev?.bundles ?? [])];
    if (mine.length) {
      const recs = mine.map((s) => s.rec);
      const ids = new Set(recs.map((r) => r.id));
      const batches = (this.storage?.().batches() ?? []).filter((b) => b.ids.some((id) => ids.has(id)));
      const addr = await this.archive.put(makeBundle(recs, batches));
      bundles.push({ addr, count: recs.length, to: recs.map((r) => r.created).sort().at(-1)! });
    }
    const m: Manifest = { agent_id: this.node.agentId, updated: new Date().toISOString(), ...(prev?.records?.length ? { records: prev.records } : {}), bundles };
    const addr = await this.archive.put(canonicalBytes(m));
    await this.archive.setPointer(LiveState.pointerName(this.node.agentId), addr);
    if (this.x0x) {
      this.storeId ??= (await this.x0x.createStore('constellate-live', `constellate/v1/live/${this.node.agentId}`)).id;
      await this.x0x.storePut(this.storeId, 'manifest', utf8(addr), 'text/plain');
    }
    return addr;
  }

  private async manifest(agentId: string): Promise<Manifest | null> {
    const addr = await this.archive.getPointer(LiveState.pointerName(agentId)).catch(() => null);
    if (!addr) return null;
    const mb = await this.archive.get(addr);
    return mb ? decodeCanonical<Manifest>(mb) : null;
  }

  /** Pull everything a known agent has archived. Every record is re-verified on ingest. */
  async catchUp(agentId: string): Promise<{ fetched: number; rejected: number }> {
    const m = await this.manifest(agentId);
    if (!m) return { fetched: 0, rejected: 0 };
    let fetched = 0, rejected = 0;
    for (const r of m.records ?? []) { // v1: one chunk per record
      if (this.node.store.get(r.id)) continue;
      const b = await this.archive.get(r.addr);
      if (!b) continue;
      const rec = decodeCanonical<SignedRecord>(b);
      if (rec.agent_id !== agentId || rec.id !== r.id || !this.node.ingest(rec, `archive:${agentId}`)) rejected++; else fetched++;
    }
    for (const bm of m.bundles ?? []) { // v2: compact bundles
      const b = await this.archive.get(bm.addr);
      if (!b) continue;
      const { roots, records } = openBundle(b);
      for (const r of roots) if (!this.node.store.get(r.id)) this.node.ingest(r, `archive:${agentId}`);
      for (const r of records) {
        if (this.node.store.get(r.id)) continue;
        if (r.agent_id !== agentId || !this.node.ingest(r, `archive:${agentId}`)) rejected++; else fetched++;
      }
    }
    return { fetched, rejected };
  }

  /** Read another agent's live manifest address from its x0x KV store (needs its store id and owner). */
  async liveManifestAddress(storeId: string, owner: string): Promise<string | null> {
    if (!this.x0x) return null;
    await this.x0x.joinStore(storeId, owner).catch(() => {});
    const v = await this.x0x.storeGet(storeId, 'manifest');
    return v ? fromUtf8(v) : null;
  }
}
