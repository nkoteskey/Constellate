import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import type { Hub } from '../hub/hub.js';
import { openSteps, submitStep } from './agent-step.js';

/**
 * "Have your agent work on it", for whatever agent the person has connected (docs/AGENT_STEPS.md).
 *
 * Most agents (Claude Desktop, Cursor, VS Code…) can't be started from outside: they act when they call
 * Constellate's tools. So the app leaves a work request on this computer, and every connected agent's
 * Constellate process (constellate mcp) picks it up:
 *  - if the agent's client supports MCP sampling, the process asks the agent's own model to do the steps
 *    right away and submits the answers (with the model the client reports);
 *  - otherwise, the next reply to any Constellate tool the agent calls carries the request, and the agent
 *    does it with work_step.
 * The request's log, shared through a small file, is what the app shows.
 */
export interface WorkRequest {
  id: string; problem: string; title: string; at: string; status: 'waiting' | 'working' | 'done';
  steps: number; max: number; by?: string; log: { at: string; text: string }[]; offered?: string[];
}

export class WorkRequests {
  private readonly file: string;
  constructor(home = process.env.CONSTELLATE_HOME ?? join(homedir(), '.constellate')) { this.file = join(home, 'work-requests.json'); }

  all(): WorkRequest[] { try { return JSON.parse(readFileSync(this.file, 'utf8')) as WorkRequest[]; } catch { return []; } }
  private save(list: WorkRequest[]) {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(list.slice(-50)));
    renameSync(tmp, this.file); // whole file at once: other processes never read half of it
  }
  private update(id: string, f: (r: WorkRequest) => void) { const list = this.all(); const r = list.find((x) => x.id === id); if (r) { f(r); this.save(list); } return r ?? null; }
  get(id: string) { return this.all().find((r) => r.id === id) ?? null; }
  forProblem(problem: string) { return this.all().filter((r) => r.problem === problem).reverse(); }
  open() { return this.all().filter((r) => r.status !== 'done' && Date.now() - Date.parse(r.at) < 24 * 3600_000); }

  note(id: string, text: string) { return this.update(id, (r) => { r.log.push({ at: new Date().toISOString(), text: text.slice(0, 300) }); r.log = r.log.slice(-60); }); }

  create(problem: string, title: string, max = 3): WorkRequest {
    const existing = this.forProblem(problem).find((r) => r.status !== 'done');
    if (existing) return existing;
    const now = new Date().toISOString();
    const r: WorkRequest = { id: randomBytes(6).toString('hex'), problem, title, at: now, status: 'waiting', steps: 0, max, log: [{ at: now, text: 'Waiting for a connected agent. Agents that allow it start straight away; others see the request the next time they use Constellate.' }] };
    this.save([...this.all(), r]);
    return r;
  }

  /** An agent's Constellate process takes a request (only one agent works on it at a time). */
  take(id: string, by: string) {
    let ok = false;
    this.update(id, (r) => { if (r.status === 'waiting' || (r.status === 'working' && r.by === by)) { r.status = 'working'; r.by = by; ok = true; } });
    return ok;
  }
  answered(id: string, step: string, model: string) {
    return this.update(id, (r) => { r.steps++; r.log.push({ at: new Date().toISOString(), text: `${r.by ?? 'Your agent'} (${model}) answered step “${step}”; it waits for a different model family to check it.` }); if (r.steps >= r.max) r.status = 'done'; });
  }
  finish(id: string, text: string) { return this.update(id, (r) => { r.status = 'done'; r.log.push({ at: new Date().toISOString(), text }); }); }
  /** Say once per agent that the request was put in front of it. */
  offer(id: string, by: string) {
    let first = false;
    this.update(id, (r) => { r.offered ??= []; if (!r.offered.includes(by)) { r.offered.push(by); first = true; r.log.push({ at: new Date().toISOString(), text: `Passed to ${by} with its next Constellate reply; it can take the steps with work_step.` }); } });
    return first;
  }
}

/** The note added to a tool reply for agents that can't be asked directly. */
export function requestNote(r: WorkRequest) {
  return `Your person asked you to help with "${r.title}" (problem ${r.problem}): call work_step with problem "${r.problem}", do up to ${r.max - r.steps} open step(s) carefully with your own model, and submit each answer with work_step, saying which model you are.`;
}

/**
 * In an agent's Constellate process: do waiting requests with the agent's own model through MCP sampling.
 * `ask` sends one prompt to the client's model and returns its text and the model it used.
 */
export async function workWithSampling(hub: Hub, reqs: WorkRequests, by: string, ask: (prompt: string) => Promise<{ text: string; model: string }>) {
  for (const r of reqs.open()) {
    if (!reqs.take(r.id, by)) continue;
    reqs.note(r.id, `${by} took this, using its own model.`);
    let done = r.steps;
    try {
      while (done < r.max) {
        const [step] = await openSteps(hub, { problem: r.problem, limit: 1 });
        if (!step) { reqs.finish(r.id, done ? 'No more open steps right now.' : 'No open steps right now: every step is answered or waiting for a check.'); break; }
        const out = await ask(`You're helping with "${step.problem_title}", a problem on Constellate. Do this step carefully.\n\nStep: ${step.title}\n${step.prompt}\n\nIt will be checked ${step.checked_by}. Reply with only your answer.`);
        if (!out.text.trim()) { reqs.finish(r.id, `${by}'s model gave no answer.`); break; }
        await submitStep(hub, { problem: r.problem, step: step.step, answer: out.text.trim(), model: out.model, client: by });
        reqs.answered(r.id, step.step, out.model);
        done++;
      }
      if (done >= r.max) reqs.finish(r.id, `Answered ${done} step${done === 1 ? '' : 's'}. Each counts once a different model family checks it.`);
    } catch (e) { reqs.finish(r.id, `Stopped: ${(e as Error).message.slice(0, 200)}`); }
  }
}
