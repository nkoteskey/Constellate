import { cpus, totalmem, platform, arch, loadavg } from 'node:os';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

/** What this machine can contribute, detected without a terminal. */
export interface Device { platform: string; arch: string; cpu: string; cores: number; memGB: number; appleSilicon: boolean }

export function detectDevice(): Device {
  const c = cpus();
  const cpu = c[0]?.model ?? 'unknown';
  return { platform: platform(), arch: arch(), cpu, cores: c.length, memGB: Math.round(totalmem() / 2 ** 30), appleSilicon: platform() === 'darwin' && arch() === 'arm64' };
}

export interface ModelChoice { runtime: 'mlx' | 'ollama' | 'none'; model: string; family: string; size: 'small' | 'large'; reason: string }

/** Pick a fitting open-weight model for the hardware (leaves room for the user's own work). */
export function pickLocalModel(d: Device): ModelChoice {
  const runtime = d.appleSilicon ? 'mlx' : 'ollama';
  const q = (mlx: string, ollama: string) => (d.appleSilicon ? mlx : ollama);
  if (d.memGB >= 64) return { runtime, model: q('mlx-community/Qwen3-32B-4bit', 'qwen3:32b'), family: 'qwen', size: 'large', reason: `${d.memGB} GB: room for a 32B model` };
  if (d.memGB >= 24) return { runtime, model: q('mlx-community/Qwen3-14B-4bit', 'qwen3:14b'), family: 'qwen', size: 'small', reason: `${d.memGB} GB: 14B model` };
  if (d.memGB >= 12) return { runtime, model: q('mlx-community/Llama-3.2-8B-Instruct-4bit', 'llama3.1:8b'), family: 'llama', size: 'small', reason: `${d.memGB} GB: 8B model` };
  if (d.memGB >= 6) return { runtime, model: q('mlx-community/Llama-3.2-3B-Instruct-4bit', 'llama3.2:3b'), family: 'llama', size: 'small', reason: `${d.memGB} GB: 3B model for verification and screening` };
  return { runtime: 'none', model: '', family: '', size: 'small', reason: `${d.memGB} GB is too little to run a model alongside your work; you can still review and rate` };
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
