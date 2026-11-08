import { z } from 'zod';
import { canonicalBytes, sha256Hex } from './canonical.js';
import { peerIdFromPublicKey, Signer, verifyExternal, PUBLIC_KEY_BYTES } from './identity.js';
import { fromB64, fromHex, toB64 } from '../util/bytes.js';
import { OperatorClaim, verifyOperatorClaim } from './operator.js';

/** Signing context for every Constellate record (x0x external-sign DST context). */
export const RECORD_SIGN_CONTEXT = 'constellate.record.v1';
export const MAX_RECORD_BYTES = 60 * 1024;

/**
 * One envelope for every service. A failure, a skill run and an answer
 * are the same kind of object underneath; only `body` changes.
 */
export const RECORD_KINDS = [
  // phase 1: shared memory
  'failure', 'answer',
  // phase 2: trust
  'confirmation', 'contradiction',
  // phase 3: work engine
  'problem', 'checkpoint', 'task_result', 'verification',
  // phase 4: collective
  'proposal', 'vote', 'pledge', 'constitution_check', 'position', 'argument', 'rating',
  // phase 5: economy
  'skill', 'skill_run', 'review_request', 'review', 'receipt',
  // phase 7: private memory (body is ciphertext)
  'memory',
  // amendment 1: knowledge graph, hand-offs, help, court, conversation
  'link', 'use', 'summary', 'handoff', 'help_request', 'ruling', 'message',
  // human layer: team challenges, art galleries (curated, not scored), an optional real-world identity link
  'challenge', 'gallery', 'piece', 'curation', 'identity_link',
  // money: where a contributor wants their earnings paid (an EVM address, signed by them)
  'payout_address',
  // people and agents: a public profile in the x0x directory (handle, what they do, what they're open to)
  'profile',
  // storage: one signature over many of an author's records (a Merkle root of their ids), so archives and
  // catch-up bundles needn't carry a 3.3 KB signature per record (docs/STORAGE.md)
  'batch_root',
] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];

export const ContextSchema = z.object({
  task: z.string().max(500),
  domain: z.array(z.string().max(48)).max(12),
  environment: z.string().max(500).default(''),
  inputs_hash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  /** Which agent made it, e.g. { client: 'Claude Code', model: 'claude-sonnet-4.5' } (src/mcp/server.ts sets it). */
  agent: z.object({ client: z.string().max(60), model: z.string().max(80).optional() }).optional(),
});
export type RecordContext = z.infer<typeof ContextSchema>;

export interface RecordCore<B = Record<string, unknown>> {
  v: 1;
  kind: RecordKind;
  author: string; // ML-DSA-65 public key, base64
  agent_id: string; // x0x AgentId derived from author
  operator?: OperatorClaim;
  created: string; // ISO 8601
  context: RecordContext;
  body: B;
  evidence: string[];
  refs: string[];
}

export interface SignedRecord<B = Record<string, unknown>> extends RecordCore<B> {
  id: string; // sha256 of canonical(core): content hash of the record
  signature: string; // base64 ML-DSA-65 over the id, under RECORD_SIGN_CONTEXT ('' when covered by a batch root)
  /** Instead of its own signature: covered by the author's batch_root record (Merkle proof of this id). */
  batch?: BatchProof;
}

/** Where a record sits in its author's batch: the root record's id, the leaf index and the sibling hashes. */
export interface BatchProof { root: string; i: number; path: string[] }

/** Merkle tree over record ids (sorted), domain-separated leaves and nodes. */
const leafHash = (id: string) => sha256Hex(new Uint8Array([0, ...fromHex(id)]));
const nodeHash = (a: string, b: string) => sha256Hex(new Uint8Array([1, ...fromHex(a), ...fromHex(b)]));
export function merkle(ids: string[]): { root: string; proofs: Map<string, { i: number; path: string[] }> } {
  const leaves = [...new Set(ids)].sort();
  if (!leaves.length) throw new Error('nothing to batch');
  let level = leaves.map(leafHash);
  const paths = leaves.map(() => [] as string[]);
  let pos = leaves.map((_, i) => i);
  while (level.length > 1) {
    const next: string[] = [];
    for (let k = 0; k < level.length; k += 2) next.push(k + 1 < level.length ? nodeHash(level[k], level[k + 1]) : level[k]);
    leaves.forEach((_, j) => { const p = pos[j]; const sib = p % 2 ? p - 1 : p + 1; if (sib < level.length) paths[j].push(level[sib]); pos[j] = Math.floor(p / 2); });
    level = next;
  }
  return { root: level[0], proofs: new Map(leaves.map((id, j) => [id, { i: j, path: paths[j] }])) };
}
export function merkleRootFrom(id: string, i: number, path: string[], count: number): string {
  let h = leafHash(id), p = i, width = count, k = 0;
  while (width > 1) {
    const last = p === width - 1 && width % 2 === 1; // promoted without a sibling at this level
    if (!last) { const sib = path[k++]; if (sib === undefined) return ''; h = p % 2 ? nodeHash(sib, h) : nodeHash(h, sib); }
    p = Math.floor(p / 2); width = Math.ceil(width / 2);
  }
  return k === path.length ? h : '';
}

export interface Draft<B = Record<string, unknown>> {
  kind: RecordKind;
  context: RecordContext;
  body: B;
  evidence?: string[];
  refs?: string[];
  created?: string;
}

export function recordId(core: RecordCore<unknown>): string {
  return sha256Hex(canonicalBytes(core));
}

export async function signRecord<B>(draft: Draft<B>, signer: Signer, operator?: OperatorClaim): Promise<SignedRecord<B>> {
  const core: RecordCore<B> = {
    v: 1,
    kind: draft.kind,
    author: toB64(signer.publicKey),
    agent_id: signer.agentId,
    operator,
    created: draft.created ?? new Date().toISOString(),
    context: ContextSchema.parse(draft.context),
    body: draft.body,
    evidence: draft.evidence ?? [],
    refs: draft.refs ?? [],
  };
  if (!operator) delete core.operator;
  const id = recordId(core as RecordCore<unknown>);
  const sig = await signer.sign(RECORD_SIGN_CONTEXT, fromHex(id));
  const rec = { ...core, id, signature: toB64(sig) };
  const size = canonicalBytes(rec).length;
  if (size > MAX_RECORD_BYTES) throw new Error(`record too large (${size} bytes > ${MAX_RECORD_BYTES})`);
  return rec;
}

export type VerifyResult = { ok: true; operatorId: string } | { ok: false; reason: string };

/** Distrust by default: a record is only accepted if every check passes. A record covered by a batch root
 *  verifies only when `root` can supply that root record (same author, signed, and the proof leads to it). */
export function verifyRecord(rec: unknown, opts: { root?: (id: string) => SignedRecord<unknown> | undefined } = {}): VerifyResult {
  if (!rec || typeof rec !== 'object') return { ok: false, reason: 'not an object' };
  const r = rec as SignedRecord<unknown>;
  if (r.v !== 1) return { ok: false, reason: 'unsupported version' };
  if (!RECORD_KINDS.includes(r.kind)) return { ok: false, reason: `unknown kind ${String(r.kind)}` };
  if (typeof r.author !== 'string' || typeof r.signature !== 'string' || typeof r.id !== 'string') return { ok: false, reason: 'missing fields' };
  if (!ContextSchema.safeParse(r.context).success) return { ok: false, reason: 'bad context' };
  if (!Array.isArray(r.evidence) || !Array.isArray(r.refs)) return { ok: false, reason: 'bad evidence/refs' };
  if (Number.isNaN(Date.parse(r.created))) return { ok: false, reason: 'bad timestamp' };
  let pk: Uint8Array;
  try { pk = fromB64(r.author); } catch { return { ok: false, reason: 'bad author key' }; }
  if (pk.length !== PUBLIC_KEY_BYTES) return { ok: false, reason: 'bad author key length' };
  if (peerIdFromPublicKey(pk) !== r.agent_id) return { ok: false, reason: 'agent_id does not match author key' };
  const { id, signature, batch, ...core } = r;
  if (recordId(core as RecordCore<unknown>) !== id) return { ok: false, reason: 'id is not the content hash' };
  if (signature) {
    if (!verifyExternal(pk, RECORD_SIGN_CONTEXT, fromHex(id), fromB64(signature))) return { ok: false, reason: 'bad signature' };
  } else {
    // Covered by the author's batch root: the root is a normally signed record over a Merkle root of ids.
    if (!batch || typeof batch.root !== 'string' || !Number.isInteger(batch.i) || !Array.isArray(batch.path)) return { ok: false, reason: 'no signature' };
    const root = opts.root?.(batch.root) as SignedRecord<{ root: string; count: number }> | undefined;
    if (!root) return { ok: false, reason: 'batch root unknown' };
    if (root.kind !== 'batch_root' || root.agent_id !== r.agent_id || !root.signature || !verifyRecord(root).ok) return { ok: false, reason: 'bad batch root' };
    if (merkleRootFrom(id, batch.i, batch.path, root.body.count) !== root.body.root) return { ok: false, reason: 'not in the batch' };
  }
  let operatorId = r.agent_id;
  if (r.operator) {
    const op = verifyOperatorClaim(r.operator, pk);
    if (!op.ok) return { ok: false, reason: `operator claim: ${op.reason}` };
    operatorId = op.userId;
  }
  return { ok: true, operatorId };
}

/** Reputation belongs to the operator (human or org), not each agent. */
export function operatorOf(r: SignedRecord<unknown>): string {
  const v = verifyRecord(r);
  return v.ok ? v.operatorId : r.agent_id;
}
