import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Hub } from '../../src/hub/hub.js';
import { LocalSigner } from '../../src/core/identity.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { reproduction, reproductionFactor } from '../../src/services/reproduce.js';
import type { SignedRecord } from '../../src/core/record.js';
import { createRequire } from 'node:module';
import { WebServer } from '../../src/web/server.js';
import { registerAppRoutes } from '../../src/web/app.js';

/**
 * Agents reproduce each other's findings (docs/MEMORY.md "Reproducing a fix"): trying a recorded fix ends in a
 * signed confirmation or contradiction with evidence; search shows "confirmed by N agents from M model families
 * on K computers", ranks by independent confirmation, and asks the agent to report back.
 */
const computer = () => new Hub({ signer: LocalSigner.generate(), preview: false });
const ctx = { task: 'Build the docs site', domain: ['node', 'bundler'], environment: 'node 22, linux' };
const share = (from: Hub, to: Hub[], rec: SignedRecord) => { for (const h of to) h.node.ingest(rec); };

async function seed() {
  const author = computer(), b = computer(), c = computer();
  const all = [author, b, c];
  const { record: failure } = await author.ledger.reportFailure(ctx, { approach: 'Upgrade the bundler a major version', outcome: 'error', error_summary: 'Cannot find module bundler/legacy-plugin' }, { publish: true });
  const { record: fix } = await author.ledger.submitAnswer(ctx, { question: 'Cannot find module bundler/legacy-plugin after upgrading the bundler', answer: 'Install the legacy plugin package separately: it moved out of the core bundler in the major release.', proof: { type: 'reproduction', detail: 'build passes' } }, { publish: true, fixes: [failure.id] });
  share(author, [b, c], failure); share(author, [b, c], fix);
  return { author, b, c, all, failure, fix };
}

describe('agents reproduce each other\'s findings', () => {
  it('trying a fix is a signed confirmation or contradiction carrying the environment and the errors before and after', async () => {
    const { author, b, c, all, fix } = await seed();
    b.node.actor = { client: 'Claude Code', model: 'claude-sonnet-4.5' };
    const yes = await b.tried(fix.id, { worked: true, environment: 'node 22, macOS', error_before: 'Cannot find module bundler/legacy-plugin' }, { publish: true });
    expect(yes.record.kind).toBe('confirmation');
    expect((yes.record.body as { tried: unknown }).tried).toEqual({ worked: true, error_before: 'Cannot find module bundler/legacy-plugin', error_after: '' });
    b.node.actor = { client: 'Cursor', model: 'gpt-5' };
    const yes2 = await b.tried(fix.id, { worked: true, environment: 'node 22, macOS', error_before: 'Cannot find module bundler/legacy-plugin' }, { publish: true });
    c.node.actor = { client: 'Gemini CLI', model: 'gemini-2.5-pro' };
    const no = await c.tried(fix.id, { worked: false, environment: 'node 20, windows', error_before: 'Cannot find module bundler/legacy-plugin', error_after: 'Plugin requires node 22' }, { publish: true });
    expect(no.record.kind).toBe('contradiction');
    expect((no.record.body as { reason: string }).reason).toMatch(/Still failing after the fix: Plugin requires node 22/);
    for (const r of [yes.record, yes2.record, no.record]) share(b, all, r);

    const rep = reproduction(author.node.store, author.node.store.get(fix.id)!);
    expect(rep.label).toBe('confirmed by 2 agents from 2 model families on 1 computer');
    expect(rep.disputed_by).toEqual({ agents: 1, computers: 1 });
    // The author's own operator never counts as independent.
    await expect(author.tried(fix.id, { worked: true, environment: 'x', error_before: 'y' })).rejects.toThrow(/own operator/);
  });

  it('search ranks by independent confirmation and names it', async () => {
    const author = computer(), others = [computer(), computer(), computer()];
    const q = 'Cannot find module legacy-plugin after upgrading the bundler';
    const { record: plain } = await author.ledger.submitAnswer(ctx, { question: 'Cannot find module legacy-plugin after upgrading the bundler bundler bundler', answer: 'Downgrade the bundler.', proof: { type: 'test', detail: 'build passes' } }, { publish: true });
    const { record: tried } = await author.ledger.submitAnswer(ctx, { question: 'Cannot find module legacy-plugin', answer: 'Install the legacy plugin package separately.', proof: { type: 'test', detail: 'build passes' } }, { publish: true });
    expect(author.ledger.lookupAnswers(q)[0].id).toBe(plain.id); // on text alone, the other one wins
    for (const [i, o] of others.entries()) {
      o.node.ingest(tried);
      o.node.actor = { client: 'Claude Code', model: ['claude-sonnet-4.5', 'gpt-5', 'qwen3-coder'][i] };
      const r = await o.tried(tried.id, { worked: true, environment: 'node 22', error_before: 'Cannot find module legacy-plugin' }, { publish: true });
      author.node.ingest(r.record);
    }
    const top = author.ledger.lookupAnswers(q)[0];
    expect(top.id).toBe(tried.id);
    expect(top.confirmed).toBe('confirmed by 3 agents from 3 model families on 3 computers');
    expect(reproductionFactor({ computers: 3, families: 3, disputed_by: { agents: 0, computers: 0 } })).toBeGreaterThan(reproductionFactor({ computers: 1, families: 1, disputed_by: { agents: 0, computers: 0 } }));
    expect(reproductionFactor({ computers: 1, families: 1, disputed_by: { agents: 2, computers: 2 } })).toBeLessThan(1);
  });

  it('an agent finding a fix is asked to report back, and does so with one lean tool', async () => {
    const { b, fix } = await seed();
    const server = createMcpServer(b);
    const [x, y] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'claude-code', version: '1' });
    await Promise.all([server.connect(x), client.connect(y)]);
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).toContain('fix_tried');
    const call = async (name: string, args: Record<string, unknown>) => JSON.parse(((await client.callTool({ name, arguments: args })).content as { text: string }[])[0].text);
    const found = await call('failures_search', { query: 'upgrade the bundler major version' });
    expect(found.results[0].fixes[0]).toMatchObject({ id: fix.id, confirmed: null });
    expect(found.report_back).toMatch(/fix_tried/);
    const r = await call('fix_tried', { id: fix.id, worked: true, environment: 'node 22, macOS', error_before: 'Cannot find module bundler/legacy-plugin' });
    expect(r).toMatchObject({ published: true, kind: 'confirmation', now: 'confirmed by 1 agent from 1 model family on 1 computer' });
    const again = await call('failures_search', { query: 'upgrade the bundler major version' });
    expect(again.results[0].fixes[0].confirmed).toBe('confirmed by 1 agent from 1 model family on 1 computer');
    await client.close();
  });

  it('the web search shows who reproduced a fix', async () => {
    const { author, b, c, fix } = await seed();
    for (const [h, model] of [[b, 'claude-sonnet-4.5'], [c, 'gpt-5']] as const) {
      h.node.actor = { client: 'Claude Code', model };
      author.node.ingest((await h.tried(fix.id, { worked: true, environment: 'node 22', error_before: 'Cannot find module bundler/legacy-plugin' }, { publish: true })).record);
    }
    const web = new WebServer(author);
    registerAppRoutes(web);
    await web.listen(0);
    const { chromium } = createRequire(import.meta.url)('playwright');
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      const errors: string[] = [];
      page.on('pageerror', (e: Error) => errors.push(String(e)));
      await page.goto(`${web.url}/#/?q=${encodeURIComponent('upgrade the bundler major version')}`);
      await page.waitForSelector('.fix');
      expect(await page.textContent('.fix')).toContain('Confirmed by 2 agents from 2 model families on 2 computers');
      expect(errors).toEqual([]);
    } finally { await browser.close(); await web.close(); }
  }, 60_000);
});
