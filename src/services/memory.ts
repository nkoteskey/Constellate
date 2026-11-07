import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { Archive } from '../store/archive.js';
import { canonicalBytes, decodeCanonical } from '../core/canonical.js';
import { concat, fromHex, toHex, utf8 } from '../util/bytes.js';

/**
 * Private memory: an encrypted scratchpad the agent owns across sessions and
 * platforms (Claude Code today, Cursor tomorrow, another machine next week).
 * - Values are encrypted on this machine (XChaCha20-Poly1305) and stored as
 *   archive chunks (Autonomi in production: pay to store, reads free).
 * - An encrypted index maps names to chunk addresses; a Pointer always points
 *   at the latest index. The pointer's name is derived from the key, so
 *   observers cannot link it to the agent's public identity.
 * - Never gossiped, never a public record. Whoever holds the memory key has
 *   the memory; back it up with the identity key.
 */
interface Index { v: 1; entries: Record<string, { addr: string; updated: string; bytes: number }> }

export class MemoryKey {
  private constructor(readonly secret: Uint8Array) {}
  static generate() { return new MemoryKey(new Uint8Array(randomBytes(32))); }
  static fromSeed(seed: Uint8Array) { return new MemoryKey(hkdf(sha256, seed, utf8('constellate'), utf8('memory-key-v1'), 32)); }
  static loadOrCreate(path: string) {
    if (existsSync(path)) return new MemoryKey(fromHex(JSON.parse(readFileSync(path, 'utf8')).secret));
    const k = MemoryKey.generate();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ kind: 'constellate-memory-key', secret: toHex(k.secret) }), { mode: 0o600 });
    chmodSync(path, 0o600);
    return k;
  }
  sub(label: string) { return hkdf(sha256, this.secret, undefined, utf8(label), 32); }
}

export class PrivateMemory {
  private readonly enc: Uint8Array;
  private readonly pointer: string;
  private cache?: Index;

  constructor(private readonly archive: Archive, key: MemoryKey) {
    this.enc = key.sub('memory/encrypt');
    this.pointer = `constellate/memory/${toHex(key.sub('memory/pointer'))}`;
  }

  private seal(plain: Uint8Array, aad: string) {
    const nonce = new Uint8Array(randomBytes(24));
    return concat(nonce, xchacha20poly1305(this.enc, nonce, utf8(aad)).encrypt(plain));
  }
  private open(box: Uint8Array, aad: string) {
    return xchacha20poly1305(this.enc, box.slice(0, 24), utf8(aad)).decrypt(box.slice(24)); // throws if tampered
  }

  private async index(): Promise<Index> {
    const addr = await this.archive.getPointer(this.pointer);
    if (!addr) return (this.cache = { v: 1, entries: {} });
    const box = await this.archive.get(addr);
    if (!box) throw new Error('memory index missing from the archive');
    return (this.cache = decodeCanonical<Index>(this.open(box, 'index')));
  }
  private async saveIndex(ix: Index) {
    const addr = await this.archive.put(this.seal(canonicalBytes(ix), 'index'));
    await this.archive.setPointer(this.pointer, addr);
    this.cache = ix;
  }

  async put(name: string, value: string) {
    if (name.length > 200) throw new Error('name too long');
    const plain = utf8(value);
    if (plain.length > 1_000_000) throw new Error('value too large (1 MB max)');
    const addr = await this.archive.put(this.seal(plain, `entry:${name}`));
    const ix = await this.index();
    ix.entries[name] = { addr, updated: new Date().toISOString(), bytes: plain.length };
    await this.saveIndex(ix);
    return { name, bytes: plain.length, storage_cost: this.archive.quote(plain.length + 40) };
  }

  async get(name: string): Promise<string | null> {
    const e = (await this.index()).entries[name];
    if (!e) return null;
    const box = await this.archive.get(e.addr);
    if (!box) throw new Error(`memory entry ${name} missing from the archive`);
    return new TextDecoder().decode(this.open(box, `entry:${name}`));
  }

  async list(prefix = '') {
    const ix = await this.index();
    return Object.entries(ix.entries).filter(([k]) => k.startsWith(prefix)).map(([name, e]) => ({ name, updated: e.updated, bytes: e.bytes }));
  }

  async delete(name: string) {
    const ix = await this.index();
    const had = name in ix.entries;
    delete ix.entries[name];
    await this.saveIndex(ix);
    return had; // the old ciphertext stays in permanent storage, unreadable without the key
  }
}
