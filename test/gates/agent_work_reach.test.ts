import { describe, it, expect } from 'vitest';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
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

  it('the choices are one list: Claude Code first, then any model this computer reaches, then agents you start yourself', async () => {
    const home = mkdtempSync(join(tmpdir(), 'reach-list-'));
    process.env.CONSTELLATE_HOME = home;
    process.env.CONSTELLATE_CLAUDE = fakeClaude(home);
    const ollama = await fakeOllama();
    process.env.OLLAMA_HOST = ollama.url;
    const hub = new Hub({ signer: LocalSigner.generate(), store: new RecordStore(), preview: false });
    const id = (await hub.collective.propose(problemBody())).problem!.id;
    const web = new WebServer(hub);
    registerAppRoutes(web);
    await web.listen(0);
    const { browser, page, errors } = await openFromProposals(web.url, id);
    try {
      await page.waitForSelector('input[name="aw-who"]');
      const names = await page.$$eval('input[name="aw-who"]', (rs) => rs.map((r) => (r as HTMLInputElement).value));
      expect(names).toEqual(['claude_code', 'model:ollama/qwen3:8b', 'any']);
      expect(await page.$eval('input[name="aw-who"]:checked', (r) => (r as HTMLInputElement).value)).toBe('claude_code');
      const text = await page.textContent('#aw-body');
      expect(text).not.toMatch(/default/i); // first in the list, not singled out
      expect(text).toMatch(/You have to start it yourself/);
      expect(hub.agentRuns.forProblem(id)).toEqual([]); // nothing starts until Start
      await page.click('#aw-go');
      for (let i = 0; i < 100 && hub.agentRuns.forProblem(id)[0]?.status !== 'done'; i++) await wait(50);
      expect(hub.agentRuns.forProblem(id)[0]).toMatchObject({ status: 'done', steps: 1 });
      expect(errors).toEqual([]);
    } finally { await browser.close(); await web.close(); ollama.close(); delete process.env.OLLAMA_HOST; process.env.CONSTELLATE_CLAUDE = 'off'; delete process.env.CONSTELLATE_HOME; }
  }, 60_000);

  it('any make and model: without Claude Code, a model this computer reaches does the steps, and its answer is checked like any other', async () => {
    process.env.CONSTELLATE_HOME = mkdtempSync(join(tmpdir(), 'reach-model-'));
    const ollama = await fakeOllama();
    process.env.OLLAMA_HOST = ollama.url;
    const hub = new Hub({ signer: LocalSigner.generate(), store: new RecordStore(), preview: false });
    const id = (await hub.collective.propose(problemBody())).problem!.id;
    const web = new WebServer(hub);
    registerAppRoutes(web);
    await web.listen(0);
    const { browser, page, errors } = await openFromProposals(web.url, id);
    try {
      await page.waitForSelector('input[name="aw-who"]');
      expect(await page.$eval('input[name="aw-who"]:checked', (r) => (r as HTMLInputElement).value)).toBe('model:ollama/qwen3:8b');
      await page.click('#aw-go');
      await page.waitForFunction(() => document.querySelector('#aw-body')?.textContent?.includes('done · 1 answered'), undefined, { timeout: 15_000 });
      const result = hub.node.store.ofKind('task_result')[0].rec;
      expect(result.body).toMatchObject({ problem: id, chunk: 'first', output: '6 × 7 is\n42', model: 'qwen3:8b', family: 'qwen' }); // the check reads the last line
      expect(result.context.agent).toMatchObject({ client: 'Ollama', model: 'qwen3:8b' });
      expect(ollama.prompts[0]).toContain('What is 6 × 7?');
      expect(ollama.prompts.join(' ')).not.toMatch(/expected/); // the check, which holds the answer, is never sent
      expect(errors).toEqual([]);
    } finally { await browser.close(); await web.close(); ollama.close(); delete process.env.OLLAMA_HOST; delete process.env.CONSTELLATE_HOME; }
  }, 60_000);

  it('Claude Desktop is a choice with a note that you start it yourself', async () => {
    process.env.CONSTELLATE_HOME = mkdtempSync(join(tmpdir(), 'reach-desk-'));
    const hub = new Hub({ signer: LocalSigner.generate(), store: new RecordStore(), preview: false });
    const id = (await hub.collective.propose(problemBody())).problem!.id;
    const web = new WebServer(hub);
    registerAppRoutes(web);
    await web.listen(0);
    const { browser, page, errors } = await openFromProposals(web.url, id);
    try {
      await page.waitForSelector('input[name="aw-who"]');
      expect(await page.$$eval('input[name="aw-who"]', (rs) => rs.map((r) => (r as HTMLInputElement).value))).toEqual(['any']);
      const text = await page.textContent('#aw-body');
      expect(text).toMatch(/Claude Desktop, Cursor or another connected agent/);
      expect(text).toMatch(/You have to start it yourself/);
      expect(text).toMatch(/install Claude Code, run a model with Ollama or LM Studio, or save a provider key/);
      await page.click('#aw-go');
      await page.waitForFunction(() => document.querySelector('#aw-body')?.textContent?.includes('waiting for you to start it'));
      expect(hub.workRequests.forProblem(id)[0].status).toBe('waiting');
      expect(errors).toEqual([]);
    } finally { await browser.close(); await web.close(); delete process.env.CONSTELLATE_HOME; }
  }, 60_000);
});

describe('planning an idea: the same list', () => {
  it('Claude Code first, then models, then agents you start yourself; Start plans it with the chosen one', async () => {
    const home = mkdtempSync(join(tmpdir(), 'reach-plan-'));
    process.env.CONSTELLATE_HOME = home;
    process.env.CONSTELLATE_CLAUDE = fakeClaude(home);
    const ollama = await fakeOllama();
    process.env.OLLAMA_HOST = ollama.url;
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
      await page.waitForSelector('input[name="plan-who"]');
      expect(await page.$$eval('input[name="plan-who"]', (rs) => rs.map((r) => (r as HTMLInputElement).value))).toEqual(['claude_code', 'model:ollama/qwen3:8b', 'any_agent']);
      expect(await page.textContent('#plan-body')).toMatch(/You have to start it yourself/);
      await page.check('input[name="plan-who"][value="model:ollama/qwen3:8b"]');
      await page.click('#plan-go');
      for (let i = 0; i < 100; i++) { const r = await (await fetch(`${web.url}/api/plans?idea=${idea.id}`)).json() as { requests: unknown[] }; if (r.requests.length) break; await wait(50); }
      const { requests } = await (await fetch(`${web.url}/api/plans?idea=${idea.id}`)).json() as { requests: { via: string; log: { text: string }[] }[] };
      expect(requests[0].via).toBe('model');
      expect(requests[0].log[0].text).toMatch(/ollama:qwen3:8b/);
      expect(errors).toEqual([]);
    } finally { await browser.close(); await web.close(); ollama.close(); delete process.env.OLLAMA_HOST; process.env.CONSTELLATE_CLAUDE = 'off'; delete process.env.CONSTELLATE_HOME; }
  }, 60_000);
});

/** A stand-in for Claude Code that answers the step through work_step, as the real one does. */
function fakeClaude(home: string) {
  const fake = join(home, 'claude');
  const lines = [
    { type: 'system', subtype: 'init', model: 'claude-sonnet', mcp_servers: [{ name: 'constellate', status: 'connected' }] },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__constellate__work_step', input: { problem: 'x', step: 'first', answer: '42' } }] } },
    { type: 'result', duration_ms: 3000, total_cost_usd: 0.02 },
  ];
  writeFileSync(fake, `#!/usr/bin/env node\nfor (const l of ${JSON.stringify(lines.map((x) => JSON.stringify(x)))}) console.log(l);\n`);
  chmodSync(fake, 0o755);
  return fake;
}

/** A stand-in for Ollama: lists one model and answers chat completions with "42", keeping the prompts it saw. */
async function fakeOllama() {
  const prompts: string[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'qwen3:8b' }, { name: 'nomic-embed-text' }] }));
      if (req.url === '/v1/chat/completions') { const j = JSON.parse(body); prompts.push(j.messages.map((m: { content: string }) => m.content).join('\n')); return res.end(JSON.stringify({ choices: [{ message: { content: '6 × 7 is\n42' } }] })); }
      res.statusCode = 404; res.end('{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, prompts, close: () => server.close() };
}
