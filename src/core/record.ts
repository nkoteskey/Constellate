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
] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];

export const ContextSchema = z.object({
  task: z.string().max(500),
  domain: z.array(z.string().max(48)).max(12),
  environment: z.string().max(500).default(''),
  inputs_hash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
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
  signature: string; // base64 ML-DSA-65 over the id, under RECORD_SIGN_CONTEXT
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

/** Distrust by default: a record is only accepted if every check passes. */
export function verifyRecord(rec: unknown): VerifyResult {
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
  const { id, signature, ...core } = r;
  if (recordId(core as RecordCore<unknown>) !== id) return { ok: false, reason: 'id is not the content hash' };
  if (!verifyExternal(pk, RECORD_SIGN_CONTEXT, fromHex(id), fromB64(signature))) return { ok: false, reason: 'bad signature' };
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
