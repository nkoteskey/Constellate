import { canonicalBytes, decodeCanonical } from '../core/canonical.js';
import { SignedRecord } from '../core/record.js';
import { X0xClient } from '../x0x/client.js';

/** How signed records move between machines. Production: x0x gossip. Tests: in-memory. */
export interface RecordBus {
  publish(rec: SignedRecord): Promise<void>;
  onRecord(cb: (rec: unknown, sender: string) => void): void;
  close(): Promise<void>;
}

export const RECORD_TOPIC = 'constellate/v1/records';

export class X0xBus implements RecordBus {
  private stop?: () => void;
  private subId?: string;
  private cbs: ((rec: unknown, sender: string) => void)[] = [];
  private constructor(private readonly client: X0xClient, private readonly topic: string) {}

  static async connect(client: X0xClient, topic = RECORD_TOPIC): Promise<X0xBus> {
    const bus = new X0xBus(client, topic);
    bus.subId = await client.subscribe(topic);
    bus.stop = client.events((m) => {
      if (m.topic !== topic) return;
      let rec: unknown;
      try { rec = decodeCanonical(m.payload); } catch { return; }
      for (const cb of bus.cbs) cb(rec, m.sender);
    });
    await new Promise((r) => setTimeout(r, 50)); // let the SSE stream attach
    return bus;
  }
  async publish(rec: SignedRecord) { await this.client.publish(this.topic, canonicalBytes(rec)); }
  onRecord(cb: (rec: unknown, sender: string) => void) { this.cbs.push(cb); }
  async close() { this.stop?.(); if (this.subId) await this.client.unsubscribe(this.subId).catch(() => {}); }
}

export class MemoryNetwork {
  readonly buses = new Set<MemoryBus>();
  readonly wire: Uint8Array[] = [];
  bus(name = 'node'): MemoryBus { const b = new MemoryBus(this, name); this.buses.add(b); return b; }
}

export class MemoryBus implements RecordBus {
  private cbs: ((rec: unknown, sender: string) => void)[] = [];
  constructor(private readonly net: MemoryNetwork, readonly name: string) {}
  async publish(rec: SignedRecord) {
    const bytes = canonicalBytes(rec);
    this.net.wire.push(bytes);
    for (const b of this.net.buses) if (b !== this) for (const cb of b.cbs) cb(decodeCanonical(bytes), this.name);
  }
  onRecord(cb: (rec: unknown, sender: string) => void) { this.cbs.push(cb); }
  async close() { this.net.buses.delete(this); }
}
