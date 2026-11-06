import { RecordStore, StoredRecord } from '../store/records.js';

/** Weighting interface used by every ranked lookup. Phase 2 provides the real implementation. */
export interface TrustModel {
  /** Evidence weight of a record, >= 0. */
  weight(s: StoredRecord): number;
  /** Explainable summary used in tool responses. */
  explain(s: StoredRecord): { weight: number; confirmations: number; contradictions: number; author_reputation: number };
}

export class FlatTrust implements TrustModel {
  constructor(private readonly store: RecordStore) {}
  weight() { return 1; }
  explain(s: StoredRecord) {
    return { weight: 1, confirmations: this.store.referencing(s.rec.id, 'confirmation').length, contradictions: this.store.referencing(s.rec.id, 'contradiction').length, author_reputation: 0 };
  }
}
