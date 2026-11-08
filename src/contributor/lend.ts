import { appendFileSync, mkdirSync, readFileSync, writeFileSync, renameSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { POLITE, type Policy } from './device.js';

/**
 * Lending this computer in one click (docs/DESKTOP.md "Lend this computer"). The desktop app's switch starts
 * `constellate contribute --lend`, which works within limits the person sets once:
 *  - hours per night: a window that starts at `nightStart`, and at most `hoursPerNight` of work in it;
 *  - never on battery: on battery it pauses, whatever the charge;
 *  - a CPU cap: after each step it rests in proportion, so on average the work uses at most `cpuCapPct` of the
 *    time (and it still only works while the computer is idle).
 * Every step that ran is written to a log the app shows. Off by default: nothing runs until the person turns it on.
 *
 * The limits, tonight's usage and the log are small files in Constellate's folder, shared by the app (which sets
 * the limits and shows the log) and the lending process (which follows them, rereading them as they change).
 */
export interface LendLimits {
  /** Local hour the night starts (0–23). */
  nightStart: number;
  /** At most this many hours of work per night (1–12). */
  hoursPerNight: number;
  /** Never work on battery. */
  neverOnBattery: boolean;
  /** At most this share of the time spent working (10–100). */
  cpuCapPct: number;
}
export const LEND_DEFAULTS: LendLimits = { nightStart: 23, hoursPerNight: 6, neverOnBattery: true, cpuCapPct: 50 };

export interface LendEntry { at: string; problem: string; title: string; step: string; did: 'checked' | 'worked'; outcome: string; model: string; seconds: number }

const clampInt = (v: unknown, lo: number, hi: number, d: number) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
export function cleanLimits(j: Partial<LendLimits> = {}, base: LendLimits = LEND_DEFAULTS): LendLimits {
  return {
    nightStart: j.nightStart === undefined ? base.nightStart : clampInt(j.nightStart, 0, 23, base.nightStart),
    hoursPerNight: j.hoursPerNight === undefined ? base.hoursPerNight : clampInt(j.hoursPerNight, 1, 12, base.hoursPerNight),
    neverOnBattery: typeof j.neverOnBattery === 'boolean' ? j.neverOnBattery : base.neverOnBattery,
    cpuCapPct: j.cpuCapPct === undefined ? base.cpuCapPct : clampInt(j.cpuCapPct, 10, 100, base.cpuCapPct),
  };
}

/** The polite policy these limits mean: the night window, plugged in only, and idle only. */
export function policyFor(l: LendLimits, base: Policy = POLITE): Policy {
  return { ...base, hours: [l.nightStart, (l.nightStart + l.hoursPerNight) % 24], requireAC: l.neverOnBattery ? true : base.requireAC };
}

/** Which night a moment belongs to: the date the night started (before the start hour, it's still last night). */
export function nightOf(now: Date, nightStart: number): string {
  const d = new Date(now);
  if (d.getHours() < nightStart) d.setDate(d.getDate() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** How long to rest after working `ms`, so the work takes at most `capPct` of the time. */
export const restAfter = (ms: number, capPct: number) => Math.round(ms * (100 - capPct) / capPct);

export class Lend {
  readonly limitsFile: string; readonly usageFile: string; readonly logFile: string;
  constructor(home = process.env.CONSTELLATE_HOME ?? join(homedir(), '.constellate')) {
    this.limitsFile = join(home, 'lend.json'); this.usageFile = join(home, 'lend-usage.json'); this.logFile = join(home, 'lend-log.jsonl');
  }

  private write(file: string, v: unknown) { mkdirSync(dirname(file), { recursive: true }); const tmp = `${file}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(v)); renameSync(tmp, file); }

  limits(): LendLimits { try { return cleanLimits(JSON.parse(readFileSync(this.limitsFile, 'utf8'))); } catch { return { ...LEND_DEFAULTS }; } }
  setLimits(patch: Partial<LendLimits>): LendLimits { const l = cleanLimits(patch, this.limits()); this.write(this.limitsFile, l); return l; }

  /** Seconds worked in the current night. */
  usedTonight(now = new Date()): number {
    try { const u = JSON.parse(readFileSync(this.usageFile, 'utf8')) as { night: string; seconds: number }; return u.night === nightOf(now, this.limits().nightStart) ? u.seconds : 0; } catch { return 0; }
  }
  addUsage(seconds: number, now = new Date()) { this.write(this.usageFile, { night: nightOf(now, this.limits().nightStart), seconds: this.usedTonight(now) + Math.max(0, seconds) }); }
  /** Still allowed to work tonight: under the night's hours. */
  underTonight(now = new Date()) { return this.usedTonight(now) < this.limits().hoursPerNight * 3600; }

  record(e: LendEntry) {
    try { mkdirSync(dirname(this.logFile), { recursive: true }); appendFileSync(this.logFile, JSON.stringify(e) + '\n'); } catch { /* the log is best-effort */ }
  }
  /** The latest entries, newest first. */
  recent(n = 30): LendEntry[] {
    try {
      const size = statSync(this.logFile).size;
      const text = readFileSync(this.logFile, 'utf8');
      const lines = (size > 1_000_000 ? text.slice(-500_000) : text).split('\n').filter(Boolean).slice(-n);
      return lines.map((l) => { try { return JSON.parse(l) as LendEntry; } catch { return null; } }).filter((x): x is LendEntry => !!x).reverse();
    } catch { return []; }
  }
}
