import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import type { Hub } from './hub.js';
import { toB64, fromB64, utf8 } from '../util/bytes.js';

/**
 * Catching up (docs/STORAGE.md): x0x gossip has no replay, so a computer that joins later asks a few
 * online peers for history since it last synced. A peer answers with a compact bundle, split into pieces
 * that fit an x0x direct message. Every record is verified and privacy-checked on arrival, as if it had
 * come over gossip. Peers rate-limit requests and only ever share public records.
 */
const PIECE = 24_000;          // bytes of bundle per message (base64 + JSON + x0x framing stays under the 48 KiB cap)
const MAX_RECORDS = 3000;      // per answer; a computer far behind asks again after the first catch-up
const COOLDOWN = 10 * 60_000;  // per asking peer

type Msg = { app?: string; type?: string; req?: string; since?: string | null; n?: number; total?: number; data?: string; records?: number };

export class HistorySync {
  private readonly stateFile: string;
  private answered = new Map<string, number>();
  private incoming = new Map<string, { from: string; parts: string[]; total: number; at: number }>();
  readonly results: { from: string; added: number; known: number; refused: number; at: string }[] = [];

  constructor(private readonly hub: Hub, home = process.env.CONSTELLATE_HOME ?? join(homedir(), '.constellate')) {
    this.stateFile = join(home, 'sync.json');
  }

  private state(): { last?: string } { try { return JSON.parse(readFileSync(this.stateFile, 'utf8')); } catch { return {}; } }
  private save(s: { last?: string }) { mkdirSync(dirname(this.stateFile), { recursive: true }); writeFileSync(this.stateFile, JSON.stringify(s)); }

  private send(to: string, m: Msg) { return this.hub.x0x!.directSend(to, toB64(utf8(JSON.stringify({ app: 'constellate', ...m })))); }

  /** Ask up to `peers` for what this computer is missing. */
  async request(peers: string[]) {
    if (!this.hub.x0x) return 0;
    const since = this.state().last ?? null;
    let asked = 0;
    for (const p of peers.filter((x) => x !== this.hub.node.agentId).slice(0, 3)) {
      await this.send(p, { type: 'sync.req', req: randomBytes(8).toString('hex'), since }).then(() => asked++).catch(() => {});
    }
    return asked;
  }

  /** Handle a direct message if it's a sync message; returns false for anything else (e.g. a person's DM). */
  handle(from: string, payloadB64: string): boolean {
    let m: Msg;
    try { m = JSON.parse(Buffer.from(payloadB64, 'base64').toString('utf8')); } catch { return false; }
    if (m.app !== 'constellate' || !m.type?.startsWith('sync.')) return false;
    if (m.type === 'sync.req') void this.answer(from, m).catch(() => {});
    if (m.type === 'sync.part') this.collect(from, m);
    return true;
  }

  private async answer(to: string, m: Msg) {
    const last = this.answered.get(to) ?? 0;
    if (Date.now() - last < COOLDOWN || typeof m.req !== 'string' || !/^[0-9a-f]{16}$/.test(m.req)) return;
    this.answered.set(to, Date.now());
    const { bytes, records } = this.hub.storage.exportBundle({ since: typeof m.since === 'string' ? m.since : undefined, max: MAX_RECORDS });
    const total = Math.max(1, Math.ceil(bytes.length / PIECE));
    for (let n = 0; n < total; n++) await this.send(to, { type: 'sync.part', req: m.req, n, total, records, data: toB64(bytes.subarray(n * PIECE, (n + 1) * PIECE)) });
  }

  private collect(from: string, m: Msg) {
    if (typeof m.req !== 'string' || typeof m.n !== 'number' || typeof m.total !== 'number' || typeof m.data !== 'string' || m.total > 2000 || m.n >= m.total) return;
    const key = `${from}:${m.req}`;
    const c = this.incoming.get(key) ?? { from, parts: new Array(m.total).fill(''), total: m.total, at: Date.now() };
    c.parts[m.n] = m.data;
    this.incoming.set(key, c);
    for (const [k, v] of this.incoming) if (Date.now() - v.at > 30 * 60_000) this.incoming.delete(k); // abandon stale transfers
    if (c.parts.some((p) => !p)) return;
    this.incoming.delete(key);
    const bytes = new Uint8Array(Buffer.concat(c.parts.map((p) => Buffer.from(fromB64(p)))));
    try {
      const r = this.hub.storage.importBundle(bytes, `sync:${from}`);
      this.results.push({ from, ...r, at: new Date().toISOString() });
      this.save({ last: new Date().toISOString() });
    } catch { /* a bad bundle is dropped */ }
  }
}
