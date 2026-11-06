import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { concat, fromB64, fromHex, toB64, toHex, u32be, utf8 } from '../util/bytes.js';

/** Byte sizes fixed by ML-DSA-65 (FIPS 204), identical to x0x. */
export const PUBLIC_KEY_BYTES = 1952;
export const SIGNATURE_BYTES = 3309;

/** x0x's scheme id for external signatures (src/api/agent_signing.rs). */
export const SIGN_ALGORITHM = 'x0x.agent-sign.v2.ml-dsa-65';
const DST_MAGIC = utf8('x0x.external-agent-sign.v1');
const CONTEXT_RE = /^[a-z0-9._-]{1,64}$/;
export const MAX_SIGN_PAYLOAD = 64 * 1024;

/**
 * x0x AgentId / MachineId / UserId derivation (ant-quic
 * `derive_peer_id_from_public_key`): SHA-256("AUTONOMI_PEER_ID_V2:" || pk).
 */
export function peerIdFromPublicKey(publicKey: Uint8Array): string {
  return toHex(sha256(concat(utf8('AUTONOMI_PEER_ID_V2:'), publicKey)));
}

/**
 * The domain-separated bytes x0x's POST /agent/sign actually signs:
 * [0xF0] | "x0x.external-agent-sign.v1" | len(context):u32 BE | context | payload
 * Mirroring it means a record signed by a live x0x daemon and one signed
 * locally verify through the same code path.
 */
export function externalDst(context: string, payload: Uint8Array): Uint8Array {
  if (!CONTEXT_RE.test(context)) throw new Error(`invalid signing context: ${context}`);
  if (payload.length === 0 || payload.length > MAX_SIGN_PAYLOAD) throw new Error('payload size out of range');
  const ctx = utf8(context);
  return concat(new Uint8Array([0xf0]), DST_MAGIC, u32be(ctx.length), ctx, payload);
}

export function verifyExternal(publicKey: Uint8Array, context: string, payload: Uint8Array, signature: Uint8Array): boolean {
  if (publicKey.length !== PUBLIC_KEY_BYTES || signature.length !== SIGNATURE_BYTES) return false;
  try {
    return ml_dsa65.verify(signature, externalDst(context, payload), publicKey);
  } catch {
    return false;
  }
}

/** Anything that can produce an x0x-compatible external signature. */
export interface Signer {
  readonly agentId: string;
  readonly publicKey: Uint8Array;
  sign(context: string, payload: Uint8Array): Promise<Uint8Array>;
}

/** Holds an ML-DSA-65 key in-process. Used offline, in tests, and by agents without a daemon. */
export class LocalSigner implements Signer {
  readonly agentId: string;
  constructor(readonly publicKey: Uint8Array, private readonly secretKey: Uint8Array) {
    this.agentId = peerIdFromPublicKey(publicKey);
  }
  static generate(seed?: Uint8Array): LocalSigner {
    const k = ml_dsa65.keygen(seed ?? new Uint8Array(randomBytes(32)));
    return new LocalSigner(k.publicKey, k.secretKey);
  }
  /** Load a key file, creating it (mode 0600) on first use: identity is made silently on first contribution. */
  static loadOrCreate(path: string): LocalSigner {
    if (existsSync(path)) {
      const j = JSON.parse(readFileSync(path, 'utf8'));
      return LocalSigner.generate(fromHex(j.seed));
    }
    const seed = new Uint8Array(randomBytes(32));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ kind: 'constellate-agent-key', alg: 'ml-dsa-65', seed: toHex(seed) }), { mode: 0o600 });
    chmodSync(path, 0o600);
    return LocalSigner.generate(seed);
  }
  async sign(context: string, payload: Uint8Array): Promise<Uint8Array> {
    return ml_dsa65.sign(externalDst(context, payload), this.secretKey);
  }
  /** Raw ML-DSA signature with no DST, used only to issue operator certificates (x0x-agent-cert-v1). */
  signRaw(message: Uint8Array): Uint8Array {
    return ml_dsa65.sign(message, this.secretKey);
  }
}

export const b64 = { enc: toB64, dec: fromB64 };
