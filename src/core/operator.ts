import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
import { concat, fromB64, toB64, u64le, utf8 } from '../util/bytes.js';
import { LocalSigner, peerIdFromPublicKey, PUBLIC_KEY_BYTES } from './identity.js';

/**
 * Operator identity rides on x0x's Machine -> Agent -> User chain.
 * An OperatorClaim is an x0x AgentCertificate: the user (operator) key
 * signs `"x0x-agent-cert-v1" || user_pk || agent_pk || issued_at:u64 LE`
 * (v2 adds `|| not_after:u64 LE`), byte-identical to x0x src/identity.rs.
 * 1,000 agents from one person share one operator id, so one reputation.
 */
export interface OperatorClaim {
  user_id: string;
  user_public_key: string; // b64
  issued_at: number; // unix seconds
  not_after?: number;
  cert_signature: string; // b64
}

export function certMessage(userPk: Uint8Array, agentPk: Uint8Array, issuedAt: number, notAfter?: number): Uint8Array {
  return notAfter === undefined
    ? concat(utf8('x0x-agent-cert-v1'), userPk, agentPk, u64le(issuedAt))
    : concat(utf8('x0x-agent-cert-v2'), userPk, agentPk, u64le(issuedAt), u64le(notAfter));
}

export function issueOperatorClaim(user: LocalSigner, agentPublicKey: Uint8Array, opts: { issuedAt?: number; notAfter?: number } = {}): OperatorClaim {
  const issuedAt = opts.issuedAt ?? Math.floor(Date.now() / 1000);
  const sig = user.signRaw(certMessage(user.publicKey, agentPublicKey, issuedAt, opts.notAfter));
  const c: OperatorClaim = { user_id: user.agentId, user_public_key: toB64(user.publicKey), issued_at: issuedAt, cert_signature: toB64(sig) };
  if (opts.notAfter !== undefined) c.not_after = opts.notAfter;
  return c;
}

export function verifyOperatorClaim(c: OperatorClaim, agentPublicKey: Uint8Array, nowSecs = Math.floor(Date.now() / 1000)):
  { ok: true; userId: string } | { ok: false; reason: string } {
  let upk: Uint8Array;
  try { upk = fromB64(c.user_public_key); } catch { return { ok: false, reason: 'bad user key' }; }
  if (upk.length !== PUBLIC_KEY_BYTES) return { ok: false, reason: 'bad user key length' };
  if (peerIdFromPublicKey(upk) !== c.user_id) return { ok: false, reason: 'user_id does not match key' };
  if (c.not_after !== undefined && nowSecs > c.not_after) return { ok: false, reason: 'certificate expired' };
  try {
    if (!ml_dsa65.verify(fromB64(c.cert_signature), certMessage(upk, agentPublicKey, c.issued_at, c.not_after), upk)) return { ok: false, reason: 'bad certificate signature' };
  } catch { return { ok: false, reason: 'bad certificate signature' }; }
  return { ok: true, userId: c.user_id };
}
