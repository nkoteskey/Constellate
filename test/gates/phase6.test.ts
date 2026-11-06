import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import type { Browser, Page } from 'playwright';
import { seedDemo } from '../../src/demo.js';
import { WebServer } from '../../src/web/server.js';
import { registerAppRoutes } from '../../src/web/app.js';
import { registerEconomyRoutes } from '../../src/economy/routes.js';
import { verifyRecord } from '../../src/core/record.js';

/**
 * GATE 6: a newcomer makes a first contribution within five minutes, unaided.
 * The real gate needs real people (READY FOR HUMAN TESTING: watch five
 * first-time users with no instructions). This test scripts a newcomer through
 * the shortest path a person would take in a real browser, and times it.
 */
const require = createRequire(import.meta.url);
let browser: Browser, page: Page, web: WebServer, demo: Awaited<ReturnType<typeof seedDemo>>;
const errors: string[] = [];

beforeAll(async () => {
  demo = await seedDemo({ steps: 16, knowledge: 120 });
  web = new WebServer(demo.viewer);
  registerAppRoutes(web);
  registerEconomyRoutes(web, demo.viewer.economy!);
  await web.listen(0);
  const { chromium } = require('playwright');
  browser = await chromium.launch();
  page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
}, 120_000);
afterAll(async () => { await browser?.close(); await web?.close(); });

describe('GATE 6 — human experience', () => {
  it('a newcomer lands on the living sky and makes a signed first contribution in a few clicks', async () => {
    const t0 = Date.now();
    await page.goto(web.url);
    await page.waitForSelector('#featured a');
    // Honest headline: 'thousands' only when the real count supports it.
    expect(await page.textContent('#sky-line')).toMatch(/^Minds, human and AI/);
    expect(await page.textContent('.no-account')).toMatch(/No account needed/);
    const featured = await page.$$eval('#featured a', (as) => as.map((a) => a.textContent));
    expect(featured.length).toBe(3);

    // Click the debate hook, rate an argument: one tap.
    await page.click('#featured a:has-text("fairness")');
    await page.waitForSelector('.stars button');
    await page.click('.stars button[data-score="4"]');
    await page.waitForSelector('#toast:not([hidden])');
    expect(await page.textContent('#toast')).toMatch(/Your light joined the sky/);
    const seconds = (Date.now() - t0) / 1000;
    expect(seconds).toBeLessThan(300);

    // The contribution is a real signed record from a key made in the browser, labelled human.
    const ratings = demo.viewer.node.store.ofKind('rating').filter((r) => r.rec.context.environment === 'human (browser)');
    expect(ratings).toHaveLength(1);
    expect(verifyRecord(ratings[0].rec).ok).toBe(true);
    // ...and it reached the other machines over gossip.
    expect(demo.agents[0].node.store.get(ratings[0].rec.id)).toBeDefined();
    expect(errors).toEqual([]);
  }, 60_000);

  it('the same person can vote from a problem page and see it on their Me page', async () => {
    await page.goto(`${web.url}/#/p/${demo.lean}`);
    await page.waitForSelector('#help');
    expect(await page.textContent('#page h1')).toMatch(/Lean/);
    expect(await page.$$eval('.timeline [data-rec]', (l) => l.length)).toBeGreaterThan(0);
    await page.click('#help');
    await page.click('[data-act="vote"]');
    await page.waitForFunction(() => document.querySelector('#toast')?.textContent?.includes('Vote counted'));
    await page.goto(`${web.url}/#/me`);
    await page.waitForSelector('.stat b');
    expect(await page.textContent('.stat b')).toBe('2');
    expect(await page.textContent('#page')).toMatch(/Formalise the basics in Lean 4/);
  });

  it('every claim is clickable back to its signed record', async () => {
    await page.goto(`${web.url}/#/p/${demo.lean}`);
    await page.waitForSelector('.timeline [data-rec]');
    await page.click('.timeline [data-rec]');
    await page.waitForSelector('#sheet');
    expect(await page.textContent('#sheet')).toMatch(/Signed record [0-9a-f]{64}/);
  });

  it('plain-language questions get plain answers', async () => {
    await page.goto(web.url);
    await page.fill('#seek-q', "what's happening with the Lean proofs?");
    await page.press('#seek-q', 'Enter');
    await page.waitForFunction(() => /steps are verified/.test(document.querySelector('#results')?.textContent ?? ''));
    // The utility hook: an error message finds what failed before and what fixed it.
    await page.fill('#seek-q', 'x0x agent sign 400 invalid context');
    await page.press('#seek-q', 'Enter');
    await page.waitForFunction(() => /What fixed it/i.test(document.querySelector('#results')?.textContent ?? ''));
  });

  it('works at phone width with a plain list view and calm mode', async () => {
    const phone = await browser.newPage({ viewport: { width: 375, height: 740 } });
    await phone.goto(`${web.url}/#/list`);
    await phone.waitForSelector('a.card');
    const overflow = await phone.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);
    await phone.click('#motion');
    expect(await phone.getAttribute('#motion', 'aria-pressed')).toBe('true');
    await phone.close();
  });

  it('Amendment 1: logo, graph threads and bridges, chat, people, invites, embeds, metrics', async () => {
    await page.goto(web.url);
    await page.waitForSelector('#featured a');
    expect(await page.$$eval('#logo circle', (c) => c.map((x) => x.getAttribute('fill')))).toEqual(['#ffc46b', '#7cc4ff', '#fff']);
    const graph = await (await fetch(`${web.url}/api/graph`)).json();
    expect(graph.bridges.length).toBeGreaterThan(0);
    expect(graph.threads.some((t: { bridge: boolean }) => t.bridge)).toBe(true);
    // Problem chat between people and agents, posted with the browser key.
    await page.goto(`${web.url}/#/p/${demo.lean}?from=abc123`);
    await page.waitForSelector('#chat-form');
    expect(await page.isVisible('#invite')).toBe(true);
    expect(await page.textContent('.chat')).toMatch(/List.range_succ/);
    await page.fill('#chat-text', 'I can check the Gauss proof tonight.');
    await page.press('#chat-text', 'Enter');
    await page.waitForFunction(() => document.querySelector('.chat')?.textContent?.includes('Gauss proof tonight'));
    expect(demo.agents[1].people.chat(demo.lean).some((m) => m.human && /Gauss/.test(m.text))).toBe(true);
    // People discovery, humans and agents side by side.
    await page.goto(`${web.url}/#/people`);
    await page.waitForSelector('.people-grid .tag.human');
    expect(await page.$$eval('.people-grid .tag.agent', (x) => x.length)).toBeGreaterThan(0);
    // Live embed.
    const embed = await browser.newPage();
    await embed.goto(`${web.url}/embed.html?p=${demo.lean}`);
    await embed.waitForSelector('.bar');
    expect(await embed.textContent('h1')).toMatch(/Lean/);
    await embed.close();
    // Metrics instrumented.
    const m = await (await fetch(`${web.url}/api/metrics`)).json();
    expect(m.median_seconds_to_first_contribution).not.toBeNull();
    expect(m.agents_connected_this_week).toBeGreaterThan(0);
    expect(m.records_confirmed).toBeGreaterThan(0);
    // A2A card.
    const card = await (await fetch(`${web.url}/.well-known/agent-card.json`)).json();
    expect(card.skills.some((s: { id: string }) => s.id === 'constellate.failures')).toBe(true);
    expect(errors).toEqual([]);
  });

  it('refuses records the app may not submit, and bad signatures', async () => {
    const bad = await fetch(`${web.url}/api/records`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...demo.viewer.node.store.ofKind('rating')[0].rec, body: { argument: 'x', score: 5 } }) });
    expect(bad.status).toBe(400);
    const cp = demo.viewer.node.store.ofKind('checkpoint')[0].rec;
    const wrongKind = await fetch(`${web.url}/api/records`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(cp) });
    expect((await wrongKind.json()).error).toMatch(/cannot submit checkpoint/);
  });
});
