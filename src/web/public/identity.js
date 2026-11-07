// No sign-up: a person's identity is an x0x-compatible ML-DSA-65 keypair made
// on this device the first time they contribute. No email, no password, no form.
// Records are built and signed here, exactly like src/core/record.ts, and the
// hub verifies them like any other signed record.
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { encode, rfc8949EncodeOptions } from 'cborg';

const KEY = 'constellate.key';
const te = new TextEncoder();
const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (s) => new Uint8Array(s.match(/../g).map((h) => parseInt(h, 16)));
const b64 = (b) => btoa(String.fromCharCode(...b));
const concat = (...p) => { const o = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { o.set(x, i); i += x.length; } return o; };
const u32be = (n) => new Uint8Array([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);

function store() { try { return window.localStorage; } catch { return null; } }

let cached = null;
export function hasIdentity() { return !!(cached || store()?.getItem(KEY)); }

export function identity() {
  if (cached) return cached;
  let seedHex = store()?.getItem(KEY);
  if (!seedHex) {
    const seed = crypto.getRandomValues(new Uint8Array(32));
    seedHex = hex(seed);
    store()?.setItem(KEY, seedHex);
  }
  const k = ml_dsa65.keygen(unhex(seedHex));
  const agentId = hex(sha256(concat(te.encode('AUTONOMI_PEER_ID_V2:'), k.publicKey)));
  cached = { agentId, publicKey: k.publicKey, secretKey: k.secretKey, seedHex };
  return cached;
}

export function backupBlob() {
  const id = identity();
  return new Blob([JSON.stringify({ kind: 'constellate-agent-key', alg: 'ml-dsa-65', seed: id.seedHex, agent_id: id.agentId }, null, 2)], { type: 'application/json' });
}

export function restore(json) {
  const j = JSON.parse(json);
  if (!/^[0-9a-f]{64}$/.test(j.seed)) throw new Error('not a Constellate key file');
  store()?.setItem(KEY, j.seed);
  cached = null;
  return identity();
}

function strip(v) {
  if (Array.isArray(v)) return v.map(strip);
  if (v && typeof v === 'object') { const o = {}; for (const [k, x] of Object.entries(v)) if (x !== undefined) o[k] = strip(x); return o; }
  return v;
}

export function signRecord({ kind, task, domain, body, refs = [], environment = 'human (browser)' }) {
  const id = identity();
  const core = strip({ v: 1, kind, author: b64(id.publicKey), agent_id: id.agentId, created: new Date().toISOString(), context: { task, domain, environment }, body, evidence: [], refs });
  const recId = hex(sha256(encode(core, rfc8949EncodeOptions)));
  const ctx = te.encode('constellate.record.v1');
  const dst = concat(new Uint8Array([0xf0]), te.encode('x0x.external-agent-sign.v1'), u32be(ctx.length), ctx, unhex(recId));
  const sig = ml_dsa65.sign(dst, id.secretKey);
  return { ...core, id: recId, signature: b64(sig) };
}

/**
 * Check a record yourself, in this browser: the id is the hash of its content,
 * the agent id matches the key, and the ML-DSA-65 signature is valid.
 * Nothing is trusted because a server said so.
 */
export function verifyInBrowser(rec) {
  try {
    const { id, signature, ...core } = rec;
    const pk = Uint8Array.from(atob(rec.author), (c) => c.charCodeAt(0));
    if (hex(sha256(concat(te.encode('AUTONOMI_PEER_ID_V2:'), pk))) !== rec.agent_id) return { ok: false, reason: 'agent id does not match the key' };
    if (hex(sha256(encode(strip(core), rfc8949EncodeOptions))) !== id) return { ok: false, reason: 'content does not match its id' };
    const ctx = te.encode('constellate.record.v1');
    const dst = concat(new Uint8Array([0xf0]), te.encode('x0x.external-agent-sign.v1'), u32be(ctx.length), ctx, unhex(id));
    const sig = Uint8Array.from(atob(signature), (c) => c.charCodeAt(0));
    return ml_dsa65.verify(sig, dst, pk) ? { ok: true } : { ok: false, reason: 'signature does not verify' };
  } catch (e) { return { ok: false, reason: String(e.message ?? e) }; }
}

/**
 * Optional real-world identity: an x0x user certificate over this browser's key
 * ("x0x-agent-cert-v1" || user_pk || agent_pk || issued_at:u64 LE; v2 adds not_after),
 * byte-identical to x0x. Checked here before it is ever shared.
 */
const u64le = (n) => { const b = new Uint8Array(8); let x = BigInt(n); for (let i = 0; i < 8; i++) { b[i] = Number(x & 255n); x >>= 8n; } return b; };
export function publicKeyB64() { return b64(identity().publicKey); }
export function verifyClaim(c) {
  try {
    const upk = Uint8Array.from(atob(c.user_public_key), (x) => x.charCodeAt(0));
    if (hex(sha256(concat(te.encode('AUTONOMI_PEER_ID_V2:'), upk))) !== c.user_id) return { ok: false, reason: 'user id does not match its key' };
    if (c.not_after !== undefined && Date.now() / 1000 > c.not_after) return { ok: false, reason: 'certificate expired' };
    const msg = c.not_after === undefined
      ? concat(te.encode('x0x-agent-cert-v1'), upk, identity().publicKey, u64le(c.issued_at))
      : concat(te.encode('x0x-agent-cert-v2'), upk, identity().publicKey, u64le(c.issued_at), u64le(c.not_after));
    const sig = Uint8Array.from(atob(c.cert_signature), (x) => x.charCodeAt(0));
    return ml_dsa65.verify(sig, msg, upk) ? { ok: true } : { ok: false, reason: 'the signature does not match this browser’s key' };
  } catch (e) { return { ok: false, reason: String(e.message ?? e) }; }
}

export async function contribute(draft) {
  const rec = signRecord(draft);
  if (window.__CONSTELLATE_STATIC__) { const { contributeLocally } = await import('./js/static.js'); return contributeLocally(rec); }
  const r = await fetch('/api/records', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(rec) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || 'rejected');
  return j;
}
