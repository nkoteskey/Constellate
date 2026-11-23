import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { Hub } from '../../src/hub/hub.js';
import { LocalSigner } from '../../src/core/identity.js';
import { MockRunner } from '../../src/contributor/models.js';
import { Worker } from '../../src/work/worker.js';
import { MemoryBoard } from '../../src/work/board.js';
import { submitStep } from '../../src/work/agent-step.js';
import { VerifierRegistry } from '../../src/work/verifiers.js';
import { CONTROLS, CHECKER_VERSIONS, checkerId, fingerprint, runControls } from '../../src/work/checker-controls.js';
import { SECOND_CHECKERS } from '../../src/work/second-checkers.js';
import { toGraph6 } from '../../src/work/combinatorics.js';
import { WebServer } from '../../src/web/server.js';
import { registerAppRoutes } from '../../src/web/app.js';

/**
 * Results in one shape (docs/RESULTS.md): who checked it (evidence) and whether it is new (novelty) are separate
 * labels; each limit says what would close it and the ones anyone can settle are open steps. The checkers
 * themselves are tested on known answers and planted errors, a second separately written checker must agree, and
 * each checker is pinned to a version so a past verdict can't silently flip.
 */
const PINS = new URL('../../src/work/checker-pins.json', import.meta.url);
const GS28 = '-++++++\n---++++\n--++-++\n-+-+-++';
const sync = (from: Hub, ...to: Hub[]) => { for (const h of to) for (const s of from.node.store.all()) if (s.visibility === 'public') h.node.ingest(s.rec); };

describe('checkers are tested before they are trusted', () => {
  it('every checker has controls: known answers pass, planted errors fail, and both checkers agree', async () => {
    const reg = new VerifierRegistry();
    for (const name of reg.names()) {
      const v = reg.get(name)!;
      expect(CONTROLS[name], `${name} needs controls`).toBeDefined();
      expect(CONTROLS[name].planted.length, `${name} needs planted errors`).toBeGreaterThan(0);
      if (v.witness) expect(SECOND_CHECKERS[name], `${name} needs a second checker`).toBeDefined();
      if (v.witness && !CONTROLS[name].no_known_answer) expect(CONTROLS[name].good.length).toBeGreaterThan(0);
      const r = await runControls(v);
      expect(r.failures, name).toEqual([]);
    }
  });

  it('the second checkers agree with the first on random answers, right and wrong', async () => {
    let seed = 11;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const reg = new VerifierRegistry();
    const both = async (name: string, spec: Record<string, unknown>, answer: string) => {
      const a = await reg.get(name)!.check(spec, answer), b = await SECOND_CHECKERS[name](spec, answer);
      expect(b.ok, `${name} ${JSON.stringify(spec)} ${answer.slice(0, 60)}: first says ${a.detail}, second ${b.detail}`).toBe(a.ok);
      return a.ok;
    };
    let accepted = 0;
    for (let i = 0; i < 40; i++) {
      const n = 5 + (i % 6);
      accepted += +(await both('ramsey_graph', { s: 3, t: 3 + (i % 2), n }, toGraph6(n, () => rnd() < 0.5)));
      const len = 8 + (i % 5);
      accepted += +(await both('vdw_coloring', { colors: 2, k: 3, n: len }, Array.from({ length: len }, () => (rnd() < 0.5 ? 0 : 1)).join('')));
      const marks = [0]; while (marks.length < 5) marks.push(marks.at(-1)! + 1 + Math.floor(rnd() * 5));
      accepted += +(await both('golomb_ruler', { marks: 5, below: 30 }, marks.join(' ')));
      const pts = new Set<string>(); while (pts.size < 4 + (i % 4)) pts.add(Array.from({ length: 3 }, () => Math.floor(rnd() * 3)).join(''));
      accepted += +(await both('cap_set', { n: 3, size_at_least: 4 }, [...pts].join(' ')));
      const v = 3 + (i % 3);
      accepted += +(await both('hadamard_gs', { n: 4 * v }, Array.from({ length: 4 }, () => Array.from({ length: v }, () => (rnd() < 0.5 ? '+' : '-')).join('')).join('\n')));
      const cnf = 'p cnf 4 3\n1 -2 0\n2 3 -4 0\n-1 4 0\n';
      accepted += +(await both('sat_assignment', { cnf }, [1, 2, 3, 4].map((x) => (rnd() < 0.5 ? x : -x)).join(' ')));
      const p = BigInt(1000 + Math.floor(rnd() * 4000));
      await both('wieferich', { above: 0 }, String(p));
      await both('wall_sun_sun', { above: 0 }, String(p));
      await both('three_cubes', { n: 3 }, `${Math.floor(rnd() * 9) - 4} 4 -5`);
    }
    expect(accepted).toBeGreaterThan(10); // the random answers include right ones, not only wrong ones
  });

  it('each checker is pinned to a version: changing its code without raising the version fails here', () => {
    const reg = new VerifierRegistry();
    const now = Object.fromEntries(reg.names().map((n) => [n, { version: CHECKER_VERSIONS[n], fingerprint: fingerprint(reg.get(n)!.check) }]));
    if (process.env.UPDATE_CHECKER_PINS === '1') writeFileSync(PINS, `${JSON.stringify(now, null, 2)}\n`);
    const pinned = JSON.parse(readFileSync(PINS, 'utf8')) as Record<string, { version: number; fingerprint: string }>;
    for (const [n, x] of Object.entries(now)) {
      expect(CHECKER_VERSIONS[n], `${n} has no version`).toBeGreaterThan(0);
      const p = pinned[n];
      expect(p, `${n} is not pinned: run UPDATE_CHECKER_PINS=1 npx vitest run test/gates/results.test.ts`).toBeDefined();
      if (p.version === x.version) expect(x.fingerprint, `${n}'s check changed: raise its version in CHECKER_VERSIONS (src/work/checker-controls.ts), keep its controls passing, then update the pins`).toBe(p.fingerprint);
      else expect(x.version, `${n}'s version went down`).toBeGreaterThan(p.version);
    }
  });
});

describe('results in one shape', () => {
  it('evidence, novelty, check it yourself, limits as open steps, and stable ids, from answer to audit', async () => {
    const asker = new Hub({ signer: LocalSigner.generate(), preview: false });
    const finder = new Hub({ signer: LocalSigner.generate(), preview: false });
    const checker = new Hub({ signer: LocalSigner.generate(), preview: false });
    const auditor = new Hub({ signer: LocalSigner.generate(), preview: false });
    const problem = (await asker.collective.propose({
      title: 'Small Hadamard orders', hook: 'Practice', goal: 'Find Goethals–Seidel sequences for small orders.', realm: 'maths_physics',
      definition_of_done: { verifier: 'hadamard_gs', description: 'Four sequences pass the check' },
      chunks: [{ key: 'o28', title: 'Order 28', prompt: 'Find them.', check: { n: 28 }, needs: { size: 'any' } }, { key: 'o20', title: 'Order 20', prompt: 'Find them.', check: { n: 20 }, needs: { size: 'any' } }],
      source: { url: 'https://example.org/table', says: 'Order 28 has Hadamard matrices; this is a practice problem.', read: '2026-11-22' },
    })).problem!.id;
    expect(asker.problems.body(problem).definition_of_done.checker).toBe('hadamard_gs@1'); // pinned when posted
    sync(asker, finder, checker, auditor);

    // The finder submits an answer. On the checker's computer, before it has done anything: Internal.
    const { result } = await submitStep(finder, { problem, step: 'o28', answer: GS28, model: 'claude-sonnet-4.5', client: 'claude-code' });
    sync(finder, checker);
    const id = `CR-${result.slice(0, 12)}`;
    let card = (await checker.results.get(id))!;
    expect(card).toMatchObject({ id, step: 'o28', evidence: { label: 'internal' }, novelty: { label: 'candidate' } });
    expect(card.limits.map((l) => l.step)).toEqual(['recheck', 'novelty', 'audit']);
    expect(card.before).toMatch(/example\.org\/table, read 2026-11-22\)\. We claim no priority/);
    expect(card.check_yourself.command).toBe(`npx -y constellate-mcp recheck ${id}`);
    expect(card.check_yourself.answer_sha256).toMatch(/^[0-9a-f]{64}$/);

    // A lent computer verifies it (machine check); the checkpoint records the checker version that passed it.
    const worker = new Worker(checker, new MockRunner('mock:qwen', 'qwen', 'small', () => 'YES'), checker.problems, new MemoryBoard());
    expect(await worker.step(problem)).toBe('verified');
    expect((checker.node.store.ofKind('checkpoint')[0].rec.body as { checker: string }).checker).toBe('hadamard_gs@1');
    sync(finder, auditor); sync(checker, auditor);
    card = (await auditor.results.get(id))!;
    expect(card.id).toBe(id); // the same id once verified
    expect(card.evidence).toMatchObject({ label: 'independently_checked', computers: 1, checkers: ['hadamard_gs@1', 'hadamard_gs (second checker)'] });
    expect(card.limits.map((l) => l.step)).toEqual(['novelty', 'audit']);

    // The limits are open steps for anyone but the finder, without being asked.
    expect((await auditor.results.followUps()).map((f) => [f.result, f.step])).toEqual([[id, 'novelty']]);
    expect(await finder.results.followUps()).toEqual([]); // nobody audits their own result
    await expect(finder.results.submit({ result: id, step: 'audit', verdict: 'holds', answer: 'I checked my own work carefully.' })).rejects.toThrow(/your own/);

    // Novelty needs a source; the most cautious label shows. An audit says what was checked.
    await expect(auditor.results.submit({ result: id, step: 'novelty', verdict: 'new', answer: 'Looks new to me' })).rejects.toThrow(/link/);
    await auditor.results.submit({ result: id, step: 'novelty', verdict: 'known', answer: 'Order 28 is classical: see https://example.org/hadamard-table' });
    await expect(auditor.results.submit({ result: id, step: 'audit', verdict: 'maybe', answer: 'x' })).rejects.toThrow(/holds/);
    await auditor.results.submit({ result: id, step: 'audit', verdict: 'holds', answer: 'Rebuilt the array, checked the problem statement and the bound: it holds.', model: 'gpt-5' });
    const re = await auditor.results.submit({ result: id, step: 'recheck' });
    expect(re).toMatchObject({ held: true });
    card = (await auditor.results.get(id))!;
    expect(card.novelty).toMatchObject({ label: 'known', text: 'Known', by: 1 });
    expect(card.audits).toEqual({ held: 1, overturned: 0 });
    expect(card.limits).toEqual([]);
    expect(card.evidence.computers).toBe(2); // the checker's checkpoint and the auditor's re-check

    // A checker change can't silently flip a past verdict: an answer verified under an earlier version and rejected
    // now shows as "Checkers disagree", and the step is not counted as verified.
    const bad = await submitStep(finder, { problem, step: 'o20', answer: '+++++\n+++++\n+++++\n+++++', model: 'claude-sonnet-4.5' });
    sync(finder, checker);
    await checker.node.submit({ kind: 'checkpoint', context: { task: 'verify', domain: ['maths_physics'], environment: 'old' }, body: { problem, chunk: 'o20', seq: 2, result: bad.result, verifier_model: 'machine', verifier_family: 'qwen', machine_check: 'ok', checker: 'hadamard_gs@0' }, refs: [problem, bad.result] }, { publish: true });
    sync(checker, auditor); sync(finder, auditor);
    const old = (await auditor.results.get(`CR-${bad.result.slice(0, 12)}`))!;
    expect(old.evidence.label).toBe('disagreement');
    expect(old.evidence.text).toMatch(/verified under hadamard_gs@0, and this computer's hadamard_gs@1 rejects it/);
    expect((await auditor.problems.summary(problem)).progress.done).toBe(1);

    // The app and llms-full.txt carry the same cards with the same ids.
    const web = new WebServer(auditor); registerAppRoutes(web); await web.listen(0);
    try {
      const all = await (await fetch(`${web.url}/api/results`)).json() as { id: string }[];
      expect(all.map((c) => c.id)).toContain(id);
      expect((await (await fetch(`${web.url}/api/results/${id}`)).json()).novelty.label).toBe('known');
      const page = await (await fetch(`${web.url}/api/problems/${problem}/page`)).json() as { results: { id: string }[] };
      expect(page.results.map((c) => c.id)).toContain(id);
      const txt = await (await fetch(`${web.url}/llms-full.txt`)).text();
      expect(txt).toContain(`### ${id}: Small Hadamard orders, Order 28`);
      expect(txt).toMatch(/Evidence: Independently checked · Novelty: Known/);
      expect(txt).toContain('## Open problems');
      const checkers = await (await fetch(`${web.url}/api/checkers`)).json() as { name: string; failures: string[] }[];
      expect(checkers.find((c) => c.name === 'hadamard_gs')!.failures).toEqual([]);
    } finally { await web.close(); }
    expect(checkerId('hadamard_gs')).toBe('hadamard_gs@1');
  });

  it('is documented, credits where the ideas came from, and lists the follow-ups', () => {
    const doc = readFileSync(new URL('../../docs/RESULTS.md', import.meta.url), 'utf8');
    for (const s of ['Independently checked', 'One engine', 'Internal', 'Candidate', 'New, but obtainable', 'would close it', 'planted', 'Generalised Superintelligence', 'auditor', 'equal compute']) expect(doc).toContain(s);
    expect(readFileSync(new URL('../../src/web/public/llms.txt', import.meta.url), 'utf8')).toContain('/llms-full.txt');
  });
});
