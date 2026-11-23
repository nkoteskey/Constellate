import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Hub } from '../../src/hub/hub.js';
import { LocalSigner } from '../../src/core/identity.js';
import { signRecord } from '../../src/core/record.js';
import { RecordStore } from '../../src/store/records.js';
import type { Verifier } from '../../src/work/verifiers.js';
import { Announcer } from '../../src/announce/announce.js';
import { WebServer } from '../../src/web/server.js';
import { registerAppRoutes } from '../../src/web/app.js';

/**
 * The announcer in the app (#29, docs/ANNOUNCE.md): the outbox with each item's tier and what it waits for, Approve
 * and Skip, the dry run, the X link, and Send, with the terminal's rules. A gate drives approve then send against
 * stand-in Bluesky and Mastodon servers.
 */
const stub: Verifier = { name: 'stub_proof', async check(_s, out) { return { ok: out.trim() === 'proved', detail: '' }; } };
const worker = LocalSigner.generate(), checker = LocalSigner.generate();
const ctx = { task: 'a step', domain: ['maths_physics'], environment: '' };

describe('announcements in the app', () => {
  it('approve, then send, from the app; nothing goes before Send', async () => {
    const home = mkdtempSync(join(tmpdir(), 'announce-ui-'));
    process.env.CONSTELLATE_HOME = home;
    const hub = new Hub({ signer: LocalSigner.generate(), store: new RecordStore(), preview: false });
    hub.problems.verifiers.register(stub);
    new Announcer(hub, home).setConfig({ bluesky: { handle: 'constellate-test.bsky.social' }, mastodon: { instance: 'https://social.example/' } });
    const calls: string[] = [];
    const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } });
    const fetch = async (url: string) => {
      calls.push(url);
      if (url.endsWith('/xrpc/com.atproto.server.createSession')) return json({ accessJwt: 'jwt', refreshJwt: 'r', handle: 'constellate-test.bsky.social', did: 'did:plc:abc' });
      if (url.endsWith('/xrpc/com.atproto.repo.createRecord')) return json({ uri: 'at://did:plc:abc/app.bsky.feed.post/3k', cid: 'c' });
      if (url.endsWith('/api/v1/statuses')) return json({ id: '9', url: 'https://social.example/statuses/9' });
      return new Response('no', { status: 404 });
    };
    const web = new WebServer(hub); registerAppRoutes(web, { announceNet: { fetch, secret: (n) => (n === 'bluesky' ? 'app-pw' : 'token') } }); await web.listen(0);
    const { chromium } = createRequire(import.meta.url)('playwright');
    const browser = await chromium.launch();
    try {
      expect((await (await fetch_(web.url + '/api/announce')).json()).items).toEqual([]); // announcing starts now
      // A checked step after announcing started.
      const p = (await hub.problems.propose({ title: 'Every widget graph has a perfect pairing', goal: 'Settle it.', realm: 'maths_physics', definition_of_done: { verifier: 'stub_proof', description: 'passes' }, chunks: [{ key: 'a', title: 'step a', prompt: 'do it', check: {} }, { key: 'b', title: 'step b', prompt: 'do it', check: {} }] }, { publish: true })).record.id;
      await new Promise((r) => setTimeout(r, 5));
      const res = await signRecord({ kind: 'task_result', context: ctx, body: { problem: p, chunk: 'a', output: 'proved', model: 'm', family: 'llama' }, refs: [p] }, worker);
      hub.node.ingest(res);
      hub.node.ingest(await signRecord({ kind: 'checkpoint', context: ctx, body: { problem: p, chunk: 'a', seq: 1, result: res.id, verifier_model: 'v', verifier_family: 'qwen', machine_check: 'passed' }, refs: [p, res.id] }, checker));

      const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
      const errors: string[] = [];
      page.on('pageerror', (e: Error) => errors.push(String(e)));
      await page.goto(`${web.url}/#/announce`);
      await page.waitForSelector('[data-item]');
      expect(await page.textContent('#announce')).toMatch(/waits for your approval.*has a step checked by machine on Constellate.*No person has reviewed it yet/s);
      expect(await page.isDisabled('#an-send')).toBe(true); // nothing is cleared before approval
      expect(await page.$('[data-item] a[href^="https://x.com"], [data-item] a[href^="https://twitter.com"]')).toBeNull();
      await page.click('[data-approve]');
      await page.waitForSelector('#an-send:not([disabled])');
      expect(await page.textContent('#announce')).toMatch(/→ feed.*→ bluesky.*→ mastodon/s); // the dry run
      expect(await page.$('[data-item] a[href*="intent"]')).not.toBeNull(); // X: a link the owner sends themselves
      expect(calls).toEqual([]); // nothing left this computer yet
      await page.click('#an-send');
      await page.waitForSelector('#an-sent');
      expect(await page.textContent('#an-sent')).toMatch(/Sent to feed.*Sent to bluesky.*Sent to mastodon/s);
      expect(calls.some((c) => c.endsWith('/xrpc/com.atproto.repo.createRecord'))).toBe(true);
      expect(calls.some((c) => c.endsWith('/api/v1/statuses'))).toBe(true);
      expect(readFileSync(join(home, 'announce', 'feed.xml'), 'utf8')).toContain('Every widget graph has a perfect pairing');
      expect(errors).toEqual([]);
    } finally { await browser.close(); await web.close(); delete process.env.CONSTELLATE_HOME; }
  }, 60_000);
});
const fetch_ = (u: string) => fetch(u);
