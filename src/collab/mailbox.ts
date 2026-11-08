import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import type { Hub } from '../hub/hub.js';
import { utf8, fromUtf8, toB64, fromB64, toHex } from '../util/bytes.js';

/**
 * Sealed mailbox for direct messages to someone who's offline (docs/MAILBOX.md).
 *
 * x0x delivers a direct message only while both computers are online. When it can't, the message is sealed
 * so only the recipient can open it and left in a shared x0x data store, `constellate.mailbox.v1`. The
 * recipient's app collects it the next time it's online, even if the sender's computer is off by then.
 *
 * - Sealing: ML-KEM-768 (post-quantum) to the recipient's mailbox key, then XChaCha20-Poly1305 with a key
 *   derived by HKDF-SHA256. Each computer makes its own mailbox key once and publishes the public half under
 *   `<agent_id>/key`.
 * - Who sent it: the store is self-keyed, so only an agent can write under its own id. A letter at
 *   `<sender>/m/<tag>/<id>` is from that sender; the sealed text must name the same sender.
 * - What others can see: that some sender left a letter for the holder of a recipient tag (a hash of the
 *   recipient's agent id, so anyone who knows that id can compute it), and when. Not what it says.
 * - Letters expire after 14 days; the sender's app removes its own expired ones.
 */
export const MAILBOX_TOPIC = 'constellate.mailbox.v1';
const TTL_DAYS = 14;
const ID = /^[0-9a-f]{64}$/;
const LETTER = /^([0-9a-f]{64})\/m\/([0-9a-f]{32})\/([0-9a-f]{24})$/;

export const recipientTag = (agentId: string) => toHex(sha256(utf8(`${MAILBOX_TOPIC}/to/${agentId}`))).slice(0, 32);
const boxKey = (shared: Uint8Array, ct: Uint8Array) => hkdf(sha256, shared, sha256(ct), utf8(`${MAILBOX_TOPIC}/box`), 32);

export interface Letter { id: string; from: string; to: string; text: string; at: string }
interface Sealed { v: 1; kem: string; nonce: string; box: string; exp: string }

/** Seal a letter so only the holder of `publicKey`'s secret half can open it. */
export function seal(letter: Letter, publicKey: Uint8Array, expires: Date): Sealed {
  const { cipherText, sharedSecret } = ml_kem768.encapsulate(publicKey);
  const nonce = randomBytes(24);
  const box = xchacha20poly1305(boxKey(sharedSecret, cipherText), nonce, utf8(MAILBOX_TOPIC)).encrypt(utf8(JSON.stringify(letter)));
  return { v: 1, kem: toB64(cipherText), nonce: toB64(nonce), box: toB64(box), exp: expires.toISOString() };
}

/** Open a sealed letter with this computer's secret mailbox key; null if it isn't ours or was tampered with. */
export function open(s: Sealed, secretKey: Uint8Array): Letter | null {
  try {
    const ct = fromB64(s.kem);
    const shared = ml_kem768.decapsulate(ct, secretKey);
    return JSON.parse(fromUtf8(xchacha20poly1305(boxKey(shared, ct), fromB64(s.nonce), utf8(MAILBOX_TOPIC)).decrypt(fromB64(s.box)))) as Letter;
  } catch { return null; }
}

export class Mailbox {
  private readonly keyFile: string;
  private readonly seenFile: string;
  private keys?: { publicKey: Uint8Array; secretKey: Uint8Array };
  private joined = false;
  private published = false;

  constructor(private readonly hub: Hub, home = process.env.CONSTELLATE_HOME ?? join(homedir(), '.constellate')) {
    this.keyFile = join(home, 'mailbox.key');
    this.seenFile = join(home, 'mailbox-seen.json');
  }

  get available() { return !!this.hub.x0x; }

  /** This computer's mailbox key, made once and kept with its other keys (readable only by this user). */
  private key() {
    if (this.keys) return this.keys;
    let seed: Uint8Array;
    if (existsSync(this.keyFile)) seed = fromB64(readFileSync(this.keyFile, 'utf8').trim());
    else {
      seed = randomBytes(64);
      mkdirSync(dirname(this.keyFile), { recursive: true });
      writeFileSync(this.keyFile, toB64(seed), { mode: 0o600 });
      try { chmodSync(this.keyFile, 0o600); } catch { /* not on every OS */ }
    }
    return (this.keys = ml_kem768.keygen(seed));
  }

  private async store() {
    const x = this.hub.x0x;
    if (!x) return null;
    if (!this.joined) { await x.joinDirectory(MAILBOX_TOPIC); this.joined = true; }
    return x;
  }

  /** Publish this computer's mailbox key, so others can leave it sealed letters. */
  async publishKey() {
    const x = await this.store(); if (!x) return false;
    await x.directoryPut(MAILBOX_TOPIC, `${this.hub.node.agentId}/key`, utf8(JSON.stringify({ v: 1, kem: toB64(this.key().publicKey), at: new Date().toISOString() })));
    this.published = true;
    return true;
  }

  /** The recipient's published mailbox key, if they have one (older versions don't). */
  async keyOf(agentId: string): Promise<Uint8Array | null> {
    const x = await this.store(); if (!x || !ID.test(agentId)) return null;
    const raw = await x.directoryGet(MAILBOX_TOPIC, `${agentId}/key`).catch(() => null);
    if (!raw) return null;
    try { const k = fromB64((JSON.parse(fromUtf8(raw)) as { kem: string }).kem); return k.length === 1184 ? k : null; } catch { return null; }
  }

  /** Seal a message and leave it for an offline recipient. Throws if they have no mailbox. */
  async leave(to: string, text: string, from = this.hub.node.agentId): Promise<{ id: string; expires: string }> {
    const x = await this.store(); if (!x) throw new Error('the mailbox needs x0x');
    if (!this.published) await this.publishKey(); // so they can answer the same way
    const pub = await this.keyOf(to);
    if (!pub) throw new Error('they’re offline, and their Constellate is too old to receive sealed messages; try again when they’re online');
    const id = toHex(randomBytes(12));
    const expires = new Date(Date.now() + TTL_DAYS * 86_400_000);
    const sealed = seal({ id, from, to, text: text.slice(0, 2000), at: new Date().toISOString() }, pub, expires);
    await x.directoryPut(MAILBOX_TOPIC, `${this.hub.node.agentId}/m/${recipientTag(to)}/${id}`, utf8(JSON.stringify(sealed)));
    return { id, expires: sealed.exp };
  }

  private seen(): Set<string> { try { return new Set(JSON.parse(readFileSync(this.seenFile, 'utf8')) as string[]); } catch { return new Set(); } }
  private saveSeen(s: Set<string>) { mkdirSync(dirname(this.seenFile), { recursive: true }); writeFileSync(this.seenFile, JSON.stringify([...s].slice(-5000))); }

  /** Collect letters left for this computer. Each is opened, checked against who left it, and delivered once. */
  async collect(): Promise<Letter[]> {
    const x = await this.store(); if (!x) return [];
    if (!this.published) await this.publishKey().catch(() => {});
    const me = this.hub.node.agentId, tag = recipientTag(me);
    const seen = this.seen();
    const out: Letter[] = [];
    const keys = (await x.directoryKeys(MAILBOX_TOPIC).catch(() => [] as string[])).filter((k) => { const m = LETTER.exec(k); return !!m && m[2] === tag && !seen.has(`${m[1]}/${m[3]}`); }).slice(0, 500);
    for (const key of keys) {
      const [, sender, , id] = LETTER.exec(key)!;
      try {
        const raw = await x.directoryGet(MAILBOX_TOPIC, key);
        if (!raw || raw.length > 16 * 1024) continue;
        const sealed = JSON.parse(fromUtf8(raw)) as Sealed;
        if (Date.parse(sealed.exp) < Date.now()) { seen.add(`${sender}/${id}`); continue; }
        const l = open(sealed, this.key().secretKey);
        // The store says who left it; the letter must agree, and be for this computer.
        if (!l || l.id !== id || l.to !== me || !ID.test(l.from)) { seen.add(`${sender}/${id}`); continue; }
        out.push({ ...l, from: sender, text: String(l.text).slice(0, 2000) });
        seen.add(`${sender}/${id}`);
      } catch { /* unreadable: try next time */ }
    }
    this.saveSeen(seen);
    return out;
  }

  /** Remove this computer's own letters once they've expired. */
  async tidy(): Promise<number> {
    const x = await this.store(); if (!x) return 0;
    let n = 0;
    for (const key of (await x.directoryKeys(MAILBOX_TOPIC).catch(() => [] as string[])).filter((k) => k.startsWith(`${this.hub.node.agentId}/m/`))) {
      try {
        const raw = await x.directoryGet(MAILBOX_TOPIC, key);
        if (raw && Date.parse((JSON.parse(fromUtf8(raw)) as Sealed).exp) < Date.now()) { await x.directoryDelete(MAILBOX_TOPIC, key); n++; }
      } catch { /* next time */ }
    }
    return n;
  }
}
