import { cpus, totalmem, platform, arch, loadavg } from 'node:os';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

import { suggest, type Suggestion } from '../web/public/js/models.js';

/** What this machine can contribute, detected without a terminal. */
export interface Device { platform: string; arch: string; cpu: string; cores: number; memGB: number; appleSilicon: boolean; gpuGB?: number; gpu?: string }

export function detectDevice(): Device {
  const c = cpus();
  const cpu = c[0]?.model ?? 'unknown';
  return { platform: platform(), arch: arch(), cpu, cores: c.length, memGB: Math.round(totalmem() / 2 ** 30), appleSilicon: platform() === 'darwin' && arch() === 'arm64', ...detectGpu() };
}

/** Best effort: the largest NVIDIA GPU's memory, if nvidia-smi is there. Apple Silicon shares memory, so it needs no GPU read. */
export function detectGpu(): { gpuGB?: number; gpu?: string } {
  try {
    const out = execFileSync('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'], { encoding: 'utf8', timeout: 3000 });
    const best = out.trim().split('\n').map((l) => { const [name, mb] = l.split(',').map((x) => x.trim()); return { gpu: name, gpuGB: Math.round(Number(mb) / 1024) }; }).sort((a, b) => b.gpuGB - a.gpuGB)[0];
    return best && best.gpuGB ? best : {};
  } catch { return {}; }
}

/** Free, open-weight models that fit this machine (shared with the app, so both suggest the same). */
export function suggestFor(d: Device): Suggestion { return suggest({ memGB: d.memGB, appleSilicon: d.appleSilicon, gpuGB: d.gpuGB, cores: d.cores }); }

export interface ModelChoice { runtime: 'ollama' | 'none'; model: string; family: string; size: 'small' | 'large'; reason: string }

/** The single best fit, kept for older callers. */
export function pickLocalModel(d: Device): ModelChoice {
  const s = suggestFor(d);
  if (!s.primary) return { runtime: 'none', model: '', family: '', size: 'small', reason: s.notes[0] ?? `${d.memGB} GB is too little to run a model alongside your work` };
  return { runtime: s.runtime, model: s.primary.run.model, family: s.primary.family, size: s.primary.params >= 20 ? 'large' : 'small', reason: `${s.where}: ${s.primary.name} fits` };
}

export interface Power { onAC: boolean | null; batteryPct: number | null }

/** Best-effort power read: macOS pmset, Linux /sys. Unknown counts as plugged in on desktops. */
export function readPower(): Power {
  try {
    if (platform() === 'darwin') {
      const out = execFileSync('pmset', ['-g', 'batt'], { encoding: 'utf8', timeout: 2000 });
      const pct = out.match(/(\d+)%/);
      return { onAC: /AC Power/.test(out), batteryPct: pct ? Number(pct[1]) : null };
    }
    if (platform() === 'linux' && existsSync('/sys/class/power_supply')) {
      const dirs = readdirSync('/sys/class/power_supply');
      const read = (d: string, f: string) => { try { return readFileSync(`/sys/class/power_supply/${d}/${f}`, 'utf8').trim(); } catch { return null; } };
      const bat = dirs.find((d) => read(d, 'type') === 'Battery');
      const ac = dirs.find((d) => read(d, 'type') === 'Mains');
      return { onAC: ac ? read(ac, 'online') === '1' : bat ? null : true, batteryPct: bat ? Number(read(bat, 'capacity')) : null };
    }
  } catch { /* fall through */ }
  return { onAC: null, batteryPct: null };
}

export interface Policy {
  /** Only work when plugged in (default true). */
  requireAC: boolean;
  /** Minimum battery to work on battery, if requireAC is false. */
  minBattery: number;
  /** Only work when the machine is idle: 1-min load average per core below this. */
  maxLoadPerCore: number;
  /** Allowed local hours, e.g. [22, 7] = 10pm to 7am. Null = any time. */
  hours: [number, number] | null;
  paused: boolean;
}

export const POLITE: Policy = { requireAC: true, minBattery: 50, maxLoadPerCore: 0.5, hours: null, paused: false };

export type Status = { state: 'contributing' | 'paused' | 'waiting'; message: string };

/** The menu-bar line: always plain about what the device is doing and why. */
export function decide(p: Policy, power: Power, load = loadavg()[0] / Math.max(1, cpus().length), hour = new Date().getHours()): Status {
  if (p.paused) return { state: 'paused', message: 'Paused by you.' };
  if (power.onAC === false && p.requireAC) return { state: 'paused', message: 'Paused: plug in to keep contributing.' };
  if (power.onAC === false && (power.batteryPct ?? 0) < p.minBattery) return { state: 'paused', message: `Paused: battery below ${p.minBattery}%.` };
  if (p.hours) {
    const [a, b] = p.hours;
    const inWindow = a <= b ? hour >= a && hour < b : hour >= a || hour < b;
    if (!inWindow) return { state: 'waiting', message: `Waiting: contributing between ${a}:00 and ${b}:00.` };
  }
  if (load > p.maxLoadPerCore) return { state: 'waiting', message: 'Waiting: your computer is busy.' };
  return { state: 'contributing', message: 'Contributing.' };
}
