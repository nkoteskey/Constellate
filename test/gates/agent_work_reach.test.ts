import { describe, it, expect } from 'vitest';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Hub } from '../../src/hub/hub.js';
import { LocalSigner } from '../../src/core/identity.js';
import { RecordStore } from '../../src/store/records.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { ProblemBody } from '../../src/work/problems.js';
import { WebServer } from '../../src/web/server.js';
import { registerAppRoutes } from '../../src/web/app.js';

/**
 * "Have your agent work on it" without asking any agent to check Constellate. The app starts the work with what
 * this computer can run on its own (Claude Code, headless, with Constellate's tools); without that, connected
 * agents get the request (those with sampling act at once), and any agent that calls work_step for any reason
 * sees what its person asked for first, every time, not as a note it might have missed. Both the problem page
 * and the Proposals page can ask.
 */
const problemBody = () => ProblemBody.parse({ title: 'Small facts', hook: 'Tiny', goal: 'Answer small questions exactly, checked by machine.', realm: 'maths_physics', definition_of_done: { verifier: 'exact', description: 'Matches exactly.' },
  chunks: [{ key: 'first', title: 'Six times seven', prompt: 'What is 6 × 7?', check: { expected: '42' }, needs: { size: 'any' } }] });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The Proposals page, then the problem's "Have your agent work on it", from whichever tab lists it. */
async function openFromProposals(webUrl: string, id: string) {
  const { chromium } = createRequire(import.meta.url)('playwright');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  const errors: string[] = [];
  page.on('pageerror', (e: Error) => errors.push(String(e)));
  await page.goto(`${webUrl}/#/proposals`);
  await page.waitForSelector('[data-ptab]');
  for (const tab of await page.$$eval('[data-ptab]', (ts) => ts.map((t) => (t as HTMLElement).dataset.ptab!))) {
    await page.click(`[data-ptab="${tab}"]`);
    if (await page.$(`[data-work="${id}"]`)) break;
  }
  const btn = page.locator(`[data-work="${id}"]`);
  expect(await btn.textContent()).toBe('Have your agent work on it');
  await btn.click();
  await page.waitForSelector('#aw-body');
  return { browser, page, errors };
}

describe('your agent works on a problem without you asking it to check Constellate', () => {
  it('work_step lists what the person asked for, every time, even after the one-off note went by', async () => {
    process.env.CONSTELLATE_HOME = mkdtempSync(join(tmpdir(), 'reach-'));
    try {
      const hub = new Hub({ signer: LocalSigner.generate(), store: new RecordStore(), preview: false });
      await hub.collective.propose({ ...problemBody(), title: 'Another problem' });
      const id = (await hub.collective.propose(problemBody())).problem!.id;
      const req = hub.workRequests.create(id, 'Small facts', 1);
      const server = createMcpServer(hub);
      const [a, b] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'claude-ai', version: '1' }); // Claude Desktop, no sampling
      await Promise.all([server.connect(a), client.connect(b)]);
      const call = async (name: string, args: Record<string, unknown> = {}) => JSON.parse(((await client.callTool({ name, arguments: args })).content as { text: string }[])[0].text);

      // An unrelated call carries the one-off note; the next one doesn't. This is where requests used to get lost.
      expect((await call('failures_search', { query: 'tokio panics' })).person_asked).toBeDefined();
      expect((await call('failures_search', { query: 'tokio panics' })).person_asked).toBeUndefined();
      expect(hub.workRequests.get(req.id)!.status).toBe('waiting');

      const r = await call('work_step');
      expect(r.your_person_asked).toContain(id);
      expect(r.open.map((s: { problem: string }) => s.problem)).toEqual([id]); // that problem's steps, not any problem's
      expect(hub.workRequests.get(req.id)!).toMatchObject({ status: 'working', by: 'Claude Desktop' });
      expect(hub.workRequests.get(req.id)!.log.map((l) => l.text)).toContain('Claude Desktop picked it up.');
      expect((await call('work_step')).your_person_asked).toContain(id); // asked again: still there

      await call('work_step', { problem: id, step: 'first', answer: '42', model: 'claude-sonnet-4.5' });
      expect(hub.workRequests.get(req.id)!).toMatchObject({ status: 'done', steps: 1 });
      expect((await call('work_step')).your_person_asked).toBeUndefined(); // done: nothing left to ask
      await client.close();
    } finally { delete process.env.CONSTELLATE_HOME; }
  });

  it('with Claude Code on this computer, one click on the Proposals page starts it: nothing to choose, nothing to tell an agent', async () => {
    const home = mkdtempSync(join(tmpdir(), 'reach-cc-'));
    process.env.CONSTELLATE_HOME = home;
    // A stand-in for Claude Code that answers the step through work_step, as the real one does.
    const fake = join(home, 'claude');
    const lines = [
      { type: 'system', subtype: 'init', model: 'claude-sonnet', mcp_servers: [{ name: 'constellate', status: 'connected' }] },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__constellate__work_step', input: { problem: 'x', step: 'first', answer: '42' } }] } },
      { type: 'result', duration_ms: 3000, total_cost_usd: 0.02 },
    ];
    writeFileSync(fake, `#!/usr/bin/env node\nfor (const l of ${JSON.stringify(lines.map((x) => JSON.stringify(x)))}) console.log(l);\n`);
    chmodSync(fake, 0o755);
    process.env.CONSTELLATE_CLAUDE = fake;
    const hub = new Hub({ signer: LocalSigner.generate(), store: new RecordStore(), preview: false });
    const id = (await hub.collective.propose(problemBody())).problem!.id;
    const web = new WebServer(hub);
    registerAppRoutes(web);
    await web.listen(0);
    const { browser, page, errors } = await openFromProposals(web.url, id);
    try {
      for (let i = 0; i < 100 && hub.agentRuns.forProblem(id)[0]?.status !== 'done'; i++) await wait(50);
      expect(hub.agentRuns.forProblem(id)[0]).toMatchObject({ status: 'done', steps: 1 });
      await page.waitForFunction(() => document.querySelector('#aw-body')?.textContent?.includes('done · 1 answered'));
      expect(await page.textContent('#aw-body')).not.toMatch(/Open it and say|check Constellate/i);
      expect(hub.workRequests.forProblem(id)).toEqual([]); // no request left waiting for anyone
      expect(errors).toEqual([]);
    } finally { await browser.close(); await web.close(); process.env.CONSTELLATE_CLAUDE = 'off'; delete process.env.CONSTELLATE_HOME; }
  }, 60_000);

  it('without anything here that can run on its own, the request goes out by itself and the page says plainly why it waits', async () => {
    process.env.CONSTELLATE_HOME = mkdtempSync(join(tmpdir(), 'reach-ui-'));
    const hub = new Hub({ signer: LocalSigner.generate(), store: new RecordStore(), preview: false });
    const id = (await hub.collective.propose(problemBody())).problem!.id;
    const web = new WebServer(hub);
    registerAppRoutes(web);
    await web.listen(0);
    const { browser, page, errors } = await openFromProposals(web.url, id);
    try {
      await page.waitForFunction(() => document.querySelector('#aw-body')?.textContent?.includes('waiting for an agent'));
      expect(hub.workRequests.forProblem(id)[0].status).toBe('waiting'); // asked without a click
      const text = await page.textContent('#aw-body');
      expect(text).toMatch(/Claude Desktop and Cursor can’t be started by another app/);
      expect(text).toMatch(/install Claude Code/);
      expect(text).not.toMatch(/Open it and say|check Constellate/i);
      expect(errors).toEqual([]);
    } finally { await browser.close(); await web.close(); delete process.env.CONSTELLATE_HOME; }
  }, 60_000);
});

describe('planning an idea without telling an agent anything', () => {
  it('with Claude Code on this computer, "Plan it with your agent" starts it at once', async () => {
    const home = mkdtempSync(join(tmpdir(), 'reach-plan-'));
    process.env.CONSTELLATE_HOME = home;
    const fake = join(home, 'claude');
    writeFileSync(fake, `#!/usr/bin/env node\nconsole.log(JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-sonnet', mcp_servers: [{ name: 'constellate', status: 'connected' }] }));\nconsole.log(JSON.stringify({ type: 'result', duration_ms: 1000 }));\n`);
    chmodSync(fake, 0o755);
    process.env.CONSTELLATE_CLAUDE = fake;
    const hub = new Hub({ signer: LocalSigner.generate(), store: new RecordStore(), preview: false });
    const { record: idea } = await hub.node.submit({ kind: 'proposal', context: { task: 'idea', domain: ['maths_physics'], environment: 'human (browser)' }, body: { title: 'Count small primes', goal: 'Count primes below a bound, checked exactly.', done: 'Every count matches.', check: 'exact', realm: 'maths_physics' } }, { publish: true });
    const web = new WebServer(hub);
    registerAppRoutes(web);
    await web.listen(0);
    const { chromium } = createRequire(import.meta.url)('playwright');
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
      const errors: string[] = [];
      page.on('pageerror', (e: Error) => errors.push(String(e)));
      await page.goto(`${web.url}/#/proposals`);
      await page.click('[data-ptab="ideas"]');
      await page.click(`[data-plan="${idea.id}"]`);
      for (let i = 0; i < 100; i++) { const r = await (await fetch(`${web.url}/api/plans?idea=${idea.id}`)).json() as { requests: { via: string }[] }; if (r.requests.length) break; await wait(50); }
      const { requests } = await (await fetch(`${web.url}/api/plans?idea=${idea.id}`)).json() as { requests: { via: string }[] };
      expect(requests[0]?.via).toBe('claude_code'); // started on its own, no option picked
      expect(await page.textContent('#plan-body')).not.toMatch(/check Constellate for planning requests/i);
      expect(errors).toEqual([]);
    } finally { await browser.close(); await web.close(); process.env.CONSTELLATE_CLAUDE = 'off'; delete process.env.CONSTELLATE_HOME; }
  }, 60_000);
});
