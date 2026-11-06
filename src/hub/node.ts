import { randomBytes } from 'node:crypto';
import { Draft, signRecord, SignedRecord, verifyRecord } from '../core/record.js';
import { Signer } from '../core/identity.js';
import { OperatorClaim } from '../core/operator.js';
import { canonicalBytes } from '../core/canonical.js';
import { PrivacyBlockedError, scrub, ScrubOptions } from '../privacy/scrub.js';
import { RecordStore, StoredRecord } from '../store/records.js';
import { RecordBus } from '../transport/bus.js';
import { Archive } from '../store/archive.js';
import { toHex } from '../util/bytes.js';

export interface HubNodeOptions {
  signer: Signer;
  store?: RecordStore;
  bus?: RecordBus;
  archive?: Archive;
  operator?: OperatorClaim;
  privacy?: ScrubOptions;
  /** Preview mode (default on): records are signed and held locally until the operator/agent publishes them. */
  preview?: boolean;
}

export interface Preview {
  preview_id: string;
  record: SignedRecord;
  /** Exactly the bytes that would be broadcast, so operators see what leaves the machine. */
  wire_bytes: number;
}

/**
 * One hub node per agent machine: scrub -> sign -> hold (preview) -> publish.
 * Incoming gossip is verified before it touches the store.
 */
export class HubNode {
  readonly signer: Signer;
  readonly store: RecordStore;
  readonly bus?: RecordBus;
  readonly archive?: Archive;
  readonly operator?: OperatorClaim;
  readonly privacy: ScrubOptions;
  preview: boolean;
  private pending = new Map<string, string>(); // preview_id -> record id
  readonly rejected: { reason: string; sender: string }[] = [];

  constructor(o: HubNodeOptions) {
    this.signer = o.signer;
    this.store = o.store ?? new RecordStore();
    this.bus = o.bus;
    this.archive = o.archive;
    this.operator = o.operator;
    this.privacy = o.privacy ?? { level: 'standard' };
    this.preview = o.preview ?? true;
    this.bus?.onRecord((rec, sender) => this.ingest(rec, sender));
  }

  get agentId() { return this.signer.agentId; }
  get operatorId() { return this.operator?.user_id ?? this.signer.agentId; }

  ingest(rec: unknown, sender = 'local'): StoredRecord | null {
    const v = verifyRecord(rec);
    if (!v.ok) { this.rejected.push({ reason: v.reason, sender }); return null; }
    return this.store.add(rec as SignedRecord, 'public');
  }

  /** Scrub and sign. Throws PrivacyBlockedError if anything private is found: blocked, not trimmed. */
  async sign<B>(draft: Draft<B>): Promise<SignedRecord<B>> {
    const check = scrub({ context: draft.context, body: draft.body, evidence: draft.evidence ?? [], refs: draft.refs ?? [] }, this.privacy);
    if (!check.ok) throw new PrivacyBlockedError(check.findings);
    return signRecord(draft, this.signer, this.operator);
  }

  /**
   * Create a record. With preview on (default) and `publish` not forced, it is
   * stored privately and a preview is returned; call `publish(preview_id)` to broadcast.
   */
  async submit<B>(draft: Draft<B>, opts: { publish?: boolean; private?: boolean } = {}): Promise<{ record: SignedRecord<B>; published: boolean; preview?: Preview }> {
    const rec = await this.sign(draft);
    if (opts.private) { this.store.add(rec as SignedRecord, 'private'); return { record: rec, published: false }; }
    const publishNow = opts.publish ?? !this.preview;
    if (!publishNow) {
      this.store.add(rec as SignedRecord, 'private');
      const preview_id = toHex(new Uint8Array(randomBytes(8)));
      this.pending.set(preview_id, rec.id);
      return { record: rec, published: false, preview: { preview_id, record: rec as SignedRecord, wire_bytes: canonicalBytes(rec).length } };
    }
    await this.broadcast(rec as SignedRecord);
    return { record: rec, published: true };
  }

  async publish(previewOrRecordId: string): Promise<SignedRecord> {
    const id = this.pending.get(previewOrRecordId) ?? previewOrRecordId;
    const s = this.store.get(id);
    if (!s) throw new Error(`unknown preview or record: ${previewOrRecordId}`);
    if (s.rec.kind === 'memory') throw new Error('memory records are never broadcast');
    this.pending.delete(previewOrRecordId);
    await this.broadcast(s.rec);
    return s.rec;
  }

  /** Verify a record signed elsewhere (e.g. by a person's browser key) and broadcast it. */
  async relay(rec: SignedRecord) {
    const v = verifyRecord(rec);
    if (!v.ok) throw new Error(`rejected: ${v.reason}`);
    await this.broadcast(rec);
  }

  discard(previewId: string) {
    const id = this.pending.get(previewId);
    if (id) { this.store.remove(id); this.pending.delete(previewId); }
  }

  pendingPreviews(): Preview[] {
    return [...this.pending.entries()].map(([preview_id, id]) => {
      const rec = this.store.get(id)!.rec;
      return { preview_id, record: rec, wire_bytes: canonicalBytes(rec).length };
    });
  }

  private async broadcast(rec: SignedRecord) {
    this.store.add(rec, 'public');
    this.store.setVisibility(rec.id, 'public');
    if (this.archive) await this.archive.put(canonicalBytes(rec));
    if (this.bus) await this.bus.publish(rec);
  }

  async close() { await this.bus?.close(); }
}
