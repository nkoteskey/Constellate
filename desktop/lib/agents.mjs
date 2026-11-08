// Connecting AI agents (Claude Desktop, Cursor, VS Code, Codex, Claude Code…) to the Constellate in this app.
// Agents start Constellate's MCP server with this app's own runtime (Electron runs as plain
// Node with ELECTRON_RUN_AS_NODE=1), so nothing else needs installing. Writing another app's
// config happens only when the person clicks Connect, keeps a backup, and never overwrites a
// file it can't read.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export const SERVER_NAME = 'constellate';

/** The MCP server entry an agent needs to start Constellate from this app. */
export function mcpEntry({ execPath, cliPath, x0xDataDir, starter, appUrl }) {
  // appUrl: agents post bounties through the app, which holds this computer's balance (docs/BOUNTIES.md).
  return { command: execPath, args: [cliPath, 'mcp'], env: { ELECTRON_RUN_AS_NODE: '1', ...(x0xDataDir ? { X0X_DATA_DIR: x0xDataDir } : {}), ...(starter ? { CONSTELLATE_STARTER: starter } : {}), ...(appUrl ? { CONSTELLATE_APP_URL: appUrl } : {}) } };
}

/** Config files of the agents we can connect with one click. */
export function agentConfigs({ platform = process.platform, home = homedir(), appData = process.env.APPDATA } = {}) {
  // VS Code keeps one user-level MCP file (servers under "servers", not "mcpServers"), used by Copilot and any
  // model or extension in it.
  const codeDir = platform === 'darwin' ? join(home, 'Library', 'Application Support', 'Code', 'User')
    : platform === 'win32' ? join(appData ?? join(home, 'AppData', 'Roaming'), 'Code', 'User')
      : join(home, '.config', 'Code', 'User');
  const claudeDir = platform === 'darwin' ? join(home, 'Library', 'Application Support', 'Claude')
    : platform === 'win32' ? join(appData ?? join(home, 'AppData', 'Roaming'), 'Claude')
      : join(home, '.config', 'Claude');
  return {
    'claude-desktop': { name: 'Claude Desktop', file: join(claudeDir, 'claude_desktop_config.json'), present: existsSync(claudeDir) },
    cursor: { name: 'Cursor', file: join(home, '.cursor', 'mcp.json'), present: existsSync(join(home, '.cursor')) },
    windsurf: { name: 'Windsurf', file: join(home, '.codeium', 'windsurf', 'mcp_config.json'), present: existsSync(join(home, '.codeium', 'windsurf')) },
    'gemini-cli': { name: 'Gemini CLI', file: join(home, '.gemini', 'settings.json'), present: existsSync(join(home, '.gemini')) },
    'qwen-code': { name: 'Qwen Code', file: join(home, '.qwen', 'settings.json'), present: existsSync(join(home, '.qwen')) },
    'lm-studio': { name: 'LM Studio (Qwen, DeepSeek, Llama… on this computer)', file: join(home, '.lmstudio', 'mcp.json'), present: existsSync(join(home, '.lmstudio')) },
    vscode: { name: 'VS Code (Copilot and any model in it)', file: join(codeDir, 'mcp.json'), present: existsSync(codeDir), key: 'servers' },
    // OpenAI Codex (CLI, IDE extension and app share it): TOML, one [mcp_servers.<name>] table per server.
    codex: { name: 'OpenAI Codex', file: join(home, '.codex', 'config.toml'), present: existsSync(join(home, '.codex')) },
    // Claude Code keeps user-level servers in ~/.claude.json, a file it writes all the time: it's changed only
    // through Claude Code's own `claude mcp add/remove` (desktop/main.mjs), and only read here to show the state.
    'claude-code': { name: 'Claude Code', file: join(home, '.claude.json'), present: existsSync(join(home, '.claude')) || existsSync(join(home, '.claude.json')), cli: true },
  };
}

function readConfig(file) {
  if (!existsSync(file)) return {};
  const text = readFileSync(file, 'utf8');
  if (!text.trim()) return {};
  try {
    const j = JSON.parse(text);
    if (j && typeof j === 'object' && !Array.isArray(j)) return j;
  } catch { /* fall through */ }
  throw new Error(`${file} isn't valid JSON, so it was left untouched. Fix it, or add Constellate by hand.`);
}

/** Is Constellate set up in this agent, and does it point at this app? */
export function connection(file, entry, key = 'mcpServers') {
  if (file.endsWith('.toml')) return tomlConnection(file, entry);
  try {
    const cur = readConfig(file)[key]?.[SERVER_NAME];
    if (!cur) return 'none';
    return cur.command === entry.command && JSON.stringify(cur.args) === JSON.stringify(entry.args) ? 'connected' : 'other';
  } catch { return 'unreadable'; }
}

/** Add (or update) Constellate in an agent's config. Returns the backup path, if one was made. */
export function connect(file, entry, key = 'mcpServers') {
  if (file.endsWith('.toml')) return tomlConnect(file, entry);
  const cfg = readConfig(file);
  let backup = null;
  if (existsSync(file)) { backup = `${file}.before-constellate`; if (!existsSync(backup)) copyFileSync(file, backup); }
  cfg[key] = { ...(cfg[key] ?? {}), [SERVER_NAME]: key === 'servers' ? { type: 'stdio', ...entry } : entry };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
  return backup;
}

/** Remove Constellate from an agent's config, leaving everything else as it was. */
export function disconnect(file, key = 'mcpServers') {
  if (file.endsWith('.toml')) return tomlDisconnect(file);
  const cfg = readConfig(file);
  if (!cfg[key]?.[SERVER_NAME]) return false;
  delete cfg[key][SERVER_NAME];
  writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
  return true;
}

// ── Codex's config.toml: only Constellate's own table ([mcp_servers.constellate] and its .env) is read or
// written; every other line stays exactly as it was. TOML basic strings take the same escapes as JSON.
const OUR_TABLE = /^\s*\[\s*mcp_servers\s*\.\s*("constellate"|constellate)\s*(\.[^\]]*)?\]\s*(#.*)?$/;
const ANY_TABLE = /^\s*\[/;
function tomlSplit(text) {
  const lines = text.split(/\r?\n/), kept = [], ours = [];
  let inOurs = false;
  for (const l of lines) {
    if (ANY_TABLE.test(l)) inOurs = OUR_TABLE.test(l);
    (inOurs ? ours : kept).push(l);
  }
  return { kept, ours };
}
const tomlStr = (s) => JSON.stringify(String(s));
function tomlTable(entry) {
  const env = Object.entries(entry.env ?? {});
  return [`[mcp_servers.${SERVER_NAME}]`, `command = ${tomlStr(entry.command)}`, `args = [${entry.args.map(tomlStr).join(', ')}]`,
    ...(env.length ? ['', `[mcp_servers.${SERVER_NAME}.env]`, ...env.map(([k, v]) => `${k} = ${tomlStr(v)}`)] : [])];
}
function tomlConnection(file, entry) {
  if (!existsSync(file)) return 'none';
  const { ours } = tomlSplit(readFileSync(file, 'utf8'));
  if (!ours.length) return 'none';
  const cmd = ours.find((l) => /^\s*command\s*=/.test(l))?.split('=').slice(1).join('=').trim();
  const args = ours.find((l) => /^\s*args\s*=/.test(l))?.split('=').slice(1).join('=').trim();
  try { return JSON.parse(cmd) === entry.command && JSON.stringify(JSON.parse(args)) === JSON.stringify(entry.args) ? 'connected' : 'other'; } catch { return 'other'; }
}
function tomlConnect(file, entry) {
  let backup = null;
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (existsSync(file)) { backup = `${file}.before-constellate`; if (!existsSync(backup)) copyFileSync(file, backup); }
  const { kept } = tomlSplit(text);
  while (kept.length && !kept[kept.length - 1].trim()) kept.pop();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, [...kept, ...(kept.length ? [''] : []), ...tomlTable(entry), ''].join('\n'));
  return backup;
}
function tomlDisconnect(file) {
  if (!existsSync(file)) return false;
  const { kept, ours } = tomlSplit(readFileSync(file, 'utf8'));
  if (!ours.length) return false;
  while (kept.length && !kept[kept.length - 1].trim()) kept.pop();
  writeFileSync(file, kept.join('\n') + '\n');
  return true;
}

/** Claude Code's own command for adding Constellate for this user, as arguments (run by the app, or copied). */
export function claudeCodeArgs(entry) {
  return ['mcp', 'add', '--scope', 'user', SERVER_NAME, ...Object.entries(entry.env).flatMap(([k, v]) => ['-e', `${k}=${v}`]), '--', entry.command, ...entry.args];
}

/** A Claude Code command to copy, for people who'd rather run it themselves. */
export function claudeCodeCommand(entry) {
  const q = (s) => (/[\s"'$`\\]/.test(s) ? `"${s.replace(/(["$`\\])/g, '\\$1')}"` : s);
  const env = Object.entries(entry.env).map(([k, v]) => `-e ${k}=${q(v)}`).join(' ');
  return `claude mcp add --scope user ${SERVER_NAME} ${env} -- ${q(entry.command)} ${entry.args.map(q).join(' ')}`;
}
