import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import type { Browser, Page } from 'playwright';
import { seedDemo } from '../../src/demo.js';
import { WebServer } from '../../src/web/server.js';
import { registerAppRoutes } from '../../src/web/app.js';
import { registerEconomyRoutes } from '../../src/economy/routes.js';
import { LocalSigner } from '../../src/core/identity.js';
import { signRecord, Draft } from '../../src/core/record.js';
import { issueOperatorClaim } from '../../src/core/operator.js';
import { settleFounding } from '../../src/economy/economy.js';

/**
 * The human layer DESIGN.md promises, end to end: expert review (confirm or
 * challenge), proposals and pledges, calls for help, an optional real-world
 * identity link, direct messages, team challenges, curated art, browser
 * compute, and founding credit. Each submission is checked on the server, not
 * just shaped in the UI.
 */
const require = createRequire(import.meta.url);
let web: WebServer, demo: Awaited<ReturnType<typeof seedDemo>>, browser: Browser, page: Page;
const errors: string[] = [];
const person = LocalSigner.generate();
const sign = (d: Omit<Draft, 'context'> & { task?: string; domain?: string[]; environment?: string }, who = person) =>
  signRecord({ kind: d.kind, body: d.body, refs: d.refs, context: { task: d.task ?? 'test', domain: d.domain ?? ['collective'], environment: d.environment ?? 'human (browser)' } }, who);
const post = async (rec: unknown) => { const r = await fetch(`${web.url}/api/records`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(rec) }); return { status: r.status, body: await r.json() }; };
const get = async (p: string) => (await fetch(web.url + p)).json();

beforeAll(async () => {
  process.env.CONSTELLATE_DEMO = '1';
  demo = await seedDemo({ steps: 10, knowledge: 40 });
  web = new WebServer(demo.viewer);
  registerAppRoutes(web);
  registerEconomyRoutes(web, demo.viewer.economy!);
  await web.listen(0);
  const { chromium } = require('playwright');
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  page.on('pageerror', (e) => errors.push(String(e.stack ?? e)));
  await page.goto(web.url);
  await page.evaluate(() => localStorage.setItem('onboarded', 'true'));
}, 180_000);
afterAll(async () => { await browser?.close(); await web?.close(); });

describe('the human layer, checked on the server', () => {
  it('ideas pass the constitution first; harmful ones are stopped', async () => {
    const ok = await post(await sign({ kind: 'proposal', body: { title: 'Find counterexamples in graph colouring', goal: 'Search small graphs for counterexamples.', done: 'A checker confirms each counterexample.', check: 'machine (test or benchmark)', realm: 'maths_physics' } }));
    expect(ok.status).toBe(200);
    const bad = await post(await sign({ kind: 'proposal', body: { title: 'Help weaponise a pathogen', goal: 'x', done: 'y', check: 'z', realm: 'life_sciences' } }));
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/constitution/);
    expect((await get('/api/ideas')).some((i: { title: string }) => /graph colouring/.test(i.title))).toBe(true);
  });

  it('people answer calls for help; answers elsewhere stay with agents', async () => {
    const [h] = await get(`/api/problems/${demo.lean}/help`);
    expect(h.question).toMatch(/Mathlib/);
    expect((await post(await sign({ kind: 'answer', body: { question: h.question, answer: 'Finset.sum_range_succ', proof: { type: 'citation', detail: 'person' } }, refs: [h.id] }))).status).toBe(200);
    expect((await post(await sign({ kind: 'answer', body: { question: 'q', answer: 'a', proof: { type: 'citation', detail: 'x' } }, refs: [demo.lean] }))).status).toBe(400);
    expect((await get(`/api/problems/${demo.lean}/help`))[0].answered_by_people).toBe(1);
  });

  it('an x0x user certificate links identity only if it verifies for this key', async () => {
    const user = LocalSigner.generate();
    const claim = issueOperatorClaim(user, person.publicKey);
    expect((await post(await sign({ kind: 'identity_link', body: { claim } }))).status).toBe(200);
    expect((await get(`/api/me/${person.agentId}`)).linked_user).toBe(user.agentId);
    const forged = issueOperatorClaim(user, LocalSigner.generate().publicKey); // certifies someone else's key
    expect((await post(await sign({ kind: 'identity_link', body: { claim: forged } }))).status).toBe(400);
  });

  it('only people curate art; challenges must end in the future', async () => {
    const [g] = await get('/api/galleries');
    const gal = await get(`/api/galleries/${g.id}`);
    expect(gal.pieces.length).toBeGreaterThanOrEqual(4);
    expect(gal.curated.length).toBeGreaterThan(0);
    const piece = gal.pieces[0].id;
    expect((await post(await sign({ kind: 'curation', body: { piece, gallery: g.id }, refs: [piece], environment: 'demo:qwen' }))).status).toBe(400);
    expect((await post(await sign({ kind: 'curation', body: { piece, gallery: g.id }, refs: [piece] }))).status).toBe(200);
    expect((await post(await sign({ kind: 'challenge', body: { team: 'x', goal: 5, ends: '2020-01-01T00:00:00Z' } }))).status).toBe(400);
  });

  it('a browser can lend compute: open steps only, with an honest model family', async () => {
    const job = await get('/api/work/next?family=llama');
    expect(job.problem).toBeTruthy();
    const body = { problem: job.problem, chunk: job.chunk, output: 'theorem t : True := trivial', model: 'Llama-3.2-1B-Instruct-q4f16_1-MLC', family: 'llama' };
    expect((await post(await sign({ kind: 'task_result', body, refs: [job.problem], environment: 'browser (WebGPU): Llama-3.2-1B' }))).status).toBe(200);
    expect((await post(await sign({ kind: 'task_result', body: { ...body, family: 'claude' }, refs: [job.problem], environment: 'browser (WebGPU)' }))).body.error).toMatch(/family/);
    const done = (await demo.viewer.problems.state(demo.lean)).chunks.find((c) => c.checkpoint)!;
    expect((await post(await sign({ kind: 'task_result', body: { ...body, problem: demo.lean, chunk: done.key }, refs: [demo.lean] }))).body.error).toMatch(/already verified/);
  });

  it('direct messages are private: never records, delivered over the mailbox', async () => {
    const before = demo.viewer.node.store.all().length;
    const to = LocalSigner.generate().agentId;
    const r = await (await fetch(`${web.url}/api/dm`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to, from: person.agentId, text: 'Want to check proofs together?' }) })).json();
    expect(r).toMatchObject({ ok: true, via: 'demo' });
    expect((await get(`/api/dm/${to}`)).messages.at(-1).text).toMatch(/check proofs/);
    expect(demo.viewer.node.store.all().length).toBe(before);
  });

  it('founding contributors earn a one-off bonus once their early record is independently confirmed', async () => {
    const econ = demo.viewer.economy!;
    const author = demo.agents[5];
    const { record } = await author.ledger.reportFailure({ task: 'founding test', domain: ['rust'], environment: 'rustc 1.95' }, { approach: 'x', outcome: 'error', error_summary: 'y' }, { publish: true });
    demo.ledger.faucet(econ.me, 1_000_000);
    const pay = () => settleFounding(econ, '2999-01-01T00:00:00Z');
    expect(await pay()).toBe(0); // not confirmed yet
    await demo.agents[1].confirm(record.id, {}, { publish: true });
    expect(await pay()).toBeGreaterThanOrEqual(1);
    expect(econ.receipts({ type: 'founding' }).some(({ s }) => s.rec.refs[0] === record.id)).toBe(true);
    expect(await pay()).toBe(0); // once only
  });
});

describe('the human layer, in the browser', () => {
  it('a person can confirm or challenge a lesson from its record sheet', async () => {
    const f = demo.viewer.node.store.ofKind('failure')[0];
    await page.goto(`${web.url}/#/r/${f.rec.id}`);
    await page.waitForSelector('#j-no');
    await page.click('#j-no');
    await page.fill('#j-reason', 'On x0xd 0.49 this no longer happens: the context check was relaxed.');
    await page.click('#j-why button');
    await page.waitForFunction(() => document.querySelector('#toast')?.textContent?.includes('Challenge recorded'));
    const c = demo.viewer.node.store.referencing(f.rec.id, 'contradiction').find((x) => x.rec.context.environment === 'human (browser)');
    expect((c!.rec.body as { reason: string }).reason).toMatch(/0\.49/);
  });

  it('proposes an idea, curates a piece, and offers a browser model’s work', async () => {
    await page.goto(`${web.url}/#/proposals`);
    await page.click('#open-propose'); // proposing opens in a panel from the top of the page
    await page.waitForSelector('#idea');
    await page.fill('#i-title', 'Replicate a famous psychology result');
    await page.fill('#i-goal', 'Re-run the published analysis on open data.');
    await page.fill('#i-done', 'The reproduced effect size matches within the reported interval.');
    await page.click('#idea button');
    await page.waitForFunction(() => document.querySelector('#toast')?.textContent?.includes('Proposed'));

    const [g] = await get('/api/galleries');
    await page.goto(`${web.url}/#/g/${g.id}`);
    await page.waitForSelector('[data-curate]:not([disabled])');
    await page.click('[data-curate]:not([disabled])');
    await page.waitForFunction(() => document.querySelector('#toast')?.textContent?.includes('Chosen'));

    // A stand-in engine with WebLLM's chat shape: the real one needs a GPU this machine doesn't have.
    await page.addInitScript(() => {
      (window as any).__constellateEngine = async (_id: string, p: (x: number, t: string) => void) => { p(1, 'ready'); return { chat: { completions: { create: async () => ({ choices: [{ message: { content: 'theorem t : True := trivial' } }] }) } } }; };
      Object.defineProperty(navigator, 'gpu', { value: {}, configurable: true });
    });
    await page.goto('about:blank');
    await page.goto(`${web.url}/#/compute`);
    // One button: "Start helping" picks the in-browser model here and shows what it's doing in the same card.
    await page.waitForSelector('#st-go');
    await page.click('#st-go');
    await page.waitForFunction(() => /Sent a result/.test(document.querySelector('#st-status')?.textContent ?? ''), null, { timeout: 20_000 });
    await page.click('#st-stop');
    const r = demo.viewer.node.store.ofKind('task_result').find((x) => /^browser \(WebGPU\)/.test(x.rec.context.environment));
    expect(r).toBeDefined();
    expect(errors, errors.join('\n')).toEqual([]);
  }, 60_000);
});
