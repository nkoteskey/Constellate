import { canonicalBytes, decodeCanonical } from '../core/canonical.js';
import { SignedRecord } from '../core/record.js';
import { Archive } from '../store/archive.js';
import { HubNode } from './node.js';
import { X0xClient } from '../x0x/client.js';
import { utf8, fromUtf8 } from '../util/bytes.js';

interface Manifest { agent_id: string; updated: string; records: { id: string; addr: string }[] }

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
  constructor(private readonly node: HubNode, private readonly archive: Archive, private readonly x0x?: X0xClient) {}

  static pointerName(agentId: string) { return `constellate/agent/${agentId}/manifest`; }

  async checkpoint(): Promise<string> {
    const mine = this.node.store.all().filter((s) => s.visibility === 'public' && s.rec.agent_id === this.node.agentId && s.rec.kind !== 'memory');
    const records = [];
    for (const s of mine) records.push({ id: s.rec.id, addr: await this.archive.put(canonicalBytes(s.rec)) });
    const m: Manifest = { agent_id: this.node.agentId, updated: new Date().toISOString(), records };
    const addr = await this.archive.put(canonicalBytes(m));
    await this.archive.setPointer(LiveState.pointerName(this.node.agentId), addr);
    if (this.x0x) {
      this.storeId ??= (await this.x0x.createStore('constellate-live', `constellate/v1/live/${this.node.agentId}`)).id;
      await this.x0x.storePut(this.storeId, 'manifest', utf8(addr), 'text/plain');
    }
    return addr;
  }

  /** Pull everything a known agent has published. Every record is re-verified on ingest. */
  async catchUp(agentId: string): Promise<{ fetched: number; rejected: number }> {
    const addr = await this.archive.getPointer(LiveState.pointerName(agentId));
    if (!addr) return { fetched: 0, rejected: 0 };
    const mb = await this.archive.get(addr);
    if (!mb) return { fetched: 0, rejected: 0 };
    const m = decodeCanonical<Manifest>(mb);
    let fetched = 0, rejected = 0;
    for (const r of m.records) {
      if (this.node.store.get(r.id)) continue;
      const b = await this.archive.get(r.addr);
      if (!b) continue;
      const rec = decodeCanonical<SignedRecord>(b);
      if (rec.agent_id !== agentId || rec.id !== r.id || !this.node.ingest(rec, `archive:${agentId}`)) rejected++; else fetched++;
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
