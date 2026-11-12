import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { dirname, delimiter } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Hub } from '../hub/hub.js';
import { claudeBinary, claudeCodeReady, claudeKeyEnv, CLAUDE_NEEDS_KEY, EXTRA_BIN_DIRS, pick, textOf, toolLine } from '../collective/planner.js';
import { claudeRun, deniedLine } from './claude-tools.js';

/**
 * "Have your agent work on it" (docs/AGENT_STEPS.md): starts Claude Code on this computer, in the background
 * with Constellate connected, to take steps of one problem through work_step, like the planner does for plans.
 * Only Constellate's own tools are allowed. Its progress is kept as a log the app shows while it runs.
 * Other agents (Claude Desktop, Cursor…) can't be started from here; the app gives the line to tell them.
 */
export interface AgentRun { id: string; problem: string; status: 'running' | 'done' | 'failed'; at: string; log: { at: string; text: string }[]; steps: number }

const MAX_STEPS = 3;

export class AgentRuns {
  private runs = new Map<string, AgentRun>();
  constructor(private readonly hub: Hub) {}

  get(id: string) { return this.runs.get(id) ?? null; }
  forProblem(problem: string) { return [...this.runs.values()].filter((r) => r.problem === problem).sort((a, b) => b.at.localeCompare(a.at)); }
  /** Installed, with a Claude API key to run it on (never a Claude plan: claudeKeyEnv). */
  available() { return claudeCodeReady(); }

  /** The line to give any connected agent. */
  prompt(problem: string, steps = MAX_STEPS) {
    const title = (this.hub.problems.get(problem)?.rec.body as { title?: string } | undefined)?.title ?? 'this problem';
    return `Use Constellate's work_step tool to help with "${title}" (problem ${problem}). Call work_step with problem "${problem}" to see its open steps, do one carefully with your own model, and submit your answer with work_step (say which model you are). Do up to ${steps} steps, then stop.`;
  }

  private note(r: AgentRun, text: string) { r.log.push({ at: new Date().toISOString(), text: text.slice(0, 300) }); if (r.log.length > 80) r.log.shift(); }

  start(problem: string): AgentRun {
    if (!this.hub.problems.get(problem)) throw new Error('unknown problem');
    const running = this.forProblem(problem).find((r) => r.status === 'running');
    if (running) return running; // one at a time per problem
    const bin = claudeBinary();
    if (!bin) throw new Error('Claude Code isn’t installed on this computer');
    const keyed = claudeKeyEnv();
    if (!keyed) throw new Error(CLAUDE_NEEDS_KEY);
    const r: AgentRun = { id: randomBytes(6).toString('hex'), problem, status: 'running', at: new Date().toISOString(), log: [], steps: 0 };
    this.runs.set(r.id, r);
    this.note(r, 'Starting Claude Code on this computer…');
    const cli = process.argv[1];
    const mcp = { mcpServers: { constellate: { command: process.execPath, args: [cli, 'mcp'], env: { ...pick(process.env, ['CONSTELLATE_HOME', 'X0X_DATA_DIR', 'X0X_API', 'ELECTRON_RUN_AS_NODE']), CONSTELLATE_APP_URL: process.env.CONSTELLATE_APP_URL ?? `http://127.0.0.1:${process.env.PORT ?? 4747}` } } } };
    const PATH = [dirname(bin), ...EXTRA_BIN_DIRS, process.env.PATH ?? ''].filter(Boolean).join(delimiter);
    const env = { ...keyed, PATH };
    // Only what it may use, decided up front: nobody is there to approve a tool while it runs (src/work/claude-tools.ts).
    const run = claudeRun(bin, { prompt: this.prompt(problem), mcp, mcpTools: ['work_step', 'failures_search', 'answers_lookup', 'skills_find'], env });
    this.note(r, `It may use Constellate's tools${run.tools.web ? ', web search and web fetch' : ''}${run.tools.code ? ', and run code in a scratch folder' : ''}.`);
    const child = spawn(bin, run.args, { cwd: run.cwd, stdio: ['ignore', 'pipe', 'pipe'], env });
    let err = '', last = '';
    child.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    createInterface({ input: child.stdout }).on('line', (line) => {
      let ev: { type?: string; subtype?: string; model?: string; mcp_servers?: { name: string; status: string }[]; message?: { content?: { type: string; name?: string; text?: string; input?: Record<string, unknown>; is_error?: boolean; content?: unknown }[] }; result?: string; duration_ms?: number; total_cost_usd?: number; is_error?: boolean; permission_denials?: { tool_name?: string }[] };
      try { ev = JSON.parse(line); } catch { return; }
      if (ev.type === 'system' && ev.subtype === 'init') {
        const c = ev.mcp_servers?.find((m) => m.name === 'constellate');
        this.note(r, c && c.status !== 'connected' ? `Claude Code started, but Constellate's tools didn't connect (${c.status}).` : `Claude Code started${ev.model ? ` (${ev.model})` : ''} with Constellate connected.`);
      } else if (ev.type === 'assistant') {
        for (const c of ev.message?.content ?? []) {
          if (c.type === 'tool_use' && c.name) { this.note(r, toolLine(c.name, c.input ?? {})); if (c.name.endsWith('work_step') && c.input?.answer) r.steps++; }
          if (c.type === 'text' && c.text?.trim()) last = c.text;
        }
      } else if (ev.type === 'user') {
        for (const c of ev.message?.content ?? []) if (c.type === 'tool_result' && c.is_error) this.note(r, `A tool call failed: ${textOf(c.content).slice(0, 220)}`);
      } else if (ev.type === 'result') {
        if (typeof ev.result === 'string' && ev.result.trim()) last = ev.result;
        const denied = (ev.permission_denials ?? []).map((d) => d.tool_name).filter((x): x is string => !!x);
        if (denied.length) this.note(r, deniedLine(denied));
        this.note(r, `Claude Code finished in ${Math.round((ev.duration_ms ?? 0) / 1000)} s${ev.total_cost_usd ? ` (about $${ev.total_cost_usd.toFixed(2)}, billed to your Claude API key)` : ''}.`);
      }
    });
    const timer = setTimeout(() => child.kill(), 30 * 60_000);
    child.on('error', (e) => { clearTimeout(timer); r.status = 'failed'; this.note(r, `Claude Code couldn’t start: ${e.message}`); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (r.status !== 'running') return;
      r.status = r.steps ? 'done' : 'failed';
      if (r.steps) this.note(r, `Answered ${r.steps} step${r.steps === 1 ? '' : 's'}. Each waits for a computer running a different model family to check it.`);
      else this.note(r, `Stopped without answering a step${code ? ` (exit ${code}${err.trim() ? `: ${err.trim().slice(-200)}` : ''})` : ''}.${last.trim() ? ` Its last words: “${last.trim().replace(/\s+/g, ' ').slice(0, 220)}”` : ''}`);
    });
    return r;
  }
}
