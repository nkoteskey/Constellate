import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
// @ts-expect-error plain ES modules of the desktop app
import { X0xSidecar } from '../../desktop/lib/x0x.mjs';
// @ts-expect-error plain ES modules of the desktop app
import { mcpEntry, connect, disconnect, connection, agentConfigs, claudeCodeCommand, claudeCodeArgs } from '../../desktop/lib/agents.mjs';
import { X0xClient } from '../../src/x0x/client.js';

/**
 * The desktop app runs its own x0x daemon (x0xd) and connects agents to Constellate. These gates
 * run the app's daemon supervisor against a stand-in daemon that speaks the same contract: a
 * TOML --config, random ports, `api.port` + `api-token` written into data_dir.
 */
const FAKE = resolve('test/fixtures/fake-x0xd.mjs');
const tmp = () => mkdtempSync(join(tmpdir(), 'desk-'));
let running: { stop(): Promise<void> }[] = [];
afterEach(async () => { await Promise.all(running.map((s) => s.stop())); running = []; delete process.env.FAKE_X0XD_FAIL; });

describe('the desktop app’s own x0x daemon', () => {
  it('starts x0xd in an app-owned folder on random ports, without self-update, and finds it from the files it writes', async () => {
    const x = new X0xSidecar({ binary: FAKE, base: tmp(), offline: true }); running.push(x);
    const s = await x.start();
    expect(s.state).toBe('online');
    expect(s.peers).toBe(3);
    const seen = JSON.parse(readFileSync(join(x.dataDir, 'fake-args.json'), 'utf8'));
    expect(seen.args).toEqual(expect.arrayContaining(['--config', '--skip-update-check', '--no-hard-coded-bootstrap']));
    expect(seen.config).toMatch(/^api_address = "127\.0\.0\.1:0"$/m);
    expect(seen.config).toMatch(/^bind_address = "\[::\]:0"$/m);
    expect(seen.config).toMatch(/^bootstrap_peers = \[\]$/m);
    expect(seen.config).toMatch(/^network_id = "x0x\.prod"$/m); // x0xd refuses a named instance without one
    expect(seen.config).toContain(`identity_dir = '${join(x.dataDir, 'identity')}'`);
    // Constellate itself finds the daemon through X0X_DATA_DIR.
    const c = new X0xClient(undefined, undefined, x.env().X0X_DATA_DIR);
    expect((await c.agent()).agent_id).toHaveLength(64);
  });

  it('joins the real network by default: no offline flags', async () => {
    const x = new X0xSidecar({ binary: FAKE, base: tmp() }); running.push(x);
    await x.start();
    const seen = JSON.parse(readFileSync(join(x.dataDir, 'fake-args.json'), 'utf8'));
    expect(seen.args).not.toContain('--no-hard-coded-bootstrap');
    expect(seen.config).not.toMatch(/bootstrap_peers/);
  });

  it('heals: a daemon that dies is restarted on a new port, and Constellate follows it without restarting', async () => {
    const x = new X0xSidecar({ binary: FAKE, base: tmp(), offline: true }); running.push(x);
    await x.start();
    const c = new X0xClient(undefined, undefined, x.env().X0X_DATA_DIR);
    const before = c.baseUrl;
    x.child.kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 200));
    const s = await x.ensure();
    expect(s.state).toBe('online');
    expect(c.baseUrl).not.toBe(before);
    expect((await c.health()).ok).toBe(true);
  });

  it('says plainly when x0x is missing or won’t start, and Constellate keeps working on its own', async () => {
    const missing = new X0xSidecar({ binary: join(tmp(), 'no-such-x0xd'), base: tmp() });
    expect((await missing.start()).state).toBe('missing');
    expect(missing.status().error).toMatch(/this computer only/);
    process.env.FAKE_X0XD_FAIL = '1';
    const failing = new X0xSidecar({ binary: FAKE, base: tmp(), offline: true }); running.push(failing);
    failing.startOnce = (() => { const orig = failing.startOnce.bind(failing); let n = 0; return () => { if (++n > 2) failing.stopping = true; return orig(); }; })();
    const s = await failing.start();
    expect(s.state).toBe('offline');
    expect(s.error).toMatch(/exited during start/);
  });

  it('writes Windows paths and paths with quotes as valid TOML', () => {
    const x = new X0xSidecar({ binary: FAKE, base: "C:\\Users\\Pat's PC\\AppData" });
    expect(x.status().dataDir).toContain("Pat's PC");
  });
});

describe('connecting agents from the desktop app', () => {
  const entry = mcpEntry({ execPath: '/Applications/Constellate.app/Contents/MacOS/Constellate', cliPath: '/Applications/Constellate.app/Contents/Resources/app/dist/cli.js', x0xDataDir: '/data/x0x-constellate' });

  it('runs Constellate with the app’s own runtime, pointed at the app’s x0x', () => {
    expect(entry).toEqual({ command: '/Applications/Constellate.app/Contents/MacOS/Constellate', args: ['/Applications/Constellate.app/Contents/Resources/app/dist/cli.js', 'mcp'], env: { ELECTRON_RUN_AS_NODE: '1', X0X_DATA_DIR: '/data/x0x-constellate' } });
    expect(JSON.stringify(entry)).not.toMatch(/npx|constellate-mcp/);
  });

  it('adds Constellate next to the agent’s other servers, keeps a backup, and removes only itself', () => {
    const dir = tmp(); const file = join(dir, 'claude_desktop_config.json');
    writeFileSync(file, JSON.stringify({ theme: 'dark', mcpServers: { other: { command: 'x' } } }));
    expect(connection(file, entry)).toBe('none');
    const backup = connect(file, entry);
    expect(existsSync(backup)).toBe(true);
    const cfg = JSON.parse(readFileSync(file, 'utf8'));
    expect(cfg.theme).toBe('dark');
    expect(cfg.mcpServers.other).toEqual({ command: 'x' });
    expect(connection(file, entry)).toBe('connected');
    expect(disconnect(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8')).mcpServers).toEqual({ other: { command: 'x' } });
  });

  it('connects VS Code (Copilot and any model in it), which lists servers under "servers"', () => {
    const home = tmp();
    const vs = agentConfigs({ platform: 'darwin', home }).vscode;
    expect(vs.file).toBe(join(home, 'Library', 'Application Support', 'Code', 'User', 'mcp.json'));
    expect(vs.key).toBe('servers');
    expect(agentConfigs({ platform: 'linux', home }).vscode.file).toBe(join(home, '.config', 'Code', 'User', 'mcp.json'));
    expect(agentConfigs({ platform: 'win32', home, appData: join(home, 'Roaming') }).vscode.file).toBe(join(home, 'Roaming', 'Code', 'User', 'mcp.json'));
    const dir = tmp(); const file = join(dir, 'mcp.json');
    writeFileSync(file, JSON.stringify({ servers: { github: { type: 'http', url: 'https://example.com/mcp' } }, inputs: [] }));
    expect(connection(file, entry, 'servers')).toBe('none');
    connect(file, entry, 'servers');
    const cfg = JSON.parse(readFileSync(file, 'utf8'));
    expect(cfg.servers.constellate).toEqual({ type: 'stdio', ...entry });
    expect(cfg.servers.github).toEqual({ type: 'http', url: 'https://example.com/mcp' });
    expect(cfg.mcpServers).toBeUndefined();
    expect(connection(file, entry, 'servers')).toBe('connected');
    expect(disconnect(file, 'servers')).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8')).servers).toEqual({ github: { type: 'http', url: 'https://example.com/mcp' } });
  });

  it('connects OpenAI Codex in one click: only Constellate\'s own table in config.toml, every other line kept', () => {
    const home = tmp();
    const cx = agentConfigs({ platform: 'darwin', home }).codex;
    expect(cx.file).toBe(join(home, '.codex', 'config.toml'));
    const before = ['model = "gpt-5"', '', '[mcp_servers.github]', 'command = "gh-mcp"', 'args = []', '', '[profiles.fast]', 'model = "gpt-5-mini"', ''].join('\n');
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(cx.file, before);
    expect(connection(cx.file, entry)).toBe('none');
    const backup = connect(cx.file, entry);
    expect(readFileSync(backup!, 'utf8')).toBe(before);
    const text = readFileSync(cx.file, 'utf8');
    expect(text.startsWith(before.trimEnd())).toBe(true); // nothing of theirs moved or changed
    expect(text).toContain(`[mcp_servers.constellate]\ncommand = ${JSON.stringify(entry.command)}\nargs = [${entry.args.map((x) => JSON.stringify(x)).join(', ')}]`);
    expect(text).toContain('[mcp_servers.constellate.env]\nELECTRON_RUN_AS_NODE = "1"');
    expect(connection(cx.file, entry)).toBe('connected');
    connect(cx.file, entry); // again: replaced, not duplicated
    expect(readFileSync(cx.file, 'utf8').match(/\[mcp_servers\.constellate\]/g)).toHaveLength(1);
    expect(disconnect(cx.file)).toBe(true);
    expect(readFileSync(cx.file, 'utf8').trimEnd()).toBe(before.trimEnd());
    expect(connection(cx.file, entry)).toBe('none');
  });

  it('connects Claude Code in one click through its own command, and reads its settings only to show the state', () => {
    const home = tmp();
    const cc = agentConfigs({ platform: 'linux', home })['claude-code'];
    expect(cc).toMatchObject({ name: 'Claude Code', file: join(home, '.claude.json'), cli: true });
    // Exactly what the app runs (checked against the real `claude` CLI: it adds this to ~/.claude.json).
    expect(claudeCodeArgs(entry)).toEqual(['mcp', 'add', '--scope', 'user', 'constellate', ...Object.entries(entry.env).flatMap(([k, v]) => ['-e', `${k}=${v}`]), '--', entry.command, ...entry.args]);
    expect(connection(cc.file, entry)).toBe('none');
    writeFileSync(cc.file, JSON.stringify({ numStartups: 3, mcpServers: { constellate: { type: 'stdio', ...entry } } }));
    expect(connection(cc.file, entry)).toBe('connected');
    const main = readFileSync(join(import.meta.dirname, '../../desktop/main.mjs'), 'utf8');
    expect(main).toMatch(/claudeCode\(claudeCodeArgs\(entry\)\)/);
    expect(main).toMatch(/claudeCode\(\['mcp', 'remove', '--scope', 'user', SERVER_NAME\]\)/);
  });

  it('creates the file when the agent has none, and never overwrites one it can’t read', () => {
    const dir = tmp();
    const fresh = join(dir, 'new', 'mcp.json');
    expect(connect(fresh, entry)).toBeNull();
    expect(JSON.parse(readFileSync(fresh, 'utf8')).mcpServers.constellate).toEqual(entry);
    const broken = join(dir, 'broken.json'); writeFileSync(broken, '{ not json');
    expect(() => connect(broken, entry)).toThrow(/left untouched/);
    expect(readFileSync(broken, 'utf8')).toBe('{ not json');
    expect(connection(broken, entry)).toBe('unreadable');
  });

  it('knows where each agent keeps its settings on every platform', () => {
    const home = tmp(); mkdirSync(join(home, '.cursor'));
    expect(agentConfigs({ platform: 'darwin', home })['claude-desktop'].file).toBe(join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'));
    expect(agentConfigs({ platform: 'win32', home, appData: join(home, 'Roaming') })['claude-desktop'].file).toBe(join(home, 'Roaming', 'Claude', 'claude_desktop_config.json'));
    expect(agentConfigs({ platform: 'linux', home })['claude-desktop'].file).toBe(join(home, '.config', 'Claude', 'claude_desktop_config.json'));
    expect(agentConfigs({ platform: 'linux', home }).cursor.present).toBe(true);
  });

  it('gives Claude Code a command to copy, quoted for paths with spaces', () => {
    const cmd = claudeCodeCommand(mcpEntry({ execPath: 'C:\\Program Files\\Constellate\\Constellate.exe', cliPath: 'C:\\Program Files\\Constellate\\resources\\app\\dist\\cli.js', x0xDataDir: 'C:\\Users\\Pat\\AppData\\Roaming\\Constellate\\x0x-constellate' }));
    expect(cmd).toMatch(/^claude mcp add --scope user constellate -e ELECTRON_RUN_AS_NODE=1 -e X0X_DATA_DIR=/); // every project, like the one-click button
    expect(cmd).toContain('-- "C:\\\\Program Files\\\\Constellate\\\\Constellate.exe"');
  });
});
