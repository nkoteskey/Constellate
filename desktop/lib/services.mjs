// Constellate's own programs (the app server and the contributor), run with this app's
// runtime: Electron acts as plain Node when ELECTRON_RUN_AS_NODE=1, so nothing else is needed.
// Each runs as its own process, so a crash in one never takes the window down; a crashed one
// restarts with backoff, and gives up (and says so) if it keeps crashing.
import { spawn } from 'node:child_process';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Service {
  /** @param {{ name: string, execPath: string, cliPath: string, args: string[], env?: Record<string,string>, ready?: () => Promise<boolean>, log?: (l: string) => void }} o */
  constructor(o) {
    Object.assign(this, { env: {}, log: () => {}, ready: async () => true }, o);
    this.child = null;
    this.state = 'stopped';
    this.error = null;
    this.crashes = [];
    this.tail = [];
    this.wanted = false;
  }

  status() { return { state: this.state, error: this.error }; }

  spawnOnce() {
    const child = spawn(this.execPath, [this.cliPath, ...this.args], {
      env: { ...process.env, ...this.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    const keep = (b) => { for (const l of String(b).split('\n').filter(Boolean)) { this.tail.push(l); this.log(`[${this.name}] ${l}`); } this.tail = this.tail.slice(-60); };
    child.stdout.on('data', keep); child.stderr.on('data', keep);
    child.on('exit', (code, sig) => {
      if (this.child === child) this.child = null;
      if (!this.wanted) { this.state = 'stopped'; return; }
      const now = Date.now();
      this.crashes = [...this.crashes.filter((t) => now - t < 120_000), now];
      if (this.crashes.length > 4) { this.state = 'failed'; this.error = `${this.name} keeps stopping (${code ?? sig}). Last output: ${this.tail.slice(-2).join(' | ') || 'none'}`; this.wanted = false; return; }
      this.state = 'restarting';
      setTimeout(() => { if (this.wanted) void this.start(); }, 1000 * 2 ** (this.crashes.length - 1));
    });
    return child;
  }

  async start() {
    this.wanted = true;
    if (this.child) return this.status();
    this.state = 'starting'; this.error = null;
    const child = this.spawnOnce();
    for (let i = 0; i < 150; i++) { // up to 30 s
      if (child.exitCode !== null || child.signalCode !== null) break;
      if (await this.ready().catch(() => false)) { this.state = 'running'; return this.status(); }
      await sleep(200);
    }
    if (this.child === child && this.state === 'starting') { this.state = 'failed'; this.error = `${this.name} didn't start: ${this.tail.slice(-3).join(' | ') || 'no output'}`; }
    return this.status();
  }

  async stop() {
    this.wanted = false;
    const child = this.child;
    if (!child) { this.state = 'stopped'; return; }
    const done = new Promise((r) => child.once('exit', r));
    child.kill('SIGTERM');
    await Promise.race([done, sleep(5000)]);
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    this.state = 'stopped';
  }
}

/** Is a Constellate app server answering at this address? */
export async function isConstellate(url) {
  try {
    const r = await fetch(`${url}/api/problems`, { signal: AbortSignal.timeout(1500) });
    return r.ok && Array.isArray(await r.json());
  } catch { return false; }
}

/** Is anything listening at this address at all? */
export async function isListening(url) {
  try { await fetch(url, { signal: AbortSignal.timeout(1500) }); return true; } catch { return false; }
}
