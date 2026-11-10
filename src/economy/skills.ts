import { z } from 'zod';
import { Hub } from '../hub/hub.js';
import { ModelRunner } from '../contributor/models.js';
import { VerifierRegistry } from '../work/verifiers.js';
import { bm25 } from '../services/search.js';
import { Economy } from './economy.js';
import { TESTNET_PRICING } from './pricing.js';
import { OfficialMarks } from './official.js';

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

/** How the skill catalogue is grouped, in the order it's shown. */
export const SKILL_GROUPS = [
  { id: 'network', title: 'The network', about: 'Constellate itself, and what it runs on: messaging, groups and data on x0x, storage on Autonomi.' },
  { id: 'shared', title: 'Shared by agents', about: 'Skills agents published here, with their own test cases.' },
  { id: 'research', title: 'Research method', about: 'Frame a question, map evidence, test alternatives, verify and stop on purpose.' },
  { id: 'public', title: 'Public skill collections', about: 'Openly licensed skills from public repositories, credited to their source.' },
] as const;
export type SkillGroup = (typeof SKILL_GROUPS)[number]['id'];

export function skillGroup(repo: string, org?: string): SkillGroup {
  if (repo === 'saorsa-labs/x0x' || repo === 'WithAutonomi/ant-sdk' || repo === 'nkoteskey/Constellate') return 'network';
  if (repo === 'wrencanfly/research-loop-skills') return 'research';
  return repo || org ? 'public' : 'shared';
}

export class Skills {
  /** Which repositories' own identities signed which skills (src/economy/official.ts). */
  readonly official = new OfficialMarks();
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

  /**
   * Every skill, grouped so a person or agent can browse rather than guess a query: the network's own skills (x0x
   * and Autonomi) first, then those agents shared, then the research method, then the public collections. Within
   * a group, skills with test cases and past runs come first.
   */
  /** The repositories skills name as their source, for checking official marks. */
  sourceRepos() { return [...new Set(this.hub.node.store.ofKind('skill').map((s) => (s.rec.body as unknown as SkillCard).source?.repo).filter((r): r is string => !!r))]; }

  catalog() {
    const store = this.hub.node.store;
    const items = store.ofKind('skill').map((s) => {
      const b = s.rec.body as unknown as SkillCard;
      const runRecs = this.runs(s.rec.id);
      const runs = runRecs.map((r) => r.rec.body as { passed: number; total: number; mode?: string });
      const used = runRecs.filter((r) => (r.rec.body as { mode?: string }).mode === 'use');
      const where = b.source?.repo ?? (s.rec.evidence.find((e) => /github\.com\/saorsa-labs\/x0x\b/.test(e)) ? 'saorsa-labs/x0x' : '');
      const group = skillGroup(where, b.source?.org);
      return {
        id: s.rec.id, name: b.name, description: b.description, capabilities: b.capabilities, group,
        // Imported skills are the upstream text; x0x's short how-tos are Constellate's own adaptations of x0x's
        // skill file, so they say so rather than reading as Saorsa Labs' own.
        from: b.source ? `${b.source.org} (${b.source.repo})` : where === 'saorsa-labs/x0x' ? 'adapted from Saorsa Labs’ x0x skill file' : null,
        adapted: !b.source && where === 'saorsa-labs/x0x',
        // Official only when the repository's own file lists the identity that signed this record.
        official: b.source ? this.official.isOfficial(b.source.repo, s.rec.agent_id) === true : false,
        url: b.source?.url ?? s.rec.evidence.find((e) => /^https?:\/\//.test(e)) ?? null, license: b.license, price: b.price, tests: b.tests.length, runs: runs.length,
        pass_rate: runs.length ? Math.round((runs.reduce((n, r) => n + r.passed / r.total, 0) / runs.length) * 100) / 100 : null,
        confirmations: store.referencing(s.rec.id, 'confirmation').length,
        // Real use, not trials: how often it was used, and by how many different operators.
        uses: used.length, users: new Set(used.map((r) => r.operatorId)).size, trials: runs.length - used.length,
      };
    });
    const order = SKILL_GROUPS.map((g) => g.id);
    items.sort((a, b) => order.indexOf(a.group) - order.indexOf(b.group) || Number(b.official) - Number(a.official) || b.tests - a.tests || b.runs - a.runs || b.confirmations - a.confirmations || a.name.localeCompare(b.name));
    return { groups: SKILL_GROUPS.map((g) => ({ ...g, count: items.filter((k) => k.group === g.id).length })).filter((g) => g.count), skills: items };
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
