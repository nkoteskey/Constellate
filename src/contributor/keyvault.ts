import { gcm } from '@noble/ciphers/aes.js';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { fromB64, toB64, utf8, fromUtf8 } from '../util/bytes.js';

/**
 * Cloud model keys live on this device only, encrypted at rest (AES-256-GCM)
 * with a device key in a separate 0600 file, and are never put in a record or
 * broadcast. (On macOS the device key should move to the Keychain; noted in PROGRESS.)
 */
export class KeyVault {
  private key: Uint8Array;
  constructor(private readonly path: string, keyPath = `${path}.devicekey`) {
    mkdirSync(dirname(path), { recursive: true });
    if (!existsSync(keyPath)) { writeFileSync(keyPath, toB64(new Uint8Array(randomBytes(32))), { mode: 0o600 }); chmodSync(keyPath, 0o600); }
    this.key = fromB64(readFileSync(keyPath, 'utf8'));
  }
  private load(): Record<string, string> { return existsSync(this.path) ? JSON.parse(readFileSync(this.path, 'utf8')) : {}; }
  set(name: string, secret: string) {
    const all = this.load();
    const nonce = new Uint8Array(randomBytes(12));
    all[name] = `${toB64(nonce)}.${toB64(gcm(this.key, nonce).encrypt(utf8(secret)))}`;
    writeFileSync(this.path, JSON.stringify(all), { mode: 0o600 });
  }
  get(name: string): string | undefined {
    const v = this.load()[name];
    if (!v) return undefined;
    const [n, c] = v.split('.');
    return fromUtf8(gcm(this.key, fromB64(n)).decrypt(fromB64(c)));
  }
  names() { return Object.keys(this.load()); }
}
