import { describe, it, expect } from 'vitest';
import { LocalSigner, externalDst, peerIdFromPublicKey, verifyExternal } from '../../src/core/identity.js';
import { signRecord, verifyRecord } from '../../src/core/record.js';
import { issueOperatorClaim, verifyOperatorClaim } from '../../src/core/operator.js';
import { canonicalBytes } from '../../src/core/canonical.js';
import { fromHex, toHex, utf8 } from '../../src/util/bytes.js';
import { sha256 } from '@noble/hashes/sha2.js';

const ctx = { task: 'build crate', domain: ['rust'], environment: 'rustc 1.95' };

describe('identity (x0x compatible)', () => {
  it('derives AgentId as SHA-256("AUTONOMI_PEER_ID_V2:" || pk)', () => {
    const s = LocalSigner.generate(new Uint8Array(32));
    expect(s.agentId).toBe(toHex(sha256(new Uint8Array([...utf8('AUTONOMI_PEER_ID_V2:'), ...s.publicKey]))));
    expect(s.publicKey.length).toBe(1952);
  });
  it('builds the external-sign DST byte-for-byte', () => {
    const d = externalDst('ab', new Uint8Array([9]));
    expect(toHex(d)).toBe('f0' + toHex(utf8('x0x.external-agent-sign.v1')) + '00000002' + toHex(utf8('ab')) + '09');
    expect(() => externalDst('Bad Context', new Uint8Array([1]))).toThrow();
  });
  it('signs and verifies under a context, and contexts do not cross', async () => {
    const s = LocalSigner.generate();
    const sig = await s.sign('constellate.record.v1', utf8('hi'));
    expect(sig.length).toBe(3309);
    expect(verifyExternal(s.publicKey, 'constellate.record.v1', utf8('hi'), sig)).toBe(true);
    expect(verifyExternal(s.publicKey, 'other.context', utf8('hi'), sig)).toBe(false);
  });
});

describe('record envelope', () => {
  it('round-trips and is content addressed', async () => {
    const s = LocalSigner.generate();
    const r = await signRecord({ kind: 'failure', context: ctx, body: { approach: 'x', outcome: 'error' } }, s);
    expect(verifyRecord(r)).toEqual({ ok: true, operatorId: s.agentId });
    expect(r.id).toMatch(/^[0-9a-f]{64}$/);
  });
  it('rejects tampering anywhere', async () => {
    const s = LocalSigner.generate();
    const r = await signRecord({ kind: 'failure', context: ctx, body: { approach: 'x' } }, s);
    expect(verifyRecord({ ...r, body: { approach: 'y' } }).ok).toBe(false);
    expect(verifyRecord({ ...r, context: { ...ctx, environment: 'other' } }).ok).toBe(false);
    const other = LocalSigner.generate();
    expect(verifyRecord({ ...r, author: Buffer.from(other.publicKey).toString('base64') }).ok).toBe(false);
    expect(verifyRecord({ ...r, kind: 'nonsense' }).ok).toBe(false);
  });
  it('canonical encoding is order independent', () => {
    expect(toHex(canonicalBytes({ a: 1, b: [1, { y: 2, x: 1 }] }))).toBe(toHex(canonicalBytes({ b: [1, { x: 1, y: 2 }], a: 1 })));
  });
});

describe('operator chain (x0x agent certificate)', () => {
  it('ties many agents to one operator', async () => {
    const user = LocalSigner.generate();
    const a1 = LocalSigner.generate(), a2 = LocalSigner.generate();
    const r1 = await signRecord({ kind: 'failure', context: ctx, body: {} }, a1, issueOperatorClaim(user, a1.publicKey));
    const r2 = await signRecord({ kind: 'failure', context: ctx, body: {} }, a2, issueOperatorClaim(user, a2.publicKey));
    const v1 = verifyRecord(r1), v2 = verifyRecord(r2);
    expect(v1.ok && v2.ok && v1.operatorId === v2.operatorId && v1.operatorId === user.agentId).toBe(true);
  });
  it('a claim for one agent cannot be reused by another', async () => {
    const user = LocalSigner.generate();
    const a1 = LocalSigner.generate(), a2 = LocalSigner.generate();
    const r = await signRecord({ kind: 'failure', context: ctx, body: {} }, a2, issueOperatorClaim(user, a1.publicKey));
    expect(verifyRecord(r).ok).toBe(false);
  });
  it('honours expiry (v2 certificate)', () => {
    const user = LocalSigner.generate(), a = LocalSigner.generate();
    const c = issueOperatorClaim(user, a.publicKey, { issuedAt: 1000, notAfter: 2000 });
    expect(verifyOperatorClaim(c, a.publicKey, 1500).ok).toBe(true);
    expect(verifyOperatorClaim(c, a.publicKey, 2500).ok).toBe(false);
  });
});
