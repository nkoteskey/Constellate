import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { sha256Hex } from '../core/canonical.js';

/**
 * Permanent archive (Autonomi in production: pay to store, reads free).
 * Content-addressed chunks plus mutable Pointers that give each problem or
 * agent a fixed address for its latest state.
 */
export interface Archive {
  put(bytes: Uint8Array): Promise<string>;
  get(address: string): Promise<Uint8Array | null>;
  setPointer(name: string, address: string): Promise<void>;
  getPointer(name: string): Promise<string | null>;
  /** Storage cost estimate in the archive's smallest unit, for budgets and receipts. */
  quote(bytes: number): number;
}

/**
 * Local stand-in for Autonomi with the same semantics (immutable, content
 * addressed, pointer = latest). Swap for an Autonomi client once one is
 * wired and tested against the live network (needs a human: real tokens).
 */
export class LocalArchive implements Archive {
  private mem = new Map<string, Uint8Array>();
  private ptr = new Map<string, string>();
  constructor(private readonly dir?: string) { if (dir) mkdirSync(join(dir, 'chunks'), { recursive: true }); }
  async put(bytes: Uint8Array) {
    const a = sha256Hex(bytes);
    if (this.dir) { const p = join(this.dir, 'chunks', a); if (!existsSync(p)) writeFileSync(p, bytes); } else this.mem.set(a, bytes);
    return a;
  }
  async get(a: string) {
    if (this.dir) { const p = join(this.dir, 'chunks', a); return existsSync(p) ? new Uint8Array(readFileSync(p)) : null; }
    return this.mem.get(a) ?? null;
  }
  async setPointer(name: string, address: string) {
    this.ptr.set(name, address);
    if (this.dir) writeFileSync(join(this.dir, 'pointers.json'), JSON.stringify(Object.fromEntries(this.ptr)));
  }
  async getPointer(name: string) {
    if (this.dir && !this.ptr.size && existsSync(join(this.dir, 'pointers.json'))) for (const [k, v] of Object.entries(JSON.parse(readFileSync(join(this.dir, 'pointers.json'), 'utf8')))) this.ptr.set(k, v as string);
    return this.ptr.get(name) ?? null;
  }
  quote(bytes: number) { return Math.ceil(bytes / 1024); }
}
