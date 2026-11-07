import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, delimiter } from 'node:path';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import type { Hub } from '../hub/hub.js';
import type { ModelRunner } from '../contributor/models.js';
import { ProblemBody, REALMS } from '../work/problems.js';

/**
 * Planning an idea with an agent: the idea is handed to an agent, which researches related work and reports
 * a plan in the network's format (a problem with machine-checkable steps, plus what it found). The plan is
 * validated on arrival (schema, registered checks, the constitution) and waits for the person to publish it.
 *
 * Who plans: Claude Code on this computer, started in the background and connected to Constellate; or the
 * model this app is set to use; or any connected agent, next time it's used (it sees the request through
 * the plan_report tool). The agent never publishes: the person does, after reading the plan.
 */
export const PlanReport = z.object({
  plan: z.object({
    title: z.string().min(3).max(200),
    hook: z.string().max(140).default(''),
    goal: z.string().min(10).max(2000),
    realm: z.enum(REALMS),
    verifier: z.string().describe('The check every step uses: exact, lean, sum_squares_mod, or another registered verifier.'),
    done_description: z.string().min(10).max(1000),
    steps: z.array(z.object({ key: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/), title: z.string().min(3).max(200), prompt: z.string().min(10).max(8000), check: z.record(z.unknown()), size: z.enum(['small', 'large', 'any']).default('any') })).min(1).max(60),
  }),
  findings: z.object({
    related: z.array(z.object({ id: z.string().optional(), title: z.string(), why: z.string() })).max(10).default([]),
    risks: z.array(z.string().max(400)).max(8).default([]),
    open_questions: z.array(z.string().max(400)).max(8).default([]),
    why_checkable: z.string().max(800),
  }),
});
export type PlanReport = z.infer<typeof PlanReport>;

export type PlanVia = 'claude_code' | 'model' | 'any_agent';
export interface PlanRequest {
  id: string; idea: string; title: string; via: PlanVia; status: 'waiting' | 'running' | 'reported' | 'failed' | 'published' | 'discarded';
  at: string; updated: string; report?: PlanReport; problems?: string[]; error?: string; agent?: string; published?: string;
  /** What actually happened, in order, so the person can see the agent at work (and that it ran at all). */
  log?: { at: string; text: string }[];
}

/** MCP client names as people know them. */
export function agentName(client?: string): string {
  const c = (client ?? '').toLowerCase();
  if (!c) return 'An agent';
  if (c === 'claude-ai' || c.includes('claude-desktop')) return 'Claude Desktop';
  if (c.includes('claude-code')) return 'Claude Code';
  if (c.includes('cursor')) return 'Cursor';
  if (c.includes('windsurf') || c.includes('codeium')) return 'Windsurf';
  if (c.includes('gemini')) return 'Gemini CLI';
  if (c.includes('codex')) return 'OpenAI Codex';
  if (c.includes('vscode') || c.includes('visual studio code')) return 'VS Code';
  if (c.includes('lm studio') || c.includes('lmstudio')) return 'LM Studio';
  return client!.slice(0, 40);
}

const MAX_STEPS_BRIEF = 12;

export class Planner {
  private readonly file: string;
  private runs = new Map<string, { kill(): void }>();
  constructor(private readonly hub: Hub, private readonly model?: ModelRunner, home = process.env.CONSTELLATE_HOME ?? join(homedir(), '.constellate')) {
    this.file = join(home, 'plans.json');
  }

  private all(): PlanRequest[] { try { return JSON.parse(readFileSync(this.file, 'utf8')) as PlanRequest[]; } catch { return []; } }
  private save(list: PlanRequest[]) { mkdirSync(dirname(this.file), { recursive: true }); writeFileSync(this.file, JSON.stringify(list.slice(-200), null, 1)); }
  private put(r: PlanRequest) { const list = this.all().filter((x) => x.id !== r.id); list.push({ ...r, updated: new Date().toISOString() }); this.save(list); return r; }
  /** Add a line to a request's activity log. */
  note(id: string, text: string) { const r = this.get(id); if (r) this.put({ ...r, log: [...(r.log ?? []), { at: new Date().toISOString(), text: text.slice(0, 300) }].slice(-60) }); }
  /** A connected agent read the waiting requests (through plan_report): say who, once each. */
  pickedUp(agent: string) {
    for (const r of this.pending()) {
      if (r.agent === agent) continue;
      this.put({ ...r, agent, status: 'running', log: [...(r.log ?? []), { at: new Date().toISOString(), text: `${agent} picked this up and is researching it.` }].slice(-60) });
    }
  }
  get(id: string) { return this.all().find((r) => r.id === id) ?? null; }
  list(idea?: string) { return this.all().filter((r) => !idea || r.idea === idea).reverse(); }
  /** Requests a connected agent can take: waiting ones, and ones an agent picked up but hasn't reported yet. */
  pending() { return this.all().filter((r) => r.status === 'waiting' || (r.status === 'running' && r.via === 'any_agent')); }

  /** Which agents can plan on this computer right now. */
  options(): { claude_code: boolean; model: string | null } {
    return { claude_code: !!claudeBinary(), model: this.model?.id ?? null };
  }

  private idea(id: string) {
    const s = this.hub.node.store.get(id);
    if (!s || s.rec.kind !== 'proposal') throw new Error('unknown idea');
    return s.rec.body as { title: string; goal: string; done: string; check?: string; realm?: string };
  }

  /** What the agent is asked to do, with the context it needs and the exact format to report in. */
  brief(requestId: string) {
    const r = this.get(requestId);
    if (!r) throw new Error('unknown planning request');
    const i = this.idea(r.idea);
    const related = this.hub.problems.list().slice(-40).map((p) => { const b = p.rec.body as { title: string; hook?: string }; return `- ${b.title} [${p.rec.id.slice(0, 12)}]`; }).slice(0, 15).join('\n') || '- (none yet)';
    return `Turn this idea into a problem the Constellate network can work on, then report it with the plan_report tool (request "${r.id}").

Idea: ${i.title}
Goal: ${i.goal}
Done means: ${i.done}${i.check ? `\nHow the proposer would check it: ${i.check}` : ''}${i.realm ? `\nRealm: ${i.realm}` : ''}

Do this:
1. Research first: use failures_search and answers_lookup for related work and known traps. Existing problems:
${related}
2. Split the work into small steps (at most ${MAX_STEPS_BRIEF} to start) that a machine can check without a person: each step has a prompt someone else's model can work on, and a "check" for the verifier. Registered verifiers: ${this.hub.problems.verifiers.names().join(', ')}. ("exact" checks {"expected": "<last token of the answer>"}; "lean" checks {"statement": "<theorem>"}.)
3. Call plan_report with request "${r.id}" and:
   plan: { title, hook (one line), goal, realm (one of ${REALMS.join(', ')}), verifier, done_description, steps: [{ key, title, prompt, check, size }] }
   findings: { related: [{ id?, title, why }], risks: [..], open_questions: [..], why_checkable }
Report only what you found; don't publish anything. The person reviews the plan before it goes live.
If plan_report isn't available or keeps failing, end your reply with the same { "plan": …, "findings": … } as one JSON object instead.`;
  }

  /** Start planning an idea with one of the available agents. */
  async start(ideaId: string, via: PlanVia) {
    const i = this.idea(ideaId);
    const now = new Date().toISOString();
    const first = via === 'any_agent' ? 'Waiting for a connected agent. Open Claude Desktop, Cursor or another agent connected to Constellate and say: “check Constellate for planning requests”.'
      : via === 'model' ? `Asked ${this.model?.id ?? 'this app’s model'} to write the plan.` : 'Starting Claude Code on this computer…';
    const r = this.put({ id: randomBytes(6).toString('hex'), idea: ideaId, title: i.title, via, status: via === 'any_agent' ? 'waiting' : 'running', at: now, updated: now, log: [{ at: now, text: first }] });
    if (via === 'model') void this.runModel(r.id);
    if (via === 'claude_code') this.runClaudeCode(r.id);
    return r;
  }

  /** Validate a report and keep it for the person to review. Never publishes. */
  async report(requestId: string, raw: unknown, agent = 'agent'): Promise<PlanRequest> {
    const r = this.get(requestId);
    if (!r) throw new Error('unknown planning request');
    if (!['waiting', 'running', 'failed', 'reported'].includes(r.status)) throw new Error(`this request is already ${r.status}`);
    const parsed = PlanReport.safeParse(raw);
    if (!parsed.success) throw new Error(`the report doesn't match the format: ${parsed.error.issues.slice(0, 4).map((x) => `${x.path.join('.')}: ${x.message}`).join('; ')}`);
    const rep = parsed.data;
    const problems: string[] = [];
    if (!this.hub.problems.verifiers.get(rep.plan.verifier)) problems.push(`"${rep.plan.verifier}" isn't a registered check (${this.hub.problems.verifiers.names().join(', ')})`);
    const keys = new Set<string>();
    for (const s of rep.plan.steps) { if (keys.has(s.key)) problems.push(`step key "${s.key}" is used twice`); keys.add(s.key); if (!Object.keys(s.check).length) problems.push(`step "${s.key}" has no check`); }
    const check = await this.hub.collective.constitution.checkProposal(this.problemBody(rep));
    if (!check.ok) problems.push(`the constitution check would block it: ${check.findings.filter((f) => f.severity === 'block').map((f) => f.detail).join('; ') || 'see the check'}`);
    const who = agentName(agent);
    const log = [...(r.log ?? []), { at: new Date().toISOString(), text: `${who} reported a plan: ${rep.plan.steps.length} step${rep.plan.steps.length === 1 ? '' : 's'}, ${rep.findings.related.length} related item${rep.findings.related.length === 1 ? '' : 's'} found.${problems.length ? ` ${problems.length} thing${problems.length === 1 ? '' : 's'} to fix before it can go live.` : ' Ready for you to review.'}` }].slice(-60);
    return this.put({ ...r, status: 'reported', report: rep, problems, agent: who, error: undefined, log });
  }

  private problemBody(rep: PlanReport) {
    return ProblemBody.parse({ title: rep.plan.title, hook: rep.plan.hook, goal: rep.plan.goal, realm: rep.plan.realm, definition_of_done: { verifier: rep.plan.verifier, description: rep.plan.done_description }, chunks: rep.plan.steps.map((s) => ({ key: s.key, title: s.title, prompt: s.prompt, check: s.check, needs: { size: s.size } })) });
  }

  /** The person approved: publish the plan as a live problem (the constitution checks it again). */
  async publish(requestId: string) {
    const r = this.get(requestId);
    if (!r?.report) throw new Error('nothing to publish yet');
    if (r.problems?.length) throw new Error(`fix these first: ${r.problems.join('; ')}`);
    const out = await this.hub.collective.propose(this.problemBody(r.report));
    if (!out.problem) throw new Error('the constitution check blocked it');
    this.put({ ...r, status: 'published', published: out.problem.id, log: [...(r.log ?? []), { at: new Date().toISOString(), text: 'Published as a live problem. It moves to “Being worked on” as votes give it computer time.' }].slice(-60) });
    return out.problem.id;
  }

  discard(requestId: string) { const r = this.get(requestId); if (!r) throw new Error('unknown planning request'); this.runs.get(requestId)?.kill(); return this.put({ ...r, status: 'discarded' }); }

  private fail(id: string, error: string) { const r = this.get(id); if (r && r.status === 'running') this.put({ ...r, status: 'failed', error, log: [...(r.log ?? []), { at: new Date().toISOString(), text: `Stopped: ${error}`.slice(0, 300) }].slice(-60) }); }

  /** The model this app uses writes the plan (JSON in its reply), and it's validated like any report. */
  private async runModel(id: string) {
    if (!this.model) return this.fail(id, 'no model is set up for this app');
    try {
      const t0 = Date.now();
      const out = await this.model.run(`${this.brief(id)}\n\nYou can't call tools here: reply with ONLY the JSON object { "plan": …, "findings": … } described above.`, { maxTokens: 4000 });
      this.note(id, `${this.model.id} replied after ${Math.round((Date.now() - t0) / 1000)} s; checking the plan.`);
      const json = out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1);
      await this.report(id, JSON.parse(json), this.model.id);
    } catch (e) { this.fail(id, `the model's plan couldn't be used: ${(e as Error).message.slice(0, 300)}`); }
  }

  /**
   * Claude Code on this computer, started headless with Constellate connected. It researches with Constellate's
   * tools and reports through plan_report, which comes back to this app. Only Constellate's own tools are allowed:
   * `--tools ""` turns off Claude Code's built-in tools (shell, files, web), which the person's own Claude Code
   * permission settings would otherwise let it use.
   */
  private runClaudeCode(id: string) {
    const bin = claudeBinary();
    if (!bin) return this.fail(id, 'Claude Code isn’t installed on this computer');
    const cli = process.argv[1];
    const mcp = { mcpServers: { constellate: { command: process.execPath, args: [cli, 'mcp'], env: { ...pick(process.env, ['CONSTELLATE_HOME', 'X0X_DATA_DIR', 'X0X_API', 'ELECTRON_RUN_AS_NODE']), CONSTELLATE_APP_URL: process.env.CONSTELLATE_APP_URL ?? `http://127.0.0.1:${process.env.PORT ?? 4747}` } } } };
    const allowed = ['plan_report', 'failures_search', 'answers_lookup', 'skills_find'].map((t) => `mcp__constellate__${t}`).join(',');
    // Apps opened from the Dock get a bare PATH, and `claude` is a Node script: give it the usual places Node lives.
    const PATH = [dirname(bin), ...EXTRA_BIN_DIRS, process.env.PATH ?? ''].filter(Boolean).join(delimiter);
    // Constellate's server can take longer than Claude Code's 30 s default to answer on a slow or busy computer
    // (an Intel build running under Rosetta took 22–42 s): give it two minutes unless the person set their own.
    const MCP_TIMEOUT = process.env.MCP_TIMEOUT || '120000';
    const child = spawn(bin, ['-p', this.brief(id), '--mcp-config', JSON.stringify(mcp), '--strict-mcp-config', '--tools', '', '--allowedTools', allowed, '--output-format', 'stream-json', '--verbose'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PATH, MCP_TIMEOUT } });
    let err = '';
    child.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    // Its progress, streamed as JSON lines: say when it starts, each Constellate tool it uses, and how it ended.
    createInterface({ input: child.stdout }).on('line', (line) => {
      let ev: { type?: string; subtype?: string; model?: string; mcp_servers?: { name: string; status: string }[]; message?: { content?: { type: string; name?: string; text?: string; input?: Record<string, unknown>; is_error?: boolean; content?: unknown }[] }; is_error?: boolean; duration_ms?: number; total_cost_usd?: number; result?: string };
      try { ev = JSON.parse(line); } catch { return; }
      if (ev.type === 'system' && ev.subtype === 'init') {
        const c = ev.mcp_servers?.find((m) => m.name === 'constellate');
        this.note(id, c && c.status !== 'connected' ? `Claude Code started${ev.model ? ` (${ev.model})` : ''}, but Constellate's tools didn't connect (${c.status}), so it can't search or report back.` : `Claude Code started${ev.model ? ` (${ev.model})` : ''} with Constellate connected.`);
      } else if (ev.type === 'assistant') {
        for (const c of ev.message?.content ?? []) {
          if (c.type === 'tool_use' && c.name) this.note(id, toolLine(c.name, c.input ?? {}));
          if (c.type === 'text' && c.text?.trim()) lastText = c.text;
        }
      } else if (ev.type === 'user') {
        // A tool call that failed: say why, so a plan that was rejected doesn't vanish silently.
        for (const c of ev.message?.content ?? []) if (c.type === 'tool_result' && c.is_error) this.note(id, `A tool call failed: ${textOf(c.content).slice(0, 220)}`);
      } else if (ev.type === 'result') {
        if (typeof ev.result === 'string' && ev.result.trim()) lastText = ev.result;
        this.note(id, `Claude Code finished in ${Math.round((ev.duration_ms ?? 0) / 1000)} s${ev.total_cost_usd ? ` (about $${ev.total_cost_usd.toFixed(2)} of your Claude usage)` : ''}${ev.is_error ? `, with an error: ${String(ev.result ?? '').slice(0, 200)}` : ''}.`);
      }
    });
    let lastText = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 15 * 60_000);
    this.runs.set(id, { kill: () => child.kill() });
    child.on('error', (e) => { clearTimeout(timer); this.fail(id, `Claude Code couldn’t start: ${e.message}`); });
    child.on('close', async (code) => {
      clearTimeout(timer); this.runs.delete(id);
      if (this.get(id)?.status !== 'running') return;
      // It didn't call plan_report: if it wrote the plan out instead, take that (checked like any report).
      const json = lastText.slice(lastText.indexOf('{'), lastText.lastIndexOf('}') + 1);
      if (json.length > 2) {
        try { await this.report(id, JSON.parse(json), 'Claude Code'); this.note(id, 'Took the plan from Claude Code’s reply (it didn’t send it through plan_report).'); return; } catch { /* not a plan: say what it said */ }
      }
      if (this.get(id)?.status !== 'running') return;
      const said = lastText.trim() ? ` Its last words: “${lastText.trim().replace(/\s+/g, ' ').slice(0, 240)}”` : '';
      this.fail(id, timedOut ? `Claude Code ran for 15 minutes without reporting a plan, so it was stopped.${said}` : code === 0 ? `Claude Code finished without reporting a plan.${said}` : `Claude Code stopped (${code}): ${err.trim().slice(-300) || 'no error output'}${said}`);
    });
  }
}

/** The text of a tool result, however it's shaped. */
function textOf(c: unknown): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((x) => (x as { text?: string })?.text ?? '').join(' ');
  return JSON.stringify(c ?? '');
}

/** One line for a tool an agent used while planning. */
function toolLine(name: string, input: Record<string, unknown>) {
  const tool = name.replace(/^mcp__constellate__/, '');
  const q = String(input.query ?? input.question ?? input.approach ?? '').slice(0, 120);
  if (tool === 'failures_search') return `Searched what already failed: “${q}”`;
  if (tool === 'answers_lookup') return `Looked for solved answers: “${q}”`;
  if (tool === 'skills_find') return `Looked for skills: “${q}”`;
  if (tool === 'plan_report') return input.plan ? 'Sent its plan back to this app.' : 'Read the planning request.';
  return `Used ${tool}`;
}

/** Where `claude` and Node usually live, which an app opened from the Dock or Start menu doesn't have on PATH. */
const EXTRA_BIN_DIRS = process.platform === 'win32'
  ? [join(process.env.APPDATA ?? '', 'npm'), join(homedir(), '.claude', 'local')]
  : ['/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.local', 'bin'), join(homedir(), '.claude', 'local'), join(homedir(), '.npm-global', 'bin'), join(homedir(), '.volta', 'bin'), join(homedir(), '.bun', 'bin')];

const pick = (env: NodeJS.ProcessEnv, keys: string[]) => Object.fromEntries(keys.filter((k) => env[k]).map((k) => [k, env[k]!]));

/** The `claude` command, if Claude Code is installed (CONSTELLATE_CLAUDE overrides; "off" disables). */
export function claudeBinary(): string | null {
  const o = process.env.CONSTELLATE_CLAUDE;
  if (o === 'off') return null;
  if (o) return existsSync(o) ? o : null;
  const names = process.platform === 'win32' ? ['claude.exe', 'claude.cmd'] : ['claude'];
  for (const dir of [...(process.env.PATH ?? '').split(delimiter), ...EXTRA_BIN_DIRS]) for (const n of names) if (dir && existsSync(join(dir, n))) return join(dir, n);
  return null;
}
