// The desktop app's own x0x daemon. It runs as a separate program (x0xd) that the app starts,
// health-checks and restarts, in an instance folder the app owns, so it never collides with an
// x0xd the person already runs. Rules followed (from the x0x baseline):
//  - API on 127.0.0.1:0 and QUIC on [::]:0: random ports every launch, never hard-coded;
//  - the address and token are discovered from `api.port` and `api-token` in the instance folder;
//  - self-update is off: the app pins x0xd and updates it with the app;
//  - the ensure is health-checked (2 s timeout) and restarts a daemon that stopped answering;
//  - a relaunch retries briefly, because a stopped daemon can hold its socket or database lock.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const X0X_VERSION = '0.48.1';
const INSTANCE = 'constellate';

/** A TOML string: literal ('…') unless the value contains a quote, then an escaped basic string. */
const toml = (s) => (s.includes("'") ? JSON.stringify(s) : `'${s}'`);
const read = (p) => { try { return readFileSync(p, 'utf8').trim() || undefined; } catch { return undefined; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class X0xSidecar {
  /**
   * @param {{ binary: string | null, base: string, offline?: boolean, log?: (line: string) => void }} opts
   *   binary: path to x0xd (null when this build has none); base: the app's data folder;
   *   offline: no bootstrap peers (tests and air-gapped use).
   */
  constructor({ binary, base, offline = false, plane = process.env.CONSTELLATE_X0X_PLANE ?? 'x0x.prod', log = () => {} }) {
    if (!/^[a-z0-9._-]{1,64}$/.test(plane)) throw new Error(`Not an x0x network plane: ${plane}`);
    this.binary = binary;
    this.plane = plane; // which x0x network to join: x0xd refuses a named instance that doesn't say (x0x 0.48)
    this.dataDir = join(base, `x0x-${INSTANCE}`);
    this.offline = offline;
    this.log = log;
    this.child = null;
    this.state = binary && existsSync(binary) ? 'stopped' : 'missing';
    this.error = this.state === 'missing' ? 'This build does not include x0x, so Constellate runs on this computer only.' : null;
    this.health = null;
    this.tail = [];
    this.timer = null;
    this.stopping = false;
  }

  /** Address and token, read fresh from the instance folder. */
  endpoint() {
    const port = read(join(this.dataDir, 'api.port')), token = read(join(this.dataDir, 'api-token'));
    return port && token ? { url: port.startsWith('http') ? port : `http://${port}`, token } : null;
  }

  /** Environment that points Constellate (the app's server, contributor and agents) at this daemon. */
  env() { return { X0X_DATA_DIR: this.dataDir }; }

  status() { return { state: this.state, error: this.error, peers: this.health?.peers ?? null, version: this.health?.version ?? null, dataDir: this.dataDir }; }

  writeConfig() {
    mkdirSync(this.dataDir, { recursive: true });
    const lines = [
      `# Written by Constellate on every launch. Edit Constellate's settings instead.`,
      `api_address = "127.0.0.1:0"`,
      `bind_address = "[::]:0"`,
      `data_dir = ${toml(this.dataDir)}`,
      `identity_dir = ${toml(join(this.dataDir, 'identity'))}`,
      `instance_name = "${INSTANCE}"`,
      `network_id = "${this.plane}"`,
    ];
    if (this.offline) lines.push('bootstrap_peers = []');
    const file = join(this.dataDir, 'constellate.toml');
    writeFileSync(file, lines.join('\n') + '\n');
    return file;
  }

  async ping(timeoutMs = 2000) {
    const ep = this.endpoint();
    if (!ep) return null;
    try {
      const r = await fetch(ep.url + '/health', { headers: { authorization: `Bearer ${ep.token}` }, signal: AbortSignal.timeout(timeoutMs) });
      return r.ok ? await r.json() : null;
    } catch { return null; }
  }

  async startOnce() {
    const config = this.writeConfig();
    // A stale api.port from the last run would look like a live daemon: clear it, then wait for the fresh one.
    rmSync(join(this.dataDir, 'api.port'), { force: true });
    const args = ['--config', config, '--skip-update-check'];
    if (this.offline) args.push('--no-hard-coded-bootstrap');
    const child = spawn(this.binary, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    this.child = child;
    const keep = (b) => { for (const l of String(b).split('\n').filter(Boolean)) { this.tail.push(l); this.log(l); } this.tail = this.tail.slice(-40); };
    child.stdout.on('data', keep); child.stderr.on('data', keep);
    let exited = null;
    child.on('exit', (code, sig) => {
      exited = code ?? sig;
      if (this.child === child) this.child = null;
      if (!this.stopping && this.state === 'online') { this.state = 'restarting'; this.error = `x0x stopped (${exited}); restarting.`; void this.ensure(); }
    });
    for (let i = 0; i < 100 && exited === null; i++) { // up to 20 s for the first boot
      const h = await this.ping(1000);
      if (h) { this.health = h; return true; }
      await sleep(200);
    }
    if (exited === null) child.kill();
    throw new Error(exited !== null ? `x0x exited during start (${exited}): ${this.tail.slice(-3).join(' | ')}` : 'x0x did not answer within 20 seconds');
  }

  /** Start, or heal: a daemon that answers is left alone; one that doesn't is replaced. */
  async ensure() {
    if (this.state === 'missing' || this.stopping) return this.status();
    if (this.child && (this.health = await this.ping())) { this.state = 'online'; this.error = null; return this.status(); }
    if (this.ensuring) return this.ensuring;
    this.ensuring = (async () => {
      if (this.child) await this.stopChild();
      this.state = 'starting';
      for (let attempt = 1; attempt <= 20; attempt++) { // relaunch races: socket or database lock still held
        try { await this.startOnce(); this.state = 'online'; this.error = null; return this.status(); }
        catch (e) { this.error = String(e.message ?? e); if (this.stopping) break; await sleep(300 * Math.min(attempt, 5)); }
      }
      this.state = 'offline';
      return this.status();
    })().finally(() => { this.ensuring = null; });
    return this.ensuring;
  }

  /** Start and keep it healthy: a check every 20 seconds. */
  async start() {
    this.stopping = false;
    const s = await this.ensure();
    clearInterval(this.timer);
    this.timer = setInterval(() => void this.ensure(), 20_000);
    this.timer.unref?.();
    return s;
  }

  async stopChild() {
    const child = this.child;
    if (!child) return;
    this.child = null;
    const done = new Promise((r) => child.once('exit', r));
    child.kill('SIGTERM');
    await Promise.race([done, sleep(5000)]);
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await Promise.race([done, sleep(2000)]); }
  }

  async stop() {
    this.stopping = true;
    clearInterval(this.timer);
    await this.stopChild();
    if (this.state !== 'missing') this.state = 'stopped';
  }
}

/** Where a packaged build keeps x0xd. */
export function bundledX0xd(resourcesDir, platform = process.platform) {
  return join(resourcesDir, 'x0x', platform === 'win32' ? 'x0xd.exe' : 'x0xd');
}
