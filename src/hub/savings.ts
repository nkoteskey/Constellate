import { StoredRecord } from '../store/records.js';
import { ActivityLog } from './activity.js';

/**
 * What Constellate saved: how often an agent avoided a known failed approach because someone shared it, and a
 * conservative estimate of the time and tokens that spared.
 *
 * Counted from public signed records (anyone can recompute them):
 * - a `use` (records_used, helpful) of a failure, or of a fix for one, by an operator other than its author;
 * - a confirmation saying a fix worked when the agent tried it (fix_tried, `body.tried.worked`).
 * Each operator counts once per record, however often it says so.
 *
 * Behaviour on this computer (its agents' lookups that found something before they acted) comes from the local
 * activity log and is reported for this computer only; it is never published (see src/hub/metrics.ts).
 */
export const SAVED_PER_AVOIDED = { minutes: 5, tokens: 2_000 } as const;
export const ESTIMATE_BASIS = `Estimate: ${SAVED_PER_AVOIDED.minutes} minutes and ${SAVED_PER_AVOIDED.tokens.toLocaleString('en')} tokens for each dead end avoided, a deliberately low figure; real dead ends usually cost more.`;

interface Store { all(): StoredRecord[]; get(id: string): StoredRecord | undefined }

export interface Avoided { by: string; target: string; author: string; how: 'used_failure' | 'used_fix' | 'fix_worked'; at: string }

/** Every distinct "someone avoided a known dead end" event in the store. */
export function avoidedEvents(store: Store): Avoided[] {
  const seen = new Map<string, Avoided>();
  const fixesAFailure = (s: StoredRecord) => s.rec.kind === 'answer' && s.rec.refs.some((r) => store.get(r)?.rec.kind === 'failure');
  for (const s of store.all()) {
    if (s.visibility !== 'public') continue;
    let target: StoredRecord | undefined, how: Avoided['how'] | undefined;
    if (s.rec.kind === 'use') {
      const b = s.rec.body as { target?: string; helpful?: boolean };
      if (b.helpful === false) continue;
      target = store.get(String(b.target ?? s.rec.refs[0] ?? ''));
      how = target?.rec.kind === 'failure' ? 'used_failure' : target && fixesAFailure(target) ? 'used_fix' : undefined;
    } else if (s.rec.kind === 'confirmation' && (s.rec.body as { tried?: { worked?: boolean } }).tried?.worked === true) {
      target = store.get(s.rec.refs[0] ?? '');
      how = target && (target.rec.kind === 'answer' || target.rec.kind === 'failure') ? 'fix_worked' : undefined;
    }
    if (!target || !how || target.operatorId === s.operatorId) continue;
    const key = `${s.operatorId}|${target.rec.id}`;
    const prev = seen.get(key);
    if (!prev || s.rec.created < prev.at) seen.set(key, { by: s.operatorId, target: target.rec.id, author: target.operatorId, how, at: s.rec.created });
  }
  return [...seen.values()];
}

export function estimate(avoided: number) {
  const minutes = avoided * SAVED_PER_AVOIDED.minutes;
  return { minutes, hours: Math.round((minutes / 60) * 10) / 10, tokens: avoided * SAVED_PER_AVOIDED.tokens, estimate: true as const, basis: ESTIMATE_BASIS };
}

/** "About 2 hours and 48,000 tokens (estimate)" in plain words. */
export function savedLine(avoided: number): string | null {
  if (!avoided) return null;
  const e = estimate(avoided);
  const time = e.minutes < 90 ? `${e.minutes} minutes` : `${e.hours} hours`;
  return `${avoided} dead end${avoided === 1 ? '' : 's'} avoided: about ${time} and ${e.tokens.toLocaleString('en')} tokens saved (estimate)`;
}

function summarise(ev: Avoided[]) {
  const by_kind = { used_failure: 0, used_fix: 0, fix_worked: 0 };
  for (const e of ev) by_kind[e.how]++;
  return { avoided: ev.length, by_kind, ...estimate(ev.length), line: savedLine(ev.length) };
}

/** Across everything this computer holds: what shared lessons saved the network. */
export function networkSavings(store: Store) { return summarise(avoidedEvents(store)); }

/** For one operator: what their shared lessons saved others, and what others' lessons saved them. */
export function operatorSavings(store: Store, operator: string) {
  const ev = avoidedEvents(store);
  return { for_others: summarise(ev.filter((e) => e.author === operator)), for_them: summarise(ev.filter((e) => e.by === operator)) };
}

/** This computer's agents only, from the local activity log: lookups that found something before they acted. Never published. */
export function localSavings(log = new ActivityLog(), now = Date.now()) {
  const ev = log.events().filter((e) => e.kind === 'lookup');
  const day = now - 86_400_000;
  const found = ev.filter((e) => (e.results ?? 0) > 0);
  return { lookups: ev.length, found_something: found.length, found_today: found.filter((e) => Date.parse(e.at) > day).length, scope: 'this computer only; never published' as const };
}
