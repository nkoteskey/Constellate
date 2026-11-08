import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Hub } from '../../src/hub/hub.js';
import { LocalSigner } from '../../src/core/identity.js';
import { MockRunner } from '../../src/contributor/models.js';
import { decide } from '../../src/contributor/device.js';
import { Lend, LEND_DEFAULTS, cleanLimits, policyFor, nightOf, restAfter } from '../../src/contributor/lend.js';
import { Worker } from '../../src/work/worker.js';
import { MemoryBoard } from '../../src/work/board.js';
import { WebServer } from '../../src/web/server.js';
import { registerAppRoutes } from '../../src/web/app.js';

/**
 * Lend a computer in one click (docs/DESKTOP.md "Lend this computer"): off by default; limits for hours per night,
 * never on battery and a CPU cap; a visible log of what ran; the hours pledged with compute_pledge.
 */
const root = join(import.meta.dirname, '../..');

describe('lending this computer', () => {
  it('is off by default, and the defaults are polite', () => {
    expect(readFileSync(join(root, 'desktop/main.mjs'), 'utf8')).toMatch(/const DEFAULTS = \{ contribute: false,/);
    expect(LEND_DEFAULTS).toEqual({ nightStart: 23, hoursPerNight: 6, neverOnBattery: true, cpuCapPct: 50 });
    expect(cleanLimits({ nightStart: 30, hoursPerNight: 0, cpuCapPct: 5 })).toEqual({ nightStart: 23, hoursPerNight: 1, neverOnBattery: true, cpuCapPct: 10 });
  });

  it('the limits mean: the night window, never on battery, and a CPU cap', () => {
    const p = policyFor({ nightStart: 23, hoursPerNight: 6, neverOnBattery: true, cpuCapPct: 50 });
    expect(p.hours).toEqual([23, 5]);
    const idle = 0, plugged = { onAC: true, batteryPct: null }, battery = { onAC: false, batteryPct: 100 };
    expect(decide(p, plugged, idle, 0).state).toBe('contributing');
    expect(decide(p, battery, idle, 0).message).toBe('Paused: plug in to keep contributing.'); // even fully charged
    expect(decide(p, plugged, idle, 14).state).toBe('waiting'); // outside the night window
    expect(nightOf(new Date(2026, 10, 9, 2), 23)).toBe('2026-11-08'); // 2am belongs to last night
    expect(nightOf(new Date(2026, 10, 9, 23, 30), 23)).toBe('2026-11-09');
    expect(restAfter(1000, 50)).toBe(1000);
    expect(restAfter(1000, 25)).toBe(3000);
    expect(restAfter(1000, 100)).toBe(0);
  });

  it('keeps the limits, tonight\'s hours and a log of what ran, in files the app and the lending process share', () => {
    const lend = new Lend(mkdtempSync(join(tmpdir(), 'lend-')));
    expect(lend.limits()).toEqual(LEND_DEFAULTS);
    expect(lend.setLimits({ hoursPerNight: 2 })).toMatchObject({ hoursPerNight: 2, nightStart: 23 });
    const now = new Date(2026, 10, 9, 1);
    lend.addUsage(3600, now);
    expect(lend.underTonight(now)).toBe(true);
    lend.addUsage(3600, now);
    expect(lend.underTonight(now)).toBe(false); // two hours used: done for tonight
    expect(lend.underTonight(new Date(2026, 10, 9, 23, 5))).toBe(true); // a new night
    lend.record({ at: '2026-11-09T01:00:00Z', problem: 'a'.repeat(64), title: 'P', step: 'one', did: 'worked', outcome: 'worked', model: 'm', seconds: 4 });
    lend.record({ at: '2026-11-09T01:01:00Z', problem: 'a'.repeat(64), title: 'P', step: 'two', did: 'checked', outcome: 'verified', model: 'm', seconds: 1 });
    expect(lend.recent().map((e) => e.step)).toEqual(['two', 'one']);
  });

  it('a worker says what each step was, for the log', async () => {
    const hub = new Hub({ signer: LocalSigner.generate(), preview: false });
    const { record } = await hub.problems.propose({ title: 'Toy sums', goal: 'Sum squares', realm: 'maths_physics', definition_of_done: { verifier: 'sum_squares_mod', description: 'recomputed' }, chunks: [{ key: 'c1', title: 'Sum 1..10 mod 7', prompt: 'sum', check: { from: 1, to: 10, mod: 7 } }] }, { publish: true });
    const w = new Worker(hub, new MockRunner('mock:qwen', 'qwen', 'small', () => '0'), hub.problems, new MemoryBoard());
    expect(await w.step(record.id)).toBe('worked');
    expect(w.last).toEqual({ problem: record.id, title: 'Toy sums', step: 'Sum 1..10 mod 7', did: 'worked', model: 'mock:qwen' });
  });

  it('turning it on pledges the hours (compute_pledge); turning it off pledges zero', async () => {
    const src = readFileSync(join(root, 'src/cli.ts'), 'utf8');
    expect(src).toMatch(/hub\.collective\.pledge\(hours\)/);
    expect(src).toMatch(/hub\.collective\.pledge\(0\)/);
    expect(readFileSync(join(root, 'desktop/main.mjs'), 'utf8')).toMatch(/args: \['contribute', '--lend',/);
    const hub = new Hub({ signer: LocalSigner.generate(), preview: false });
    await hub.collective.pledge(6 * 7);
    expect(hub.collective.pledged(hub.node.operatorId)).toBe(42);
  });

  it('the app shows one switch, the limits and what ran, and saves a limit when it changes', async () => {
    const lend = new Lend(mkdtempSync(join(tmpdir(), 'lend-ui-')));
    lend.record({ at: new Date().toISOString(), problem: 'b'.repeat(64), title: 'Re-check a proof', step: 'Rebuild the main theorem', did: 'checked', outcome: 'verified', model: 'machine check (lean_project)', seconds: 12.5 });
    const hub = new Hub({ signer: LocalSigner.generate(), preview: false });
    const web = new WebServer(hub);
    registerAppRoutes(web);
    await web.listen(0);
    const { chromium } = createRequire(import.meta.url)('playwright');
    const browser = await chromium.launch();
    let contributeCalls: boolean[] = [];
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
      const errors: string[] = [];
      page.on('pageerror', (e: Error) => errors.push(String(e)));
      await page.exposeFunction('__lendLimits', (patch: unknown) => (patch ? lend.setLimits(patch as never) : lend.limits()));
      await page.exposeFunction('__lendLog', () => ({ log: lend.recent(30), used_tonight_seconds: Math.round(lend.usedTonight()), limits: lend.limits() }));
      await page.exposeFunction('__contribute', (on: boolean) => { contributeCalls.push(on); return { ok: true }; });
      // The desktop app's bridge (desktop/preload.cjs), standing in for Electron.
      await page.addInitScript(() => {
        const w = window as unknown as Record<string, any>;
        let on = false;
        w.constellateDesktop = {
          status: async () => ({ settings: { contribute: on, openAtLogin: false, model: null }, x0x: { state: 'online', peers: 3 }, ollama: { running: true, models: [] }, contribute: null, suggestion: { primary: { name: 'Llama 3.3 70B', run: { provider: 'groq', model: 'llama-3.3-70b-versatile' } }, notes: [] }, agents: {} }),
          contribute: async (v: boolean) => { on = v; return w.__contribute(v); },
          lendLimits: (patch?: unknown) => w.__lendLimits(patch ?? null),
          lendLog: () => w.__lendLog(),
          openAtLogin: async () => false,
        };
      });
      await page.goto(`${web.url}/#/compute`);
      await page.waitForSelector('#dk-limits');
      const card = await page.textContent('#dk-limits')!.then(() => page.evaluate(() => document.querySelector('#dk-limits')!.closest('.card')!.textContent));
      expect(card).toContain('Off until you start it');
      expect(card).toContain('Never on battery');
      expect(card).toMatch(/From 23:00 to 05:00, only while idle and plugged in, using at most 50% of the time/);
      expect(card).toContain('Pledged to the network as 42 hours a week');
      expect(card).toMatch(/Checked Re-check a proof · Rebuild the main theorem/);

      await page.selectOption('#lim-hours', '4');
      await page.waitForFunction(() => document.querySelector('#dk-limits')?.closest('.card')?.textContent?.includes('to 03:00'));
      expect(lend.limits().hoursPerNight).toBe(4); // saved where the lending process reads it
      await page.selectOption('#lim-cpu', '25');
      await page.waitForFunction(() => document.querySelector('#dk-limits')?.closest('.card')?.textContent?.includes('at most 25%'));
      expect(lend.limits().cpuCapPct).toBe(25);

      await page.click('#dk-toggle'); // the one click
      await page.waitForFunction(() => document.querySelector('#dk-toggle')?.textContent === 'Stop lending');
      expect(contributeCalls).toEqual([true]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
      expect(errors).toEqual([]);
    } finally { await browser.close(); await web.close(); contributeCalls = []; }
  }, 60_000);
});
