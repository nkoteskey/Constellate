import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { Hub } from '../hub/hub.js';
import type { ModelRunner } from '../contributor/models.js';
import { PROVIDERS, runnerFromSpec, ollamaUrl } from '../contributor/catalog.js';
import { KeyVault } from '../contributor/keyvault.js';
import { openSteps, submitStep } from './agent-step.js';
import type { AgentRun } from './agent-runs.js';

/**
 * "Have your agent work on it" with any make and model (docs/AGENT_STEPS.md). When Claude Code isn't installed,
 * the app does the steps itself with a model this computer can reach:
 *  - a model running locally (Ollama, LM Studio), free;
 *  - any provider whose key is saved in the app's encrypted key store (`constellate keys set PROVIDER`) or in its
 *    usual environment variable: OpenAI, Gemini, Anthropic, Mistral, Groq, OpenRouter, DeepSeek, xAI…;
 *  - the model the app was started with (`constellate serve --model`).
 * Each answer records which model made it and still has to pass a check by a computer running a different model
 * family. The step's check (which can hold the answer) is never sent to the model.
 */
export interface ReachableModel { spec: string; name: string; where: 'local' | 'key' | 'app'; note: string }

const vaultFile = () => join(process.env.CONSTELLATE_HOME ?? join(homedir(), '.constellate'), 'keys.json');
let vault: KeyVault | undefined;
export const appVault = () => (vault ??= new KeyVault(vaultFile()));

async function getJson(url: string, ms = 800): Promise<unknown> {
  try { const r = await fetch(url, { signal: AbortSignal.timeout(ms) }); return r.ok ? await r.json() : null; } catch { return null; }
}

/** Every model this computer can use right now, local and free first. */
export async function reachableModels(opts: { appModel?: ModelRunner; env?: NodeJS.ProcessEnv; vault?: { names(): string[] } } = {}): Promise<ReachableModel[]> {
  const env = opts.env ?? process.env;
  const out: ReachableModel[] = [];
  if (opts.appModel) out.push({ spec: opts.appModel.id.replace(':', '/'), name: opts.appModel.id.split(':').slice(1).join(':'), where: 'app', note: 'the model this app was started with' });
  const [ollama, lmstudio] = await Promise.all([getJson(`${ollamaUrl(env)}/api/tags`), getJson('http://127.0.0.1:1234/v1/models')]);
  for (const m of ((ollama as { models?: { name: string }[] } | null)?.models ?? []).slice(0, 8)) {
    if (/embed/i.test(m.name)) continue;
    out.push({ spec: `ollama/${m.name}`, name: m.name, where: 'local', note: 'Ollama on this computer, free' });
  }
  for (const m of ((lmstudio as { data?: { id: string }[] } | null)?.data ?? []).slice(0, 8)) {
    if (/embed/i.test(m.id)) continue;
    out.push({ spec: `lmstudio/${m.id}`, name: m.id, where: 'local', note: 'LM Studio on this computer, free' });
  }
  let saved: string[] = [];
  try { saved = (opts.vault ?? appVault()).names(); } catch { /* no key store yet */ }
  for (const p of PROVIDERS) {
    if (p.kind !== 'hosted') continue;
    const has = saved.includes(p.id) || (p.keyEnv && env[p.keyEnv]);
    if (has) out.push({ spec: `${p.id}/${p.example}`, name: `${p.name}: ${p.example}`, where: 'key', note: `your ${p.name} key${p.cost === 'paid' ? ', billed to it' : ''}` });
  }
  const seen = new Set<string>();
  return out.filter((m) => !seen.has(m.spec) && !!seen.add(m.spec));
}

const MAX_STEPS = 3;

export class ModelRuns {
  private runs = new Map<string, AgentRun & { via: string }>();
  constructor(private readonly hub: Hub, private readonly makeRunner: (spec: string) => ModelRunner = (spec) => runnerFromSpec(spec, { vault: appVault() })) {}

  get(id: string) { return this.runs.get(id) ?? null; }
  forProblem(problem: string) { return [...this.runs.values()].filter((r) => r.problem === problem).sort((a, b) => b.at.localeCompare(a.at)); }
  private note(r: AgentRun, text: string) { r.log.push({ at: new Date().toISOString(), text: text.slice(0, 300) }); if (r.log.length > 80) r.log.shift(); }

  /** Take up to three open steps of a problem with this model, one at a time, each submitted like any agent's answer. */
  start(problem: string, spec: string) {
    if (!this.hub.problems.get(problem)) throw new Error('unknown problem');
    const running = this.forProblem(problem).find((r) => r.status === 'running');
    if (running) return running; // one at a time per problem
    const runner = this.makeRunner(spec);
    const r = { id: randomBytes(6).toString('hex'), problem, status: 'running' as AgentRun['status'], at: new Date().toISOString(), log: [], steps: 0, via: spec };
    this.runs.set(r.id, r);
    this.note(r, `Working with ${spec} from this app.`);
    void this.loop(r, runner, spec);
    return r;
  }

  private async loop(r: AgentRun & { via: string }, runner: ModelRunner, spec: string) {
    const provider = PROVIDERS.find((p) => p.id === spec.split('/')[0])?.name ?? spec.split('/')[0];
    const model = spec.split('/').slice(1).join('/');
    try {
      const done = new Set<string>();
      for (let i = 0; i < MAX_STEPS; i++) {
        const step = (await openSteps(this.hub, { problem: r.problem, limit: MAX_STEPS + 2 })).find((s) => !done.has(s.step));
        if (!step) { this.note(r, i ? 'No more open steps.' : 'No open steps right now: every step is answered or waiting for a check.'); break; }
        done.add(step.step);
        this.note(r, `Working on step “${step.title}”…`);
        const answer = (await runner.run(`You are helping solve "${step.problem_title}", one step at a time.\n\nStep: ${step.title}\n${step.prompt}\n\nHow it is checked: ${step.checked_by}. Done means: ${step.done_means}.\nAnswer exactly what the step asks. Put the final answer on its own as the last line.`, { maxTokens: 1500 })).trim();
        if (!answer) { this.note(r, `${model} gave no answer for “${step.title}”.`); continue; }
        await submitStep(this.hub, { problem: r.problem, step: step.step, answer, model, client: provider });
        r.steps++;
        this.note(r, `Answered step “${step.title}”; it now waits for a different model family to check it.`);
      }
      r.status = 'done';
      this.note(r, r.steps ? `Answered ${r.steps} step${r.steps === 1 ? '' : 's'} with ${model}. Each waits for a computer running a different model family to check it.` : 'Finished without answering a step.');
    } catch (e) {
      r.status = 'failed';
      this.note(r, `Stopped: ${(e as Error).message}`);
    }
  }
}
