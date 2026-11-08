import { randomBytes } from 'node:crypto';
import { Draft, signRecord, SignedRecord, verifyRecord } from '../core/record.js';
import { Signer } from '../core/identity.js';
import { OperatorClaim } from '../core/operator.js';
import { canonicalBytes } from '../core/canonical.js';
import { PrivacyBlockedError, scrub, ScrubOptions, personalDataCheck } from '../privacy/scrub.js';
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
  /** Closed-project mode: this identity reads but can never sign or publish anything. */
  readOnly?: boolean;
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
  readonly readOnly: boolean;
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
    this.readOnly = o.readOnly ?? false;
    this.bus?.onRecord((rec, sender) => this.ingest(rec, sender));
  }

  get agentId() { return this.signer.agentId; }

  /** Switch this node onto the network while it runs: a new signer (the x0x identity) and the gossip bus. */
  attach(signer: Signer, bus: RecordBus) {
    (this as { signer: Signer }).signer = signer;
    (this as { bus?: RecordBus }).bus = bus;
    bus.onRecord((rec, sender) => this.ingest(rec, sender));
  }
  get operatorId() { return this.operator?.user_id ?? this.signer.agentId; }

  ingest(rec: unknown, sender = 'local'): StoredRecord | null {
    const v = verifyRecord(rec, { root: (id) => this.store.get(id)?.rec });
    if (!v.ok) { this.rejected.push({ reason: v.reason, sender }); return null; }
    // Personal data never becomes permanent here: not stored, served, archived or passed on.
    const p = personalDataCheck(rec as SignedRecord);
    if (!p.ok) { this.rejected.push({ reason: `personal data: ${[...new Set(p.findings.map((f) => f.type))].join(', ')}`, sender }); return null; }
    return this.store.add(rec as SignedRecord, 'public');
  }

  /** Scrub and sign. Throws PrivacyBlockedError if anything private is found: blocked, not trimmed. */
  /** The agent this node is acting for (an MCP client such as Claude Code), stamped on what it signs. */
  actor?: { client: string; model?: string };

  async sign<B>(draft: Draft<B>): Promise<SignedRecord<B>> {
    if (this.readOnly) throw new ClosedIdentityError();
    if (this.actor && !(draft.context as { agent?: unknown }).agent) draft = { ...draft, context: { ...draft.context, agent: this.actor } };
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
    if (this.readOnly) throw new ClosedIdentityError();
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
    if (this.readOnly) throw new ClosedIdentityError();
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

  /** Send a record this node already holds (one saved while offline) out over the network. */
  async resend(rec: SignedRecord) { if (this.bus) await this.bus.publish(rec); }

  private async broadcast(rec: SignedRecord) {
    if (this.readOnly) throw new ClosedIdentityError();
    this.store.add(rec, 'public');
    this.store.setVisibility(rec.id, 'public');
    if (this.archive) await this.archive.put(canonicalBytes(rec));
    if (this.bus) await this.bus.publish(rec);
  }

  async close() { await this.bus?.close(); }
}

export class ClosedIdentityError extends Error {
  constructor() { super('refused: this is a closed-project identity in private read mode; it can read the ledger but never publish'); }
}
