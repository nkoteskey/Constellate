import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * What Claude Code may use when the app starts it to work on a problem or plan an idea (docs/AGENT_STEPS.md).
 * Nobody is there to approve a tool while it runs, so it's decided up front:
 *  - always: Constellate's own tools;
 *  - web research (on by default): WebSearch and WebFetch, read-only;
 *  - running code (off by default, the person turns it on): Bash and the file tools, in a fresh scratch folder.
 * Claude Code is only shown the tools it may use (--tools), anything else is refused at once rather than waiting
 * for an approval nobody can give (--permission-mode dontAsk), and the person's own Claude Code settings don't
 * apply (--restricted, which also keeps the file tools inside the scratch folder). When it still asks for
 * something it can't have, the run's log says so and names the switch.
 */
export interface AgentTools { web: boolean; code: boolean }
export const AGENT_TOOL_DEFAULTS: AgentTools = { web: true, code: false };

const home = () => process.env.CONSTELLATE_HOME ?? join(homedir(), '.constellate');
const file = () => join(home(), 'agent-tools.json');

export function agentTools(): AgentTools {
  try { const j = JSON.parse(readFileSync(file(), 'utf8')) as Partial<AgentTools>; return { web: j.web ?? AGENT_TOOL_DEFAULTS.web, code: j.code ?? AGENT_TOOL_DEFAULTS.code }; } catch { return { ...AGENT_TOOL_DEFAULTS }; }
}
export function setAgentTools(patch: Partial<AgentTools>): AgentTools {
  const next = { ...agentTools(), ...(typeof patch.web === 'boolean' ? { web: patch.web } : {}), ...(typeof patch.code === 'boolean' ? { code: patch.code } : {}) };
  mkdirSync(home(), { recursive: true });
  writeFileSync(file(), JSON.stringify(next));
  return next;
}

export const WEB_TOOLS = ['WebSearch', 'WebFetch'];
export const CODE_TOOLS = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'];

/** Which flags this computer's Claude Code understands (older versions lack some): read once from its --help. */
const helpCache = new Map<string, string>();
function supports(bin: string, flag: string, env: NodeJS.ProcessEnv) {
  if (!helpCache.has(bin)) {
    let text = '';
    try { text = execFileSync(bin, ['--help'], { encoding: 'utf8', timeout: 8000, env }); } catch { /* unknown: pass no optional flags */ }
    helpCache.set(bin, text);
  }
  return helpCache.get(bin)!.includes(flag);
}

/** The arguments and working folder for a headless Claude Code run with these Constellate tools. */
export function claudeRun(bin: string, o: { prompt: string; mcp: unknown; mcpTools: string[]; env: NodeJS.ProcessEnv; tools?: AgentTools }) {
  const t = o.tools ?? agentTools();
  const builtin = [...(t.web ? WEB_TOOLS : []), ...(t.code ? CODE_TOOLS : [])];
  const allowed = [...o.mcpTools.map((x) => `mcp__constellate__${x}`), ...builtin];
  const args = ['-p', `${o.prompt}\n\n${toolsNote(t)}`, '--mcp-config', JSON.stringify(o.mcp), '--strict-mcp-config', '--allowedTools', allowed.join(','), '--output-format', 'stream-json', '--verbose'];
  if (supports(bin, '--tools', o.env)) args.push('--tools', builtin.join(','));
  if (supports(bin, '--restricted', o.env)) args.push('--restricted');
  if (supports(bin, 'dontAsk', o.env)) args.push('--permission-mode', 'dontAsk');
  // A fresh folder of its own: scratch files for code it runs, and nothing else of the person's in reach.
  mkdirSync(join(home(), 'agent-work'), { recursive: true });
  const cwd = mkdtempSync(join(home(), 'agent-work', 'run-'));
  return { args, cwd, tools: t };
}

/** Told to Claude Code up front, so it doesn't spend turns on tools it can't have. */
export function toolsNote(t: AgentTools) {
  const have = ['Constellate\'s tools', ...(t.web ? ['web search and web fetch (read-only)'] : []), ...(t.code ? ['Bash and the file tools, inside the current folder only'] : [])];
  return `You are running unattended: nobody can approve anything while you work. You can use ${have.join(', ')}; nothing else is available.${t.code ? '' : ' You can\'t run code here.'} If a step needs something you can't do with these, say so in one line in your answer and move on.`;
}

/** What the log says when Claude Code asked for something this run doesn't allow. */
export function deniedLine(tools: string[]) {
  const names = [...new Set(tools)];
  const code = names.some((n) => CODE_TOOLS.includes(n));
  const web = names.some((n) => WEB_TOOLS.includes(n));
  return `Claude Code wanted ${names.join(', ')}, which this run doesn't allow.${code ? ' To let it run code, turn on “Run code in a scratch folder”.' : web ? ' To let it use the web, turn on “Search and read the web”.' : ''}`;
}
