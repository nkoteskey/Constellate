import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, request, type Server } from 'node:http';
import { Hub } from '../../src/hub/hub.js';
import { FakeMesh, FakeDaemon } from '../../src/x0x/fake.js';
import { WebServer } from '../../src/web/server.js';
import { registerAppRoutes } from '../../src/web/app.js';
import { swr } from '../../src/web/swr.js';

/**
 * Navigation stays fast when the x0x daemon is slow: pages show as soon as they're drawn, the routes that wait on
 * x0x answer from their last result and refresh in the background (src/web/swr.ts), and a slow request left over
 * from one page never holds up the next (js/ui.js counts requests per page).
 */
const DELAY = 600;

describe('navigation speed', () => {
  it('swr answers from the last result at once, refreshes in the background, and falls back on a slow first call', async () => {
    let n = 0, wait = 0;
    const get = swr(async () => { await new Promise((r) => setTimeout(r, wait)); return ++n; }, { maxAgeMs: 0, firstWaitMs: 50, fallback: () => -1 });
    expect(await get()).toBe(1);
    wait = 200;
    const t = Date.now();
    expect(await get()).toBe(1); // stale, answered at once, refresh started
    expect(Date.now() - t).toBeLessThan(50);
    await new Promise((r) => setTimeout(r, 500));
    expect(await get()).toBeGreaterThanOrEqual(2);
    get.clear();
    expect(await get()).toBe(-1); // first call slower than firstWaitMs: the fallback
  });

  it('every page shows quickly even when x0x answers slowly', async () => {
    const d = await new FakeDaemon(new FakeMesh(), 'me').start();
    // x0x that takes DELAY ms to answer anything (its event stream excepted).
    const proxy: Server = createServer((req, res) => {
      const u = new URL(d.url);
      setTimeout(() => { const r = request({ host: u.hostname, port: u.port, path: req.url, method: req.method, headers: req.headers }, (up) => { res.writeHead(up.statusCode ?? 500, up.headers); up.pipe(res); }); req.pipe(r); }, req.url?.includes('/events') ? 0 : DELAY);
    });
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', () => r()));
    const hub = await Hub.fromEnv({ ...process.env, CONSTELLATE_HOME: mkdtempSync(join(tmpdir(), 'nav-')), X0X_API: `http://127.0.0.1:${(proxy.address() as { port: number }).port}`, X0X_TOKEN: d.token, CONSTELLATE_QUIET: '1', CONSTELLATE_PREVIEW: 'off' });
    expect(hub.x0x).toBeTruthy();
    const web = new WebServer(hub);
    registerAppRoutes(web);
    await web.listen(0);
    const { chromium } = createRequire(import.meta.url)('playwright');
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
      const errors: string[] = [];
      page.on('pageerror', (e: Error) => errors.push(`${e} ${e.stack?.split('\n')[1] ?? ''}`));
      await page.goto(web.url);
      await page.waitForSelector('#seek-q');
      const times: Record<string, number> = {};
      // People asks x0x twice (the directory and its groups); Me comes straight after, while those may still be running.
      for (const r of ['#/people', '#/me', '#/list', '#/people', '#/deliberations', '#/compute']) {
        const t0 = Date.now();
        await page.evaluate((h: string) => { location.hash = h; }, r);
        await page.waitForFunction(() => { const p = document.querySelector('#page'); return !!p && !p.hidden && !p.classList.contains('leaving') && (p.textContent?.trim().length ?? 0) > 40; }, undefined, { timeout: 10_000 });
        times[`${r} (${Object.keys(times).length})`] = Date.now() - t0;
      }
      for (const [r, ms] of Object.entries(times)) expect(ms, `${r} took ${ms} ms`).toBeLessThan(400);
      expect(errors).toEqual([]);
    } finally { await browser.close(); await web.close(); await hub.close(); proxy.close(); }
  }, 60_000);
});
