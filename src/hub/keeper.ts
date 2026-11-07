import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import type { Hub } from './hub.js';
import type { StoredRecord } from '../store/records.js';
import { AutonomiArchive } from '../store/autonomi.js';
import { canonicalBytes, decodeCanonical } from '../core/canonical.js';
import { makeBundle, openBundle } from '../store/bundle.js';
import { FUND } from '../economy/fund.js';

/**
 * The library (docs/STORAGE.md): the permanent copy, paid for by the storage fund. It keeps what earned
 * its place, not everything: problems, debates, summaries and skills; lessons someone else confirmed; answers
 * a bounty paid for; and everything public in a topic someone sponsored. The rest stays on people's
 * computers and passes between peers for free.
 *
 * Each run uploads ONE compact bundle of what's new (with the confirmations and receipts that show why it
 * was kept), updates one manifest behind one pointer, and publishes a signed `storage_spend` receipt.
 */
export const LIBRARY_POINTER = 'constellate-library';
const ALWAYS = new Set(['problem', 'checkpoint', 'summary', 'skill', 'proposal', 'position', 'argument', 'ruling']);
const EARNED = new Set(['failure', 'answer', 'task_result', 'piece']);

export type Reason = 'core' | 'confirmed' | 'bounty' | 'sponsored';
interface Manifest { v: 1; app: 'constellate-library'; updated: string; bundles: { addr: string; count: number; bytes: number; at: string }[] }
interface State { archived: string[] }

export class Keeper {
  private readonly stateFile: string;
  constructor(private readonly hub: Hub, home = process.env.CONSTELLATE_HOME ?? join(homedir(), '.constellate')) {
    this.stateFile = join(home, 'library.json');
  }

  private state(): State { try { return JSON.parse(readFileSync(this.stateFile, 'utf8')) as State; } catch { return { archived: [] }; } }
  private save(s: State) { mkdirSync(dirname(this.stateFile), { recursive: true }); writeFileSync(this.stateFile, JSON.stringify(s)); }

  /** Why a record belongs in the permanent library, or null if peers are enough. */
  private context() {
    const paid = new Set(this.hub.node.store.ofKind('receipt').filter((r) => (r.rec.body as { type?: string }).type === 'bounty_paid').map((r) => r.rec.refs[1]));
    return { sponsored: this.hub.fund.sponsoredTopics(), paid };
  }

  reason(s: StoredRecord, ctx = this.context()): Reason | null {
    if (s.visibility !== 'public') return null;
    const store = this.hub.node.store;
    if (ALWAYS.has(s.rec.kind)) return 'core';
    if (!EARNED.has(s.rec.kind)) return null;
    if (store.referencing(s.rec.id, 'confirmation').some((c) => c.operatorId !== s.operatorId)) return 'confirmed';
    if (s.rec.kind === 'answer' && ctx.paid.has(s.rec.id)) return 'bounty';
    if (s.rec.context.domain.some((d) => ctx.sponsored.has(d.toLowerCase()))) return 'sponsored';
    return null;
  }

  /** What the next run would keep, and roughly what it weighs. Free; uploads nothing. */
  plan() {
    const done = new Set(this.state().archived);
    const ctx = this.context();
    const keep: { s: StoredRecord; why: Reason }[] = [];
    let skipped = 0;
    for (const s of this.hub.node.store.all()) {
      if (done.has(s.rec.id) || s.visibility !== 'public') continue;
      const why = this.reason(s, ctx);
      if (why) keep.push({ s, why }); else if (EARNED.has(s.rec.kind)) skipped++;
    }
    // The evidence travels with what it justifies: the confirmations and bounty receipts.
    const ids = new Set(keep.map((k) => k.s.rec.id));
    const evidence = this.hub.node.store.all().filter((s) => !done.has(s.rec.id) && !ids.has(s.rec.id) && s.visibility === 'public'
      && ((s.rec.kind === 'confirmation' && ids.has(s.rec.refs[0])) || (s.rec.kind === 'receipt' && (s.rec.body as { type?: string }).type === 'bounty_paid' && ids.has(s.rec.refs[1]))));
    const records = [...keep.map((k) => k.s.rec), ...evidence.map((s) => s.rec)];
    const by: Record<Reason, number> = { core: 0, confirmed: 0, bounty: 0, sponsored: 0 };
    for (const k of keep) by[k.why]++;
    return { records, by, evidence: evidence.length, left_to_peers: skipped };
  }

  /** Upload what's new as one bundle and point the library at it. Paid when the archive is Autonomi. */
  async run() {
    const p = this.plan();
    if (!p.records.length) return { uploaded: false as const, records: 0 };
    const batches = this.hub.storage.batches().filter((b) => b.ids.some((id) => p.records.some((r) => r.id === id)));
    const bytes = makeBundle(p.records, batches);
    const auto = this.hub.archive instanceof AutonomiArchive ? this.hub.archive : null;
    const logFrom = auto?.log.length ?? 0;
    const addr = await this.hub.archive.put(bytes);
    const prev = await this.manifest();
    const m: Manifest = { v: 1, app: 'constellate-library', updated: new Date().toISOString(), bundles: [...(prev?.bundles ?? []), { addr, count: p.records.length, bytes: bytes.length, at: new Date().toISOString() }] };
    await this.hub.archive.put(canonicalBytes(m)).then((ma) => this.hub.archive.setPointer(LIBRARY_POINTER, ma));
    const atto = auto ? auto.log.slice(logFrom).reduce((n, e) => n + (/^\d+$/.test(e.atto) ? BigInt(e.atto) : 0n), 0n) : 0n;
    this.save({ archived: [...this.state().archived, ...p.records.map((r) => r.id)] });
    const { record } = await this.hub.node.submit({ kind: 'receipt', context: { task: 'payment: storage_spend', domain: ['payments', 'storage'], environment: auto ? 'autonomi' : 'local' }, body: { type: 'storage_spend', payer: FUND, payee: auto ? 'autonomi' : 'local', amount: 0, tx: addr, rail: 'archive', network: auto ? 'autonomi' : 'local', address: addr, bytes: bytes.length, records: p.records.length, atto_ant: atto.toString(), archive: auto ? 'autonomi' : 'local', by: p.by }, refs: [] }, { publish: true });
    return { uploaded: true as const, address: addr, records: p.records.length, bytes: bytes.length, atto_ant: atto.toString(), by: p.by, receipt: record.id };
  }

  private async manifest(): Promise<Manifest | null> {
    const addr = await this.hub.archive.getPointer(LIBRARY_POINTER).catch(() => null);
    const b = addr ? await this.hub.archive.get(addr) : null;
    return b ? decodeCanonical<Manifest>(b) : null;
  }

  /** A new computer pulls the whole library from the archive. Every record is verified and privacy-checked on the way in. */
  async restore() {
    const m = await this.manifest();
    let added = 0, refused = 0;
    for (const bm of m?.bundles ?? []) {
      const b = await this.hub.archive.get(bm.addr);
      if (!b) continue;
      const { roots, records } = openBundle(b);
      for (const r of [...roots, ...records]) {
        if (this.hub.node.store.get(r.id)) continue;
        if (this.hub.node.ingest(r, 'library')) added++; else refused++;
      }
    }
    return { bundles: m?.bundles.length ?? 0, added, refused };
  }

  status() {
    const p = this.plan();
    return { archived: this.state().archived.length, waiting: p.records.length, waiting_by: p.by, left_to_peers: p.left_to_peers, archive: this.hub.archive instanceof AutonomiArchive ? 'autonomi' : 'local' };
  }
}
