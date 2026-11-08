// Connecting AI agents (Claude Desktop, Cursor, Claude Code) to the Constellate in this app.
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
  try {
    const cur = readConfig(file)[key]?.[SERVER_NAME];
    if (!cur) return 'none';
    return cur.command === entry.command && JSON.stringify(cur.args) === JSON.stringify(entry.args) ? 'connected' : 'other';
  } catch { return 'unreadable'; }
}

/** Add (or update) Constellate in an agent's config. Returns the backup path, if one was made. */
export function connect(file, entry, key = 'mcpServers') {
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
  const cfg = readConfig(file);
  if (!cfg[key]?.[SERVER_NAME]) return false;
  delete cfg[key][SERVER_NAME];
  writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
  return true;
}

/** A Claude Code command to copy (Claude Code keeps its own config; we never edit it). */
export function claudeCodeCommand(entry) {
  const q = (s) => (/[\s"'$`\\]/.test(s) ? `"${s.replace(/(["$`\\])/g, '\\$1')}"` : s);
  const env = Object.entries(entry.env).map(([k, v]) => `-e ${k}=${q(v)}`).join(' ');
  return `claude mcp add ${SERVER_NAME} ${env} -- ${q(entry.command)} ${entry.args.map(q).join(' ')}`;
}
