import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, closeSync, unlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * x0x for people who use Constellate without the desktop app (docs/NETWORK.md).
 *
 * The npm package (`npx constellate-mcp mcp`) can't reach the network without an x0x daemon. This sets one up
 * the way the desktop app does (desktop/lib/x0x.mjs): the pinned x0xd release, checked against the SHA-256
 * sums committed here before it's ever run; its own instance folder under ~/.constellate; random ports;
 * self-update off. It runs in the background, shared by every agent on this computer, and is started again
 * whenever Constellate starts. It's set up on its own the first time (in the background, and the agent is told
 * in plain words); CONSTELLATE_X0X=off or `constellate network leave` turns it off.
 *
 * If the desktop app's own x0x is running, Constellate uses that instead of starting a second one.
 */
export const X0X_VERSION = '0.48.1'; // keep in step with desktop/scripts/fetch-x0x.mjs (a gate test checks)
export const X0X_SHA256: Record<string, string> = {
  'linux-x64-gnu': '73f590441126fc69e4d58c3a4a2543fd0d3ffb6936c4d4d2c55b959c6edd72b3',
  'linux-arm64-gnu': 'abdf2102ffacf569aac758a0a473ff81e4a473d56a88245b7bd71d7684895982',
  'macos-arm64': '7af0d45ed900956186f19c6f094e3f0c09215d7f02cefcfa0af3a9f3aa4dc051',
  'macos-x64': '41d49e0b28dec35315a86e22edac8d843c45bd13898a44eef13e4e47b2caf242',
  'windows-x64': '707433d05d64a9cfdcc146e5a109b326d2b18d96cee61fb8c51f6319632fd761',
};
const INSTANCE = 'constellate';

export const hostPlatform = (p = process.platform, a = process.arch) => ({ 'linux-x64': 'linux-x64-gnu', 'linux-arm64': 'linux-arm64-gnu', 'darwin-arm64': 'macos-arm64', 'darwin-x64': 'macos-x64', 'win32-x64': 'windows-x64' } as Record<string, string>)[`${p}-${a}`] ?? null;
const read = (p: string) => { try { return readFileSync(p, 'utf8').trim() || undefined; } catch { return undefined; } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const toml = (s: string) => (s.includes("'") ? JSON.stringify(s) : `'${s}'`);

/** Where the desktop app keeps its x0x instance, on each OS. */
export function desktopX0xDir(home = homedir()) {
  const base = process.platform === 'darwin' ? join(home, 'Library', 'Application Support', 'Constellate')
    : process.platform === 'win32' ? join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Constellate')
    : join(process.env.XDG_CONFIG_HOME ?? join(home, '.config'), 'Constellate');
  return join(base, 'x0x-constellate');
}

export type NetworkChoice = 'ask' | 'auto' | 'off';
export interface ManagedStatus { installed: boolean; running: boolean; disabled: boolean; version: string; platform: string | null; dataDir: string; peers: number | null; source: 'constellate' | 'desktop' | null; error?: string }

export class ManagedX0x {
  readonly root: string;          // ~/.constellate/x0x
  readonly dataDir: string;       // the daemon's instance folder
  readonly binary: string;
  constructor(home = process.env.CONSTELLATE_HOME ?? join(homedir(), '.constellate'), readonly offline = process.env.CONSTELLATE_X0X_OFFLINE === '1', readonly plane = process.env.CONSTELLATE_X0X_PLANE ?? 'x0x.prod') {
    if (!/^[a-z0-9._-]{1,64}$/.test(plane)) throw new Error(`Not an x0x network plane: ${plane}`);
    this.root = join(home, 'x0x');
    this.dataDir = join(home, 'x0x-constellate');
    this.binary = join(this.root, process.platform === 'win32' ? 'x0xd.exe' : 'x0xd');
  }

  get installed() { return existsSync(this.binary) && read(join(this.root, 'VERSION'))?.startsWith(`x0x ${X0X_VERSION} `) === true; }
  /** The person chose to leave the network: never start it on our own. */
  get disabled() { return existsSync(join(this.root, 'disabled')); }
  setDisabled(on: boolean) { mkdirSync(this.root, { recursive: true }); if (on) writeFileSync(join(this.root, 'disabled'), new Date().toISOString()); else rmSync(join(this.root, 'disabled'), { force: true }); }

  /** Address and token of a daemon in `dir`, if it wrote them. */
  static endpoint(dir: string) {
    const port = read(join(dir, 'api.port')), token = read(join(dir, 'api-token'));
    return port && token ? { url: port.startsWith('http') ? port : `http://${port}`, token } : null;
  }
  static async ping(dir: string, timeoutMs = 2000): Promise<{ peers?: number; version?: string } | null> {
    const ep = ManagedX0x.endpoint(dir);
    if (!ep) return null;
    try {
      const r = await fetch(`${ep.url}/health`, { headers: { authorization: `Bearer ${ep.token}` }, signal: AbortSignal.timeout(timeoutMs) });
      return r.ok ? (await r.json()) as { peers?: number; version?: string } : null;
    } catch { return null; }
  }

  /** A running daemon this computer already has: the desktop app's, else ours. Its instance folder, or null. */
  async running(): Promise<{ dir: string; source: 'desktop' | 'constellate'; peers: number | null } | null> {
    for (const [dir, source] of [[desktopX0xDir(), 'desktop'], [this.dataDir, 'constellate']] as const) {
      const h = await ManagedX0x.ping(dir);
      if (h) return { dir, source, peers: typeof h.peers === 'number' ? h.peers : null };
    }
    return null;
  }

  async status(): Promise<ManagedStatus> {
    const r = await this.running();
    return { installed: this.installed, running: !!r, disabled: this.disabled, version: X0X_VERSION, platform: hostPlatform(), dataDir: r?.dir ?? this.dataDir, peers: r?.peers ?? null, source: r?.source ?? null };
  }

  /** Download the pinned x0xd for this computer and check it before keeping it. Throws on any mismatch. */
  async install(log: (l: string) => void = () => {}) {
    const platform = hostPlatform();
    if (!platform || !X0X_SHA256[platform]) throw new Error(`x0x has no release for this computer (${process.platform}-${process.arch})`);
    if (this.installed) return;
    const ext = platform.startsWith('windows') ? 'zip' : 'tar.gz';
    const url = `https://github.com/saorsa-labs/x0x/releases/download/v${X0X_VERSION}/x0x-${platform}.${ext}`;
    // CONSTELLATE_X0X_ARCHIVE: a release archive already on this computer (offline installs, tests). Checked the same way.
    const local = process.env.CONSTELLATE_X0X_ARCHIVE;
    let buf: Buffer;
    if (local) { log(`Using the x0x archive at ${local}…`); buf = readFileSync(local); }
    else {
      log(`Downloading x0x ${X0X_VERSION} for ${platform}…`);
      const res = await fetch(url, { signal: AbortSignal.timeout(180_000) }).catch((e: Error) => { throw new Error(`couldn’t download x0x (${e.message})`); });
      if (!res.ok) throw new Error(`couldn’t download x0x (${res.status} from GitHub)`);
      buf = Buffer.from(await res.arrayBuffer());
    }
    const sum = createHash('sha256').update(buf).digest('hex');
    if (sum !== X0X_SHA256[platform]) throw new Error(`the x0x download didn’t match its pinned checksum (got ${sum.slice(0, 12)}…); nothing was installed`);
    const work = mkdtempSync(join(tmpdir(), 'constellate-x0x-'));
    try {
      const archive = join(work, `x0x.${ext}`);
      writeFileSync(archive, buf);
      execFileSync('tar', ['-xf', archive, '-C', work]); // bsdtar on macOS and Windows reads zip too
      const exe = platform.startsWith('windows') ? 'x0xd.exe' : 'x0xd';
      const find = (dir: string): string | null => { for (const e of readdirSync(dir)) { const p = join(dir, e); if (statSync(p).isDirectory()) { const f = find(p); if (f) return f; } else if (e === exe) return p; } return null; };
      const bin = find(work);
      if (!bin) throw new Error(`${exe} wasn’t in the x0x download`);
      mkdirSync(this.root, { recursive: true });
      cpSync(bin, this.binary);
      chmodSync(this.binary, 0o755);
      writeFileSync(join(this.root, 'VERSION'), `x0x ${X0X_VERSION} ${platform} sha256:${sum}\n`);
      log(`x0x ${X0X_VERSION} checked and installed.`);
    } finally { rmSync(work, { recursive: true, force: true }); }
  }

  private writeConfig() {
    mkdirSync(this.dataDir, { recursive: true });
    const lines = [
      `# Written by Constellate on every start.`,
      `api_address = "127.0.0.1:0"`,
      `bind_address = "[::]:0"`,
      `data_dir = ${toml(this.dataDir)}`,
      `identity_dir = ${toml(join(this.dataDir, 'identity'))}`,
      `instance_name = "${INSTANCE}"`,
      `network_id = "${this.plane}"`,
      ...(this.offline ? ['bootstrap_peers = []'] : []),
    ];
    const file = join(this.dataDir, 'constellate.toml');
    writeFileSync(file, lines.join('\n') + '\n');
    return file;
  }

  /**
   * Make sure a daemon is running and answering; returns its instance folder. Reuses the desktop app's or ours
   * when one answers; otherwise starts ours in the background (it outlives this process and is shared by every
   * agent on this computer). Only one process starts it at a time.
   */
  async ensure(log: (l: string) => void = () => {}): Promise<string> {
    const up = await this.running();
    if (up) return up.dir;
    if (!this.installed) throw new Error('x0x isn’t installed yet');
    mkdirSync(this.dataDir, { recursive: true });
    const lock = join(this.dataDir, 'start.lock');
    let fd: number | null = null;
    try { fd = openSync(lock, 'wx'); } catch {
      // Someone else is starting it (or crashed while starting, a minute ago or more): wait for theirs, or take over.
      const age = (() => { try { return Date.now() - statSync(lock).mtimeMs; } catch { return Infinity; } })();
      if (age < 60_000) { for (let i = 0; i < 150; i++) { if (await ManagedX0x.ping(this.dataDir, 1000)) return this.dataDir; await sleep(200); } }
      try { unlinkSync(lock); fd = openSync(lock, 'wx'); } catch { /* lost the race: wait below */ }
    }
    try {
      if (await ManagedX0x.ping(this.dataDir, 1000)) return this.dataDir;
      const config = this.writeConfig();
      rmSync(join(this.dataDir, 'api.port'), { force: true }); // a stale one would look alive
      const out = openSync(join(this.dataDir, 'x0xd.log'), 'a');
      const args = ['--config', config, '--skip-update-check', ...(this.offline ? ['--no-hard-coded-bootstrap'] : [])];
      log('Starting x0x…');
      const child = spawn(this.binary, args, { detached: true, stdio: ['ignore', out, out], windowsHide: true });
      let exited: number | string | null = null;
      child.on('exit', (code, sig) => { exited = code ?? sig; });
      child.unref();
      closeSync(out);
      writeFileSync(join(this.dataDir, 'x0xd.pid'), String(child.pid ?? ''));
      for (let i = 0; i < 150 && exited === null; i++) { // up to 30 s for a first boot
        if (await ManagedX0x.ping(this.dataDir, 1000)) { log('x0x is running.'); return this.dataDir; }
        await sleep(200);
      }
      const tail = (read(join(this.dataDir, 'x0xd.log')) ?? '').split('\n').slice(-3).join(' | ');
      throw new Error(exited !== null ? `x0x stopped while starting (${exited})${tail ? `: ${tail}` : ''}` : 'x0x didn’t answer within 30 seconds');
    } finally {
      if (fd !== null) { closeSync(fd); rmSync(lock, { force: true }); }
    }
  }

  /** While Constellate runs: if our daemon stops answering (it crashed, or was killed), start it again. */
  keepAlive(dir: string, everyMs = 60_000) {
    if (dir !== this.dataDir) return; // the desktop app looks after its own
    const t = setInterval(() => void (async () => { if (!this.disabled && !(await ManagedX0x.ping(this.dataDir))) await this.ensure().catch(() => {}); })(), everyMs);
    t.unref?.();
    return t;
  }

  /** Stop our daemon (never the desktop app's). */
  async stop() {
    const pid = Number(read(join(this.dataDir, 'x0xd.pid')));
    if (pid > 0) { try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ } }
    for (let i = 0; i < 25 && (await ManagedX0x.ping(this.dataDir, 500)); i++) await sleep(200);
    rmSync(join(this.dataDir, 'api.port'), { force: true });
    rmSync(join(this.dataDir, 'x0xd.pid'), { force: true });
  }
}

/**
 * Joining is the default (the person who set Constellate up chose it, docs/NETWORK.md): CONSTELLATE_X0X=off never
 * joins; =ask waits for the agent to call network_join; anything else joins on its own, telling the agent.
 */
export const networkChoice = (env: Record<string, string | undefined> = process.env): NetworkChoice => (env.CONSTELLATE_X0X === 'off' ? 'off' : env.CONSTELLATE_X0X === 'ask' ? 'ask' : 'auto');
