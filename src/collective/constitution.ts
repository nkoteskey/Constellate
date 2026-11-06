import { Hub } from '../hub/hub.js';
import { scrub } from '../privacy/scrub.js';
import { StoredRecord } from '../store/records.js';
import { ModelRunner } from '../contributor/models.js';
import { ProblemBody, TaskResultBody } from '../work/problems.js';

/**
 * Automated constitution checks, run when a problem is proposed and again at
 * every checkpoint. A violation pauses work for human review. The
 * constitution text itself lives in x0x (GET /constitution); these are the
 * mechanical rules the hub can enforce without a human, plus an optional model
 * reviewer. Keyword rules are a floor, not a ceiling: life-sciences work always
 * gets a human review before it starts.
 */
export interface Finding { rule: string; severity: 'block' | 'review'; detail: string }
export interface CheckResult { ok: boolean; needs_human: boolean; findings: Finding[] }

// Categories of misuse, not recipes. Anything that could help create a pathogen or toxin is out of bounds.
const BIO_HAZARD = [
  /gain[- ]of[- ]function/i, /enhanc\w* (transmissibility|virulence|lethality|pathogenicity)/i, /increase\w* (transmissibility|virulence|lethality)/i,
  /(synthesi[sz]e|produce|weaponi[sz]e|aerosoli[sz]e)\w* (a |the )?(pathogen|toxin|nerve agent|bioweapon|virus)/i,
  /\bbioweapon/i, /\bnerve agent/i, /immune evasion of (a )?(pathogen|virus)/i, /select agent/i,
];
// Life sciences gets a stricter review at every checkpoint: these broader signals are refused there.
const BIO_STRICT = [
  /\b(pathogen|toxin|virulence|transmissib\w*|lethal dose|ld50|aerosol\w*|weaponi[sz]\w*)\b/i,
  /\b(synthesis route|culture protocol|growth medium for|serial passage|reverse genetics)\b/i,
];
const HARM = [/\b(surveil|track|dox+|deanonymi[sz]e)\w* (a |an )?(person|individual|journalist|activist)/i, /\bmalware\b|\bransomware\b|\bexploit (chain|kit)\b/i];
const OPEN_LICENCES = ['CC0-1.0', 'CC-BY-4.0', 'CC-BY-SA-4.0', 'MIT', 'Apache-2.0', 'MIT OR Apache-2.0'];

export class Constitution {
  constructor(private readonly hub: Hub, private readonly reviewer?: ModelRunner) {}

  private textRules(text: string, realm: string): Finding[] {
    const f: Finding[] = [];
    for (const re of BIO_HAZARD) if (re.test(text)) f.push({ rule: 'life_sciences_safety', severity: 'block', detail: `matches ${re.source}` });
    for (const re of HARM) if (re.test(text)) f.push({ rule: 'no_harm', severity: 'block', detail: `matches ${re.source}` });
    const p = scrub({ text }, { level: 'standard' });
    for (const x of p.findings) f.push({ rule: 'privacy', severity: 'block', detail: `${x.type} ${x.excerpt}` });
    if (realm === 'life_sciences') f.push({ rule: 'life_sciences_review', severity: 'review', detail: 'life-sciences work gets a stricter human review' });
    return f;
  }

  private async modelReview(text: string): Promise<Finding[]> {
    if (!this.reviewer) return [];
    const out = await this.reviewer.run(`You review proposals for an open research network. Rules: no help creating pathogens, toxins or weapons; no targeting individuals; no malware; results must be shareable openly. Reply SAFE, or UNSAFE: <reason>.\n\n${text.slice(0, 6000)}`, { maxTokens: 300 });
    return /^\s*unsafe/i.test(out) ? [{ rule: 'model_review', severity: 'review', detail: out.slice(0, 300) }] : [];
  }

  private result(findings: Finding[]): CheckResult {
    return { ok: !findings.some((f) => f.severity === 'block'), needs_human: findings.length > 0, findings };
  }

  async checkProposal(p: ProblemBody & { license?: string }): Promise<CheckResult> {
    const text = [p.title, p.hook, p.goal, p.definition_of_done.description, ...p.chunks.map((c) => `${c.title} ${c.prompt}`)].join('\n');
    const f = [...this.textRules(text, p.realm), ...(await this.modelReview(text))];
    if (!this.hub.problems.verifiers.get(p.definition_of_done.verifier)) f.push({ rule: 'checkable_progress', severity: 'block', detail: 'no machine verifier: only problems with checkable progress enter the queue' });
    if (p.license && !OPEN_LICENCES.includes(p.license)) f.push({ rule: 'open_results', severity: 'block', detail: `licence ${p.license} is not an open licence` });
    return this.result(f);
  }

  async checkCheckpoint(problem: ProblemBody, result: TaskResultBody): Promise<CheckResult> {
    const f = this.textRules(result.output, problem.realm).filter((x) => x.rule !== 'life_sciences_review');
    if (problem.realm === 'life_sciences') {
      // Stricter review at every life-sciences checkpoint: broader refusals, and a second reviewer always looks.
      for (const re of BIO_STRICT) if (re.test(result.output)) f.push({ rule: 'life_sciences_safety', severity: 'block', detail: `checkpoint output matches ${re.source}` });
      if (!this.reviewer) f.push({ rule: 'life_sciences_review', severity: 'review', detail: 'every life-sciences checkpoint needs a model or human safety review' });
    }
    return this.result([...f, ...(await this.modelReview(result.output))]);
  }

  /** Sign and publish a check record so everyone can see why something runs or is paused. */
  async record(target: string, stage: 'start' | 'checkpoint', problemId: string, r: CheckResult) {
    return this.hub.node.submit({ kind: 'constitution_check', context: { task: `constitution check (${stage})`, domain: ['constitution'], environment: 'constellate-constitution-v1' }, body: { target, stage, ok: r.ok, needs_human: r.needs_human, findings: r.findings }, refs: [problemId, target] }, { publish: true });
  }

  /** A human reviewer's decision. Only operators the node pre-trusts count as reviewers. */
  async humanReview(problemId: string, decision: 'approve' | 'reject', note: string) {
    return this.hub.node.submit({ kind: 'constitution_check', context: { task: 'human constitution review', domain: ['constitution'], environment: 'human' }, body: { target: problemId, stage: 'human', ok: decision === 'approve', needs_human: false, findings: [], note }, refs: [problemId] }, { publish: true });
  }

  /** Can work on this problem proceed right now? */
  status(problemId: string): { state: 'unchecked' | 'blocked' | 'awaiting_review' | 'paused' | 'cleared'; reason: string } {
    const checks = this.hub.node.store.referencing(problemId, 'constitution_check').sort(byTime);
    const trusted = new Set([this.hub.node.operatorId, ...this.hub.trusted]);
    const human = checks.filter((c) => (c.rec.body as { stage: string }).stage === 'human' && trusted.has(c.operatorId)).at(-1);
    const auto = checks.filter((c) => (c.rec.body as { stage: string }).stage !== 'human');
    const start = auto.find((c) => (c.rec.body as { stage: string }).stage === 'start');
    if (!start) return { state: 'unchecked', reason: 'no constitution check yet' };
    type B = { ok: boolean; needs_human: boolean; findings: Finding[] };
    const why = (c: StoredRecord) => (c.rec.body as B).findings.map((x) => x.rule).join(', ');
    // A proposal that fails at start is out of bounds; humans cannot wave it through. Change it and resubmit.
    if (!(start.rec.body as B).ok) return { state: 'blocked', reason: why(start) };
    if (human && !(human.rec.body as B).ok) return { state: 'blocked', reason: 'rejected by human review' };
    const open = auto.filter((c) => ((c.rec.body as B).needs_human || !(c.rec.body as B).ok) && (!human || byTime(human, c) < 0));
    const failed = open.find((c) => !(c.rec.body as B).ok);
    if (failed) return { state: 'paused', reason: why(failed) };
    if (open.length) return { state: 'awaiting_review', reason: why(open[0]) };
    return { state: 'cleared', reason: 'constitution checks passed' };
  }
}

function byTime(a: StoredRecord, b: StoredRecord) { return Date.parse(a.rec.created) - Date.parse(b.rec.created) || a.receivedAt - b.receivedAt; }
