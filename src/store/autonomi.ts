import { Archive } from './archive.js';

/**
 * Permanent storage on the Autonomi network, through the local `antd` daemon's
 * REST API (the same calls the official @withautonomi/antd client makes:
 * /v1/data/public, /v1/data/cost, /v1/pointers, /v1/wallet). The daemon holds
 * the wallet (ANT for storage, ETH for gas, on Arbitrum One) and the pointer
 * key; Constellate holds neither.
 *
 * Safety: every upload is priced first and refused past a daily cap; pointer
 * writes are paid, so the named pointers live in one index object, written
 * behind ONE Autonomi pointer and flushed in batches, never retried
 * automatically (the daemon's docs: "pays on every call, do not retry").
 * OFF unless CONSTELLATE_ARCHIVE=autonomi (see docs/MAINNET.md).
 */
export interface AutonomiOptions {
  url?: string;
  /** Address of the Autonomi pointer this daemon holds the key for (`antd --pointer-keys`). */
  indexPointer: string;
  /** Most a day's uploads may cost, in atto-ANT (decimal string). */
  dailyCapAtto: string;
  /** Batch pointer updates: flush at most this often. */
  flushEveryMs?: number;
  paymentMode?: number;
}

export class AutonomiArchive implements Archive {
  private readonly url: string;
  private index: Record<string, string> | null = null;
  private dirty = false;
  private timer?: NodeJS.Timeout;
  private day = '';
  private spentToday = 0n;
  private attoPerByte = 0;
  readonly log: { at: string; what: string; atto: string }[] = [];

  constructor(private readonly o: AutonomiOptions) {
    this.url = (o.url ?? 'http://127.0.0.1:8082').replace(/\/$/, '');
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await fetch(this.url + path, { method, headers: body === undefined ? undefined : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (!r.ok) throw new Error(`autonomi ${r.status}: ${String(j.error ?? r.statusText)}`);
    return j as T;
  }

  private budget(cost: bigint) {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.day) { this.day = today; this.spentToday = 0n; }
    if (this.spentToday + cost > BigInt(this.o.dailyCapAtto)) throw new Error(`autonomi: today's storage budget (${this.o.dailyCapAtto} atto-ANT) would be exceeded; nothing was paid`);
  }

  async put(bytes: Uint8Array): Promise<string> {
    const data = Buffer.from(bytes).toString('base64');
    const quote = await this.call<{ cost: string }>('POST', '/v1/data/cost', { data, payment_mode: this.o.paymentMode ?? 0 });
    const cost = BigInt(quote.cost || '0');
    this.budget(cost);
    const j = await this.call<{ address: string }>('POST', '/v1/data/public', { data, payment_mode: this.o.paymentMode ?? 0 });
    this.spentToday += cost;
    this.attoPerByte = Number(cost) / Math.max(1, bytes.length);
    this.log.push({ at: new Date().toISOString(), what: `put ${bytes.length} B → ${j.address}`, atto: cost.toString() });
    return j.address;
  }

  async get(address: string): Promise<Uint8Array | null> {
    try { return new Uint8Array(Buffer.from((await this.call<{ data: string }>('GET', `/v1/data/public/${address}`)).data, 'base64')); }
    catch (e) { if (/ 404/.test((e as Error).message)) return null; throw e; }
  }

  private async loadIndex() {
    if (this.index) return this.index;
    try {
      const { target } = await this.call<{ target: string }>('GET', `/v1/pointers/${this.o.indexPointer}/resolve`);
      const raw = await this.get(target);
      this.index = raw ? (JSON.parse(Buffer.from(raw).toString('utf8')) as { pointers: Record<string, string> }).pointers : {};
    } catch (e) {
      if (!/ 404/.test((e as Error).message)) throw e;
      this.index = {}; // first run: the pointer doesn't exist yet
    }
    return this.index;
  }

  async getPointer(name: string) { return (await this.loadIndex())[name] ?? null; }

  async setPointer(name: string, address: string) {
    const ix = await this.loadIndex();
    if (ix[name] === address) return;
    ix[name] = address;
    this.dirty = true;
    if (!this.timer) { this.timer = setTimeout(() => { this.timer = undefined; void this.flush().catch((e) => console.error(String(e))); }, this.o.flushEveryMs ?? 10 * 60_000); this.timer.unref?.(); }
  }

  /** Write the index and move the one pointer to it. Paid; called in batches, never retried automatically. */
  async flush() {
    if (!this.dirty || !this.index) return null;
    this.dirty = false;
    const addr = await this.put(new TextEncoder().encode(JSON.stringify({ v: 1, app: 'constellate', pointers: this.index })));
    await this.call('POST', '/v1/pointers/update', { owner: this.o.indexPointer, target: addr });
    this.log.push({ at: new Date().toISOString(), what: `pointer ${this.o.indexPointer} → ${addr}`, atto: 'see daemon' });
    return addr;
  }

  quote(bytes: number) { return Math.ceil(bytes * this.attoPerByte); }

  async status() {
    const [health, wallet, balance, keys] = await Promise.all([
      this.call<Record<string, unknown>>('GET', '/health'),
      this.call<{ address: string }>('GET', '/v1/wallet/address').catch(() => null),
      this.call<{ balance: string; gas_balance: string }>('GET', '/v1/wallet/balance').catch(() => null),
      this.call<{ keys?: { address: string }[] }>('GET', '/v1/pointers/keys').catch(() => null),
    ]);
    const held = (keys?.keys ?? []).map((k) => k.address);
    return { health, wallet: wallet?.address ?? null, ant_atto: balance?.balance ?? null, eth_wei: balance?.gas_balance ?? null, holds_index_pointer_key: held.includes(this.o.indexPointer), spent_today_atto: this.spentToday.toString(), daily_cap_atto: this.o.dailyCapAtto };
  }

  approve() { return this.call<{ approved: boolean }>('POST', '/v1/wallet/approve', {}); }
}

/** CONSTELLATE_ARCHIVE=autonomi turns it on; everything else must be set too, or it refuses to start. */
export function autonomiFromEnv(env: NodeJS.ProcessEnv): AutonomiArchive | null {
  if (env.CONSTELLATE_ARCHIVE !== 'autonomi') return null;
  if (env.CONSTELLATE_MAINNET_APPROVED !== 'yes') throw new Error('Autonomi mainnet storage costs real money: set CONSTELLATE_MAINNET_APPROVED=yes as well');
  if (!env.CONSTELLATE_AUTONOMI_POINTER) throw new Error('set CONSTELLATE_AUTONOMI_POINTER to the pointer address your antd holds a key for (ant pointer keygen; antd --pointer-keys)');
  if (!env.CONSTELLATE_AUTONOMI_DAILY_CAP_ATTO) throw new Error('set CONSTELLATE_AUTONOMI_DAILY_CAP_ATTO: the most a day of storage may cost, in atto-ANT');
  return new AutonomiArchive({ url: env.ANTD_URL, indexPointer: env.CONSTELLATE_AUTONOMI_POINTER, dailyCapAtto: env.CONSTELLATE_AUTONOMI_DAILY_CAP_ATTO });
}
