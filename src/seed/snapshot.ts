import { mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { canonicalBytes, decodeCanonical } from '../core/canonical.js';
import { SignedRecord } from '../core/record.js';
import { RecordStore } from '../store/records.js';
import { LocalSigner } from '../core/identity.js';
import { personalDataCheck } from '../privacy/scrub.js';

/**
 * Private read mode for closed projects: download a snapshot of the PUBLIC
 * ledger once, then serve every search locally with nothing sent to the
 * network. Closed-project agents use a separate identity that cannot publish.
 */
export interface Snapshot { v: 1; created: string; records: SignedRecord[] }

export function exportSnapshot(store: RecordStore): Uint8Array {
  const records = store.all().filter((s) => s.visibility === 'public' && s.rec.kind !== 'memory').map((s) => s.rec);
  return canonicalBytes({ v: 1, created: new Date().toISOString(), records } satisfies Snapshot);
}

/** Loads a snapshot; every record is re-verified, so a tampered snapshot can't inject anything. */
export function importSnapshot(bytes: Uint8Array, store: RecordStore, persist = false) {
  const snap = decodeCanonical<Snapshot>(bytes);
  if (snap.v !== 1 || !Array.isArray(snap.records)) throw new Error('not a Constellate snapshot');
  let ok = 0, rejected = 0;
  for (const r of snap.records) { if (personalDataCheck(r).ok && store.add(r, 'public', persist)) ok++; else rejected++; }
  return { ok, rejected, created: snap.created };
}

/** The one network call in private mode: fetching the snapshot itself, done explicitly by the operator. */
export async function pullSnapshot(url: string, file: string) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`snapshot download failed: HTTP ${r.status}`);
  const bytes = new Uint8Array(await r.arrayBuffer());
  importSnapshot(bytes, new RecordStore()); // validate before saving
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, bytes);
  return bytes.length;
}

/** A closed-project identity: separate from any publishing key, and marked so it can never publish. */
export function closedIdentity(home: string): LocalSigner {
  const path = join(home, 'closed.key');
  if (!existsSync(path)) {
    const seed = new Uint8Array(32);
    crypto.getRandomValues(seed);
    mkdirSync(home, { recursive: true });
    writeFileSync(path, JSON.stringify({ kind: 'constellate-closed-key', alg: 'ml-dsa-65', seed: Buffer.from(seed).toString('hex'), can_publish: false }), { mode: 0o600 });
    chmodSync(path, 0o600);
  }
  const j = JSON.parse(readFileSync(path, 'utf8'));
  if (j.kind !== 'constellate-closed-key') throw new Error('not a closed-project key');
  return LocalSigner.generate(Buffer.from(j.seed, 'hex'));
}
