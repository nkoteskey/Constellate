import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Hub } from '../../src/hub/hub.js';
import { LocalSigner } from '../../src/core/identity.js';
import { Consolidator } from '../../src/graph/consolidate.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { verifyRecord, type SignedRecord } from '../../src/core/record.js';
import { WebServer } from '../../src/web/server.js';
import { registerAppRoutes } from '../../src/web/app.js';

/**
 * Topic pages written on their own (docs/MEMORY.md): once a topic has enough verified records, its page is
 * written without anyone asking, signed, linking its sources; agents get the page first, and people get a
 * readable page with a link that stays the same as the page is rewritten.
 */
const computer = () => new Hub({ signer: LocalSigner.generate(), preview: false });
const ctx = { task: 'Keep peer connections alive', domain: ['networking', 'quic'], environment: 'x0x 0.48' };
const wait = async (ok: () => boolean, ms = 4000) => { for (let t = 0; t < ms && !ok(); t += 20) await new Promise((r) => setTimeout(r, 20)); return ok(); };

async function topic() {
  const me = computer(), others = [computer(), computer(), computer()];
  const all = [me, ...others];
  const spread = (r: SignedRecord) => { for (const h of all) h.node.ingest(r); };
  const f1 = (await me.ledger.reportFailure(ctx, { approach: 'Reconnect immediately after a peer restarts', outcome: 'error', error_summary: 'Connection refused while the old connection closes' }, { publish: true })).record;
  const f2 = (await me.ledger.reportFailure(ctx, { approach: 'Reuse the stale connection after a peer restart', outcome: 'error', error_summary: 'Handshake discarded on reconnect' }, { publish: true })).record;
  const a1 = (await me.ledger.submitAnswer(ctx, { question: 'Connection refused after a peer restart', answer: 'Wait for the old connection to close before reconnecting. Retry with backoff.', proof: { type: 'test', detail: 'reconnect test passes' } }, { publish: true, fixes: [f1.id, f2.id] })).record;
  const a2 = (await me.ledger.submitAnswer(ctx, { question: 'Handshake discarded on reconnect after peer restart', answer: 'Mark the dead connection closed before accepting the new handshake.', proof: { type: 'test', detail: 'reconnect test passes' } }, { publish: true, fixes: [f2.id, f1.id] })).record;
  for (const r of [f1, f2, a1, a2]) spread(r);
  return { me, others, spread, f1, f2, a1, a2 };
}

describe('topic pages written on their own', () => {
  it('a topic gets its page once it has enough verified records, signed and linking its sources', async () => {
    const { me, others, spread, f1, f2, a1, a2 } = await topic();
    const auto = me.pages.auto(() => new Consolidator(me, undefined, { minVerified: 3 }).sleep(), { settleMs: 30 });
    try {
      // Two verified records: not enough yet.
      for (const [o, id] of [[others[0], a1.id], [others[1], a2.id]] as const) spread((await o.tried(id, { worked: true, environment: 'x0x 0.48', error_before: 'Connection refused' }, { publish: true })).record);
      await new Promise((r) => setTimeout(r, 300));
      expect(me.pages.latest()).toHaveLength(0);
      // A third: the page is written, with no one asking.
      spread((await others[2].confirm(f1.id, { environment: 'x0x 0.48', note: 'hit the same' }, { publish: true })).record);
      expect(await wait(() => me.pages.latest().length === 1)).toBe(true);
      const page = me.pages.latest()[0];
      expect(verifyRecord(page.rec).ok).toBe(true);
      expect(page.rec.agent_id).toBe(me.node.agentId);
      expect([...page.rec.refs].sort()).toEqual([f1.id, f2.id, a1.id, a2.id].sort());
      const view = me.pages.view(page);
      expect(view.rules.length).toBeGreaterThan(0);
      expect(view.rules.some((r) => r.status === 'checked')).toBe(true);
      expect(view.link).toBe(`#/topic/${view.topic}`);

      // It grows: a new lesson joins and the page is rewritten under the same topic, so the link still works.
      const a3 = (await others[0].ledger.submitAnswer(ctx, { question: 'Connection refused after a peer restart', answer: 'Use the connection pool’s drain hook before redialling.', proof: { type: 'test', detail: 'passes' } }, { publish: true, fixes: [f1.id] })).record;
      spread(a3);
      expect(await wait(() => me.pages.history(view.topic).length === 2)).toBe(true);
      expect(me.pages.latest()).toHaveLength(1);
      expect((me.pages.latest()[0].rec.body as { members: string[] }).members).toContain(a3.id);
    } finally { auto.stop(); }
  });

  it('agents get the page first: one compact answer instead of many records', async () => {
    const { me, others, spread, a1, a2, f1 } = await topic();
    for (const [o, id] of [[others[0], a1.id], [others[1], a2.id], [others[2], f1.id]] as const) spread((await o.confirm(id, { environment: 'x0x 0.48' }, { publish: true })).record);
    await new Consolidator(me, undefined, { minVerified: 3 }).sleep();
    const server = createMcpServer(me);
    const [x, y] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'claude-code', version: '1' });
    await Promise.all([server.connect(x), client.connect(y)]);
    const r = JSON.parse(((await client.callTool({ name: 'failures_search', arguments: { query: 'connection refused reconnect after peer restart' } })).content as { text: string }[])[0].text);
    expect(r.page.rules.length).toBeGreaterThan(0);
    expect(r.results).toHaveLength(1);
    expect(r.page_first).toMatch(/distils 4 records/);
    await client.close();
  });

  it('people get a readable page with a stable link', async () => {
    const { me, others, spread, a1, a2, f1 } = await topic();
    for (const [o, id] of [[others[0], a1.id], [others[1], a2.id], [others[2], f1.id]] as const) spread((await o.confirm(id, { environment: 'x0x 0.48' }, { publish: true })).record);
    await new Consolidator(me, undefined, { minVerified: 3 }).sleep();
    const key = me.pages.view(me.pages.latest()[0]).topic;
    const web = new WebServer(me);
    registerAppRoutes(web);
    await web.listen(0);
    const { chromium } = createRequire(import.meta.url)('playwright');
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      const errors: string[] = [];
      page.on('pageerror', (e: Error) => errors.push(String(e)));
      await page.goto(`${web.url}/#/topic/${key}`);
      await page.waitForSelector('.topic h1');
      const text = await page.textContent('.topic');
      expect(text).toContain('What holds');
      expect(text).toContain('Sources');
      expect(text).toMatch(/signed record \(ML-DSA-65\)/);
      expect(await page.$$eval('.topic .result', (els) => els.length)).toBe(4);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
      expect(errors).toEqual([]);
    } finally { await browser.close(); await web.close(); }
  }, 60_000);
});
