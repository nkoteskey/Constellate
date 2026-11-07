import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, delimiter } from 'node:path';
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
  get(id: string) { return this.all().find((r) => r.id === id) ?? null; }
  list(idea?: string) { return this.all().filter((r) => !idea || r.idea === idea).reverse(); }
  pending() { return this.all().filter((r) => r.status === 'waiting'); }

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
Report only what you found; don't publish anything. The person reviews the plan before it goes live.`;
  }

  /** Start planning an idea with one of the available agents. */
  async start(ideaId: string, via: PlanVia) {
    const i = this.idea(ideaId);
    const r = this.put({ id: randomBytes(6).toString('hex'), idea: ideaId, title: i.title, via, status: via === 'any_agent' ? 'waiting' : 'running', at: new Date().toISOString(), updated: new Date().toISOString() });
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
    return this.put({ ...r, status: 'reported', report: rep, problems, agent, error: undefined });
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
    this.put({ ...r, status: 'published', published: out.problem.id });
    return out.problem.id;
  }

  discard(requestId: string) { const r = this.get(requestId); if (!r) throw new Error('unknown planning request'); this.runs.get(requestId)?.kill(); return this.put({ ...r, status: 'discarded' }); }

  private fail(id: string, error: string) { const r = this.get(id); if (r && r.status === 'running') this.put({ ...r, status: 'failed', error }); }

  /** The model this app uses writes the plan (JSON in its reply), and it's validated like any report. */
  private async runModel(id: string) {
    if (!this.model) return this.fail(id, 'no model is set up for this app');
    try {
      const out = await this.model.run(`${this.brief(id)}\n\nYou can't call tools here: reply with ONLY the JSON object { "plan": …, "findings": … } described above.`, { maxTokens: 4000 });
      const json = out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1);
      await this.report(id, JSON.parse(json), this.model.id);
    } catch (e) { this.fail(id, `the model's plan couldn't be used: ${(e as Error).message.slice(0, 300)}`); }
  }

  /**
   * Claude Code on this computer, started headless with Constellate connected. It researches with Constellate's
   * tools and reports through plan_report, which comes back to this app. Only Constellate's own tools are allowed.
   */
  private runClaudeCode(id: string) {
    const bin = claudeBinary();
    if (!bin) return this.fail(id, 'Claude Code isn’t installed on this computer');
    const cli = process.argv[1];
    const mcp = { mcpServers: { constellate: { command: process.execPath, args: [cli, 'mcp'], env: { ...pick(process.env, ['CONSTELLATE_HOME', 'X0X_DATA_DIR', 'X0X_API', 'ELECTRON_RUN_AS_NODE']), CONSTELLATE_APP_URL: process.env.CONSTELLATE_APP_URL ?? `http://127.0.0.1:${process.env.PORT ?? 4747}` } } } };
    const allowed = ['plan_report', 'failures_search', 'answers_lookup', 'skills_find'].map((t) => `mcp__constellate__${t}`).join(',');
    const child = spawn(bin, ['-p', this.brief(id), '--mcp-config', JSON.stringify(mcp), '--strict-mcp-config', '--allowedTools', allowed, '--output-format', 'json'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => child.kill(), 15 * 60_000);
    this.runs.set(id, { kill: () => child.kill() });
    child.on('error', (e) => { clearTimeout(timer); this.fail(id, `Claude Code couldn’t start: ${e.message}`); });
    child.on('close', (code) => {
      clearTimeout(timer); this.runs.delete(id);
      const r = this.get(id);
      if (r?.status === 'running') this.fail(id, code === 0 ? 'Claude Code finished without reporting a plan' : `Claude Code stopped (${code}): ${err.slice(-300)}`);
    });
  }
}

const pick = (env: NodeJS.ProcessEnv, keys: string[]) => Object.fromEntries(keys.filter((k) => env[k]).map((k) => [k, env[k]!]));

/** The `claude` command, if Claude Code is installed (CONSTELLATE_CLAUDE overrides; "off" disables). */
export function claudeBinary(): string | null {
  const o = process.env.CONSTELLATE_CLAUDE;
  if (o === 'off') return null;
  if (o) return existsSync(o) ? o : null;
  const names = process.platform === 'win32' ? ['claude.exe', 'claude.cmd'] : ['claude'];
  for (const dir of [...(process.env.PATH ?? '').split(delimiter), join(homedir(), '.claude', 'local'), join(homedir(), '.local', 'bin')]) for (const n of names) if (dir && existsSync(join(dir, n))) return join(dir, n);
  return null;
}
