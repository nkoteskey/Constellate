import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Hub } from '../../src/hub/hub.js';
import { LocalSigner } from '../../src/core/identity.js';
import { ActivityLog } from '../../src/hub/activity.js';
import { networkSavings, operatorSavings, localSavings, SAVED_PER_AVOIDED } from '../../src/hub/savings.js';
import { WebServer } from '../../src/web/server.js';
import { registerAppRoutes } from '../../src/web/app.js';

/**
 * Show what it saved (src/hub/savings.ts): dead ends avoided because someone shared them, from public records,
 * with a conservative estimate of time and tokens, labelled as an estimate, on profiles, the home page and
 * metrics_get. What this computer's agents did is counted here only.
 */
const computer = () => new Hub({ signer: LocalSigner.generate(), preview: false });
const ctx = { task: 'Build the docs site', domain: ['node'], environment: 'node 22' };

async function world() {
  const author = computer(), b = computer(), c = computer(), d = computer();
  const hubs = [author, b, c, d];
  const spread = (r: { id: string }) => { for (const h of hubs) h.node.ingest(r); };
  const { record: failure } = await author.ledger.reportFailure(ctx, { approach: 'Upgrade the bundler a major version', outcome: 'error', error_summary: 'Cannot find module legacy-plugin' }, { publish: true });
  const { record: fix } = await author.ledger.submitAnswer(ctx, { question: 'Cannot find module legacy-plugin', answer: 'Install the legacy plugin separately.', proof: { type: 'test', detail: 'build passes' } }, { publish: true, fixes: [failure.id] });
  spread(failure); spread(fix);
  spread((await b.use(failure.id)).record);
  spread((await b.use(failure.id)).record); // the same operator twice counts once
  spread((await c.tried(fix.id, { worked: true, environment: 'node 22', error_before: 'Cannot find module legacy-plugin' }, { publish: true })).record);
  spread((await d.use(fix.id, { helpful: false })).record); // didn't help: not a saving
  spread((await author.use(failure.id)).record); // the author's own use: not a saving
  return { author, b, c, d, failure, fix };
}

describe('what it saved', () => {
  it('counts each operator avoiding a known dead end once, and estimates conservatively, labelled as an estimate', async () => {
    const { author, b, c } = await world();
    const n = networkSavings(author.node.store);
    expect(n.avoided).toBe(2);
    expect(n.by_kind).toEqual({ used_failure: 1, used_fix: 0, fix_worked: 1 });
    expect(n.tokens).toBe(2 * SAVED_PER_AVOIDED.tokens);
    expect(n.minutes).toBe(2 * SAVED_PER_AVOIDED.minutes);
    expect(n.estimate).toBe(true);
    expect(n.basis).toMatch(/^Estimate: .*deliberately low/);
    expect(n.line).toBe('2 dead ends avoided: about 10 minutes and 4,000 tokens saved (estimate)');
    expect(operatorSavings(author.node.store, author.node.operatorId).for_others.avoided).toBe(2);
    expect(operatorSavings(author.node.store, b.node.operatorId).for_them.avoided).toBe(1);
    expect(operatorSavings(author.node.store, c.node.operatorId).for_others.avoided).toBe(0);
  });

  it('metrics_get reports it; this computer\'s own agents are counted locally and never published', async () => {
    const { author } = await world();
    const home = mkdtempSync(join(tmpdir(), 'saved-'));
    const log = new ActivityLog(join(home, 'agent-activity.jsonl'));
    log.record('claude-code', 'failures_search', { results: [{ id: 'a'.repeat(64) }] });
    log.record('claude-code', 'answers_lookup', { results: [] });
    expect(localSavings(log)).toMatchObject({ lookups: 2, found_something: 1, scope: 'this computer only; never published' });
    const m = author.metrics.report();
    expect(m.saved.network.avoided).toBe(2);
    expect(m.saved.this_computer.scope).toMatch(/never published/);
    // Nothing about local behaviour became a record.
    expect(author.node.store.all().some((s) => JSON.stringify(s.rec.body).includes('found_something'))).toBe(false);
  });

  it('the home page and a profile show it, as an estimate', async () => {
    const { author } = await world();
    const web = new WebServer(author);
    registerAppRoutes(web);
    await web.listen(0);
    const { chromium } = createRequire(import.meta.url)('playwright');
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      const errors: string[] = [];
      page.on('pageerror', (e: Error) => errors.push(String(e)));
      await page.goto(web.url);
      await page.waitForFunction(() => document.querySelector('#live-stats')?.textContent?.includes('avoided'));
      expect(await page.textContent('#live-stats')).toMatch(/2 dead ends avoided \(about 10 minutes, 4,000 tokens saved, estimate\)/);
      await page.goto(`${web.url}/#/me/${author.node.operatorId}`);
      await page.waitForFunction(() => document.body.textContent?.includes('others avoided'));
      expect(await page.textContent('body')).toMatch(/2dead ends others avoided thanks to (you|these lessons) \(about 10 min, 4,000 tokens, estimate\)/);
      expect(errors).toEqual([]);
    } finally { await browser.close(); await web.close(); }
  }, 60_000);
});
