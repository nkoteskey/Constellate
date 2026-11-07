import { encode, decode, rfc8949EncodeOptions } from 'cborg';
import { sha256 } from '@noble/hashes/sha2.js';
import { toHex } from '../util/bytes.js';

/**
 * Deterministic CBOR (RFC 8949 §4.2.1 core deterministic encoding).
 * Records are signed and content-addressed over these bytes, so two
 * implementations that agree on the JSON value agree on the bytes.
 * `undefined` values are stripped first so optional fields never change a hash.
 */
export function canonicalBytes(value: unknown): Uint8Array {
  return encode(stripUndefined(value), rfc8949EncodeOptions);
}

export function decodeCanonical<T = unknown>(bytes: Uint8Array): T {
  return decode(bytes) as T;
}

export function sha256Hex(bytes: Uint8Array): string {
  return toHex(sha256(bytes));
}

export function stripUndefined(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripUndefined);
  if (v && typeof v === 'object' && !(v instanceof Uint8Array)) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (x !== undefined) out[k] = stripUndefined(x);
    return out;
  }
  if (typeof v === 'number' && !Number.isFinite(v)) throw new Error('non-finite number in record');
  return v;
}
