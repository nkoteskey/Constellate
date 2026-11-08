import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Hub } from '../../src/hub/hub.js';
import { LocalSigner } from '../../src/core/identity.js';
import { RecordStore } from '../../src/store/records.js';
import { MemoryNetwork } from '../../src/transport/bus.js';
import { LocalArchive } from '../../src/store/archive.js';
import { TestnetLedger } from '../../src/economy/rail.js';
import { Economy } from '../../src/economy/economy.js';
import { seedAgentSkills, seedX0xSkills, ImportedSkill, SkillTestsFile, WrappedSkillFile } from '../../src/seed/agent-skills.js';
import { MockRunner } from '../../src/contributor/models.js';
import { AnswerBody, independentOrigins } from '../../src/services/ledger.js';
import { PlanReport } from '../../src/collective/planner.js';
import { verifyPrompt } from '../../src/work/worker.js';
import { connect } from '../helpers.js';

/**
 * The research method (Research Loop, wrencanfly/research-loop-skills, MIT) carried into Constellate:
 * its seven skills are browsable with the rest; answers can say what kind of claim they make, how strong its
 * evidence is and where it stops; plans name what would prove them wrong and when to stop; and checkers are
 * asked for checks, not votes. Plus skill discovery: every skill can be browsed, x0x and Autonomi first.
 */
const SEED = join(import.meta.dirname, '../../data/seed');
const json = (f: string) => JSON.parse(readFileSync(join(SEED, f), 'utf8'));
const hub = () => new Hub({ signer: LocalSigner.generate(), store: new RecordStore(), preview: false });

describe('skill discovery', () => {
  it('every skill can be browsed by group: x0x and Autonomi first, with the tested x0x how-tos; then the research method', async () => {
    const h = hub();
    await seedAgentSkills(h, json('agent-skills.json') as { skills: ImportedSkill[] });
    const wrapped = await seedX0xSkills(h, json('x0x-skills.json') as WrappedSkillFile);
    expect(wrapped).toHaveLength(4);
    expect(await seedX0xSkills(h, json('x0x-skills.json') as WrappedSkillFile)).toHaveLength(0); // never twice

    const c = h.skills.catalog();
    expect(c.groups.map((g) => g.id)).toEqual(['network', 'research', 'public']);
    const network = c.skills.filter((k) => k.group === 'network');
    expect(network.map((k) => k.name)).toEqual(expect.arrayContaining(['x0x', 'Building apps on the Autonomi network', 'Start or attach to an x0x daemon']));
    expect(network).toHaveLength(6);
    expect(c.skills[0].group).toBe('network');
    expect(c.skills[0].tests).toBeGreaterThan(0); // the trialable ones lead
    expect(network.find((k) => k.name === 'x0x')).toMatchObject({ from: 'Saorsa Labs (saorsa-labs/x0x)', license: 'MIT OR Apache-2.0', tests: 0 });
    expect(network.find((k) => k.name === 'x0x')).toMatchObject({ adapted: false }); // the upstream text itself
    expect(network.find((k) => k.name === 'Start or attach to an x0x daemon')).toMatchObject({ from: 'adapted from Saorsa Labs’ x0x skill file', adapted: true, tests: 2 });

    const research = c.skills.filter((k) => k.group === 'research').map((k) => k.name).sort();
    expect(research).toEqual(['research-evidence', 'research-execute', 'research-frame', 'research-hypothesize', 'research-loop', 'research-synthesize', 'research-verify']);
    const verify = h.node.store.get(c.skills.find((k) => k.name === 'research-verify')!.id)!.rec.body as { source: { url: string; commit: string }; license: string; notice: string; instructions: string };
    expect(verify.source.url).toMatch(/^https:\/\/github\.com\/wrencanfly\/research-loop-skills\/tree\/[0-9a-f]{40}\/skills\/research-verify$/);
    expect(verify.license).toBe('MIT');
    expect(verify.notice).toMatch(/Copyright \(c\) 2026 Research Loop contributors/);
    expect(verify.instructions).toMatch(/agreement from another model alone is not independent evidence/);
    expect(h.skills.find('verify a research claim independently', 3).map((k) => k.name)).toContain('research-verify');
  });

  it('agents browse too: skills_find with no query lists every skill by group', async () => {
    const h = hub();
    await seedX0xSkills(h, json('x0x-skills.json') as WrappedSkillFile);
    const { call } = await connect(h);
    const out = await call('skills_find', {});
    expect(out.isError).toBe(false);
    expect(out.groups[0]).toMatchObject({ id: 'network', count: 4 });
    expect(out.groups[0].skills.map((k: { name: string }) => k.name)).toContain('Join an x0x group');
    expect((await call('skills_find', { query: 'x0x group' })).results.length).toBeGreaterThan(0);
  });

  it('the x0x and Autonomi skills carry test cases we wrote from their own text, so they can be trialled', async () => {
    const tf = json('skill-tests.json') as SkillTestsFile;
    const skills = (json('agent-skills.json') as { skills: ImportedSkill[] }).skills;
    for (const [key, tests] of Object.entries(tf.tests)) {
      const k = skills.find((x) => `${x.source.repo}:${x.source.path}` === key);
      expect(k, key).toBeDefined();
      for (const t of tests) {
        expect(k!.instructions, `${key}: ${t.from}`).toContain(t.from!); // grounded in the skill itself
        expect(t.input).toMatch(/last word\.$/);
      }
    }
    const h = hub();
    await seedAgentSkills(h, { skills }, tf);
    const network = h.skills.catalog().skills.filter((k) => k.group === 'network');
    expect(network.find((k) => k.name === 'x0x')!.tests).toBe(3);
    expect(network.find((k) => k.name === 'Building apps on the Autonomi network')!.tests).toBe(3);
    const x0x = h.node.store.get(network.find((k) => k.name === 'x0x')!.id)!.rec;
    expect((x0x.body as { notice: string }).notice).toMatch(/Test cases written by Constellate/);
    expect(x0x.context.environment).toMatch(/3 test cases written by Constellate/);
    // A model that read the skill answers from it; the trial is a signed run with its score.
    const answers: Record<string, string> = { 'starts the default': 'start', 'signature scheme': 'ML-DSA-65', 'reports health': '/health' };
    const runner = new MockRunner('m', 'mock', 'small', (p) => Object.entries(answers).find(([w]) => p.split('Input:')[1]?.includes(w))?.[1] ?? 'unsure');
    expect(await h.skills.trial(x0x.id, runner)).toMatchObject({ passed: 3, total: 3 });
  });

  it('cards count real use apart from trials, and by how many operators', async () => {
    const net = new MemoryNetwork(), archive = new LocalArchive();
    const mk = () => new Hub({ signer: LocalSigner.generate(), bus: net.bus(), archive, preview: false });
    const a = mk(), b = mk();
    const [id] = await seedX0xSkills(a, json('x0x-skills.json') as WrappedSkillFile);
    const run = (h: Hub, mode: 'use' | 'trial') => h.node.submit({ kind: 'skill_run', context: { task: `${mode} skill`, domain: ['skills'], environment: 'm' }, body: { skill: id, mode, passed: 1, total: 1, model: 'm' }, refs: [id] }, { publish: true });
    await run(a, 'use'); await run(a, 'use'); await run(a, 'trial');
    await new Promise((r) => setTimeout(r, 50));
    await run(b, 'use');
    await new Promise((r) => setTimeout(r, 100));
    expect(a.skills.catalog().skills.find((k) => k.id === id)).toMatchObject({ uses: 3, users: 2, trials: 1 });
  });
});

describe('claims with their evidence', () => {
  const base = { question: 'Does the cache survive a restart?', answer: 'Yes, from version 2.', proof: { type: 'citation' as const, detail: 'release notes' } };
  it('the claim fields must agree with each other, and short answers stay valid without them', () => {
    expect(AnswerBody.safeParse(base).success).toBe(true);
    const src = (relation: 'supports' | 'contradicts') => ({ source: 'https://example.org/notes', locator: 'section 3', relation });
    expect(AnswerBody.safeParse({ ...base, status: 'supported', sources: [src('contradicts')] }).success).toBe(false);
    expect(AnswerBody.safeParse({ ...base, status: 'supported', sources: [src('supports')] }).success).toBe(true);
    expect(AnswerBody.safeParse({ ...base, status: 'refuted', sources: [src('supports')] }).success).toBe(false);
    expect(AnswerBody.safeParse({ ...base, status: 'contested', sources: [src('supports')] }).success).toBe(false);
    expect(AnswerBody.safeParse({ ...base, status: 'contested', sources: [src('supports'), src('contradicts')] }).success).toBe(true);
    expect(AnswerBody.safeParse({ ...base, status: 'unresolved' }).success).toBe(true);
    expect(AnswerBody.safeParse({ ...base, claim: 'inference' }).success).toBe(false);
    expect(AnswerBody.safeParse({ ...base, claim: 'inference', limits: 'Only tested on one machine.' }).success).toBe(true);
  });

  it('sources retelling one study count once', () => {
    expect(independentOrigins([
      { source: 'https://news.example.org/a', locator: 'para 2', relation: 'supports', origin: 'https://doi.org/10.1/x' },
      { source: 'https://blog.example.org/b', locator: 'para 5', relation: 'supports', origin: 'https://doi.org/10.1/x/' },
      { source: 'https://doi.org/10.2/y', locator: 'table 1', relation: 'supports' },
      { source: 'https://doi.org/10.3/z', locator: 'fig 4', relation: 'contradicts' },
    ])).toBe(2);
  });

  it('answers_submit takes the claim fields; answers_lookup shows them, with independent origins', async () => {
    const h = hub();
    const { call } = await connect(h);
    const q = { task: 'cache', domain: ['caching'], environment: 'node 22', question: base.question, answer: base.answer };
    const bad = await call('answers_submit', { ...q, proof_type: 'citation', proof_detail: 'notes', claim: { kind: 'inference', status: 'supported', sources: [{ source: 'https://example.org/notes', locator: 'section 3', relation: 'supports' }] }, publish: true });
    expect(bad.isError).toBe(true);
    expect(JSON.stringify(bad)).toMatch(/needs its limits/); // an inference without its limits
    const ok = await call('answers_submit', {
      task: 'cache', domain: ['caching'], environment: 'node 22', question: base.question, answer: base.answer, proof_type: 'citation', proof_detail: 'notes', publish: true,
      claim: { kind: 'inference', status: 'contested', limits: 'Not tested on clusters.',
        sources: [{ source: 'https://news.example.org/a', locator: 'para 2', relation: 'supports', origin: 'https://example.org/study' }, { source: 'https://blog.example.org/b', locator: 'para 1', relation: 'supports', origin: 'https://example.org/study' }, { source: 'https://example.org/issue/9', locator: 'first comment', relation: 'contradicts' }] },
    });
    const unknownKind = await call('answers_submit', { ...q, proof_type: 'citation', proof_detail: 'notes', claim: { kind: 'guess' } });
    expect(unknownKind.isError).toBe(true);
    expect(JSON.stringify(unknownKind)).toMatch(/observation/);
    expect(ok.isError).toBe(false);
    const found = await call('answers_lookup', { question: 'cache survive restart' });
    const r = found.results.find((x: { claim?: unknown }) => x.claim);
    expect(r.claim).toMatchObject({ kind: 'inference', status: 'contested', limits: 'Not tested on clusters.', independent: { supporting: 1, contradicting: 1 } });
  });
});

describe('plans and checks', () => {
  it('plans can name the decision, alternatives, what would prove them wrong, and when to stop; older reports still parse', async () => {
    const plan = { title: 'Sums', hook: '', goal: 'Compute sums of squares mod 97.', realm: 'maths_physics', verifier: 'sum_squares_mod', done_description: 'Every step recomputed.', steps: [{ key: 'a', title: 'Sum to 10', prompt: 'Sum of squares to 10 mod 97?', check: { from: 1, to: 10, mod: 97 } }] };
    const old = PlanReport.parse({ plan, findings: { why_checkable: 'Recomputed exactly.' } });
    expect(old.findings).toMatchObject({ decision: '', alternatives: [], would_show_wrong: '', stop_rule: '' });
    const framed = PlanReport.parse({ plan, findings: { why_checkable: 'x', decision: 'Whether to fund the larger range', alternatives: [{ explanation: 'A closed form makes the search pointless', weakened_by: 'no closed form for the modulus' }], would_show_wrong: 'the verifier disagrees on the first step', stop_rule: 'stop after 12 steps or the first disagreement' } });
    expect(framed.findings.alternatives).toHaveLength(1);

    process.env.CONSTELLATE_HOME = mkdtempSync(join(tmpdir(), 'plan-'));
    const h = new Hub({ signer: LocalSigner.generate(), preview: false });
    const { record } = await h.node.submit({ kind: 'proposal', context: { task: 'idea', domain: ['maths_physics'], environment: 'human (browser)' }, body: { title: 'Sum of squares', goal: 'Compute sums of squares mod a prime', done: 'every range recomputed', realm: 'maths_physics' } }, { publish: true });
    const r = await h.planner.start(record.id, 'any_agent');
    expect(h.planner.brief(r.id)).toMatch(/stopping rule/);
    expect(h.planner.brief(r.id)).toMatch(/would_show_wrong, stop_rule/);
  });

  it('the cross-family check asks for its own work and a concrete failure, not agreement', () => {
    const p = verifyPrompt('Sum of squares to 10 mod 97?', '91');
    expect(p).toMatch(/^You are verifying/); // the phrase the test runners answer to
    expect(p).toMatch(/Work the task yourself first/);
    expect(p).toMatch(/what you checked and anything you couldn't check/);
  });

  it('second opinions record each check; "sound" needs one that passed', async () => {
    const net = new MemoryNetwork(), archive = new LocalArchive(), ledger = new TestnetLedger();
    const mk = () => new Hub({ signer: LocalSigner.generate(), bus: net.bus(), archive, preview: false });
    const requester = mk(), reviewer = mk();
    ledger.faucet(requester.node.agentId, 100_000);
    const { record: req } = await new Economy(requester, ledger).requestReview('claim', 'Restarting keeps the cache from v2', 'a'.repeat(64), 1_000, ['caching']);
    const eRev = new Economy(reviewer, ledger);
    await expect(eRev.respondReview(req.id, 'sound', 'Looks fine.', [{ check: 'reproduced a restart', outcome: 'not_attempted' }])).rejects.toThrow(/at least one check that passed/);
    const { record } = await eRev.respondReview(req.id, 'concerns', 'Held on one machine; cluster mode not checked.', [{ check: 'restart on one machine', outcome: 'passed' }, { check: 'restart in cluster mode', outcome: 'not_attempted' }]);
    expect((record.body as { checks: unknown[] }).checks).toHaveLength(2);
  });
});
