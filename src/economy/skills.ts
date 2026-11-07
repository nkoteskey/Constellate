import { z } from 'zod';
import { Hub } from '../hub/hub.js';
import { ModelRunner } from '../contributor/models.js';
import { VerifierRegistry } from '../work/verifiers.js';
import { bm25 } from '../services/search.js';
import { Economy } from './economy.js';
import { TESTNET_PRICING } from './pricing.js';

/**
 * Skill marketplace. A skill card is a signed record: what the skill does, its
 * price per run, its instructions and its own test cases. Skills are prompt
 * skills (instructions run by the CALLER's model), so trialling one runs
 * nothing foreign on your machine: the sandbox is your own model on the
 * skill's test cases, checked by a machine verifier. Every trial or use is a
 * signed `skill_run`, which becomes the skill's proof of past runs.
 * (Code skills need a real sandbox, e.g. WASM; not built yet.)
 */
export const SkillCard = z.object({
  name: z.string().max(80),
  description: z.string().max(400),
  capabilities: z.array(z.string().max(40)).max(12),
  price: z.number().int().min(0).describe('micro-units per run'),
  instructions: z.string().max(32_000),
  /** Its own test cases. A skill imported from elsewhere may have none yet: it can't be trialled until someone adds them. */
  tests: z.array(z.object({ input: z.string().max(2000), check: z.record(z.unknown()) })).max(20),
  verifier: z.string(),
  license: z.string().default('MIT'),
  /** Where an imported skill came from, pinned to a commit, and what was changed (src/seed/agent-skills.ts). */
  source: z.object({ org: z.string().max(80), repo: z.string().max(120), path: z.string().max(200), commit: z.string().max(64), url: z.string().url().max(400) }).optional(),
  notice: z.string().max(800).optional(),
});
export type SkillCard = z.infer<typeof SkillCard>;

export class Skills {
  constructor(private readonly hub: Hub, private readonly economy?: Economy, private readonly verifiers = new VerifierRegistry()) {}

  /** Publish a skill. `inherits` names parent skills it was derived from, so their authors share in its earnings. */
  async publish(card: z.input<typeof SkillCard>, opts: { inherits?: string[]; domain?: string[] } = {}) {
    const c = SkillCard.parse(card);
    if (!c.tests.length && !c.source) throw new Error('a skill needs at least one test case (only imported skills, with their source, may have none yet)');
    if (!this.verifiers.get(c.verifier)) throw new Error(`unknown verifier ${c.verifier}`);
    return this.hub.node.submit({ kind: 'skill', context: { task: c.description, domain: opts.domain ?? c.capabilities, environment: '' }, body: c, refs: opts.inherits ?? [] }, { publish: true });
  }

  runs(skillId: string) { return this.hub.node.store.referencing(skillId, 'skill_run'); }

  find(query: string, limit = 5) {
    const skills = this.hub.node.store.ofKind('skill');
    const rel = bm25(query, skills.map((s) => { const b = s.rec.body as unknown as SkillCard; return { id: s.rec.id, text: `${b.name} ${b.description} ${b.capabilities.join(' ')}`, tags: b.capabilities }; }));
    return skills.filter((s) => rel.has(s.rec.id)).map((s) => {
      const b = s.rec.body as unknown as SkillCard;
      const runs = this.runs(s.rec.id).map((r) => r.rec.body as { passed: number; total: number });
      const passRate = runs.length ? runs.reduce((n, r) => n + r.passed / r.total, 0) / runs.length : 0;
      const score = rel.get(s.rec.id)! * (0.3 + this.hub.trust.weight(s)) * (0.5 + passRate);
      return { id: s.rec.id, name: b.name, description: b.description, price: b.price, tests: b.tests.length, ...(b.source ? { source: b.source.url, credit: `${b.source.org} (${b.source.repo}), ${b.license}` } : {}), runs: runs.length, pass_rate: Math.round(passRate * 100) / 100, author_reputation: this.hub.trust.explain(s).author_reputation, inherits: s.rec.refs, score };
    }).sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /** Trial a skill on its own test cases with your model. Free; publishes a signed proof of the run. */
  async trial(skillId: string, runner: ModelRunner) {
    const s = this.hub.node.store.get(skillId);
    if (!s || s.rec.kind !== 'skill') throw new Error('unknown skill');
    const card = s.rec.body as unknown as SkillCard;
    if (!card.tests.length) throw new Error('this skill has no test cases yet, so it cannot be trialled; it can still be used');
    const v = this.verifiers.get(card.verifier)!;
    let passed = 0;
    for (const t of card.tests) {
      const out = await runner.run(`${card.instructions}\n\nInput:\n${t.input}`);
      if ((await v.check(t.check, out)).ok) passed++;
    }
    const { record } = await this.hub.node.submit({ kind: 'skill_run', context: { task: `trial ${card.name}`, domain: card.capabilities, environment: runner.id }, body: { skill: skillId, mode: 'trial', passed, total: card.tests.length, model: runner.id }, refs: [skillId] }, { publish: true });
    return { passed, total: card.tests.length, run: record.id };
  }

  /** Use a skill on a real input. Pays the author per run, and links the run to the record it helped produce. */
  async use(skillId: string, runner: ModelRunner, input: string, usedIn?: string) {
    const s = this.hub.node.store.get(skillId);
    if (!s || s.rec.kind !== 'skill') throw new Error('unknown skill');
    const card = s.rec.body as unknown as SkillCard;
    const output = await runner.run(`${card.instructions}\n\nInput:\n${input}`);
    const { record } = await this.hub.node.submit({ kind: 'skill_run', context: { task: `use ${card.name}`, domain: card.capabilities, environment: runner.id }, body: { skill: skillId, mode: 'use', passed: 1, total: 1, model: runner.id, ...(usedIn ? { used_in: usedIn } : {}) }, refs: usedIn ? [skillId, usedIn] : [skillId] }, { publish: true });
    let receipt = null;
    if (card.price > 0) {
      if (!this.economy) throw new Error('this skill costs money; no payment rail configured');
      // Credit flows to the author and, through inheritance, to parent skills.
      const parents = s.rec.refs.filter((r) => this.hub.node.store.get(r)?.rec.kind === 'skill');
      const parentShare = parents.length ? Math.floor((card.price * TESTNET_PRICING.skillParentShareBps) / 10_000) : 0;
      receipt = await this.economy.pay(s.rec.agent_id, card.price - parentShare, 'skill_fee', [record.id, skillId]);
      for (const p of parents) await this.economy.pay(this.hub.node.store.get(p)!.rec.agent_id, Math.floor(parentShare / parents.length), 'skill_fee', [record.id, p], { role: 'inherited' });
    }
    return { output, run: record.id, receipt: receipt?.id ?? null };
  }
}
