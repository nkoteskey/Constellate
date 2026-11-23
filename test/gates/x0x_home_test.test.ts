import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { Hub } from '../../src/hub/hub.js';
import { LocalSigner } from '../../src/core/identity.js';
import { signRecord } from '../../src/core/record.js';
import { RecordStore } from '../../src/store/records.js';
import { probes, runSession, summarize, TEST_ID, TEST_TOPIC, type Snapshot } from '../../src/x0x/home-test.js';
import { compare, summary } from '../../src/work/measurement.js';
import type { X0xClient, GossipMessage } from '../../src/x0x/client.js';
import { WebServer } from '../../src/web/server.js';
import { registerAppRoutes } from '../../src/web/app.js';

/**
 * The x0x home test (docs/X0X_HOME_TEST.md): a session reads x0xd's diagnostics on this computer, which carry IP
 * addresses and peer ids, and reduces them to numbers and one category before anything is shown or sent.
 * Propagation is timed with echoes on this computer's own clock. Results count only with enough computers in both
 * arms in the same hours.
 */
const IP = ['203', '0', '113', '7'].join('.'); // a documentation address, assembled so this file carries none
const PEER = 'ab'.repeat(32);
const fixtures = (t: number) => ({
  '/health': { ok: true, peers: 6, send_ready_peers: 5 },
  '/peers': { ok: true, peers: [{ id: PEER, link: 'healthy' }, { id: 'cd'.repeat(32), link: 'healthy' }, { id: 'ef'.repeat(32), link: t % 2 ? 'degraded' : 'healthy' }, { id: '01'.repeat(32), link: 'healthy' }] },
  '/network/status': { ok: true, local_addr: `${IP}:5483`, external_addrs: [`${IP}:5483`], nat_type: 'PortRestricted', connected_peers: 4, direct_connections: 3, relayed_connections: 1, hole_punch_success_rate: 0.75, avg_rtt_ms: 40 + t },
  '/diagnostics/transport': { churn: { generations_replaced: 10 + t, peer: PEER } },
  '/diagnostics/gossip': { stats: { publish_total: 100 + 10 * t, delivered_to_subscriber: 100 + 9 * t, eager_duplicate_dropped_pre_verify: 5 * t }, pubsub_stages: { verify: { total_ns: 2e6 * t } }, dispatcher: { inbound: { over_100ms_count: t } } },
  '/status': { addrs: [IP], bandwidth: { up_bps: { total: 1000 + t, gossip: 800, direct: 100, relay: 50, other: 50 }, down_bps: { total: 2000, gossip: 1500, direct: 300, relay: 100, other: 100 } } },
});

/** Two fake x0xd daemons on one gossip topic, plus diagnostics that advance with each read. */
function fakeMesh() {
  const subs: ((m: GossipMessage) => void)[] = [];
  const make = (): X0xClient => {
    let reads = 0;
    return {
      getJson: async (p: string) => (fixtures(Math.floor(reads++ / 6)) as Record<string, unknown>)[p.split('?')[0]],
      subscribe: async () => 'sub',
      events: (cb: (m: GossipMessage) => void) => { subs.push(cb); return () => { subs.splice(subs.indexOf(cb), 1); }; },
      publish: async (topic: string, payload: Uint8Array) => { for (const cb of [...subs]) setTimeout(() => cb({ topic, payload, sender: 'x', verified: true }), 2); return { ok: true as const }; },
    } as unknown as X0xClient;
  };
  return { make };
}

describe('the x0x home test', () => {
  it('reduces x0xd’s diagnostics to numbers and one category: no addresses, no ids', () => {
    const snaps: Snapshot[] = [0, 1, 2, 3].map((t) => ({ at: t * 600_000, phase: t === 1 || t === 2 ? 'active' : 'idle', raw: fixtures(t) }));
    const r = summarize(snaps, { sent: 10, rtts_ms: [30, 50, 40], echoes: 20, cohort: 3 }, { minutes: 30, now: new Date('2026-11-22T14:25:00Z') });
    const text = JSON.stringify(r);
    expect(text).not.toContain(IP);
    expect(text).not.toMatch(/[0-9a-f]{16}/);
    expect(r).toMatchObject({ test: TEST_ID, arm: 'baseline', nat_type: 'PortRestricted', cohort_hour: '2026-11-22T14:00Z' });
    expect(r.metrics).toMatchObject({ peers_median: 4, direct_share_median: 0.75, hole_punch_success_rate: 0.75, echo_rtt_ms_median: 40, echoes_per_probe: 2, cohort_seen: 3, idle_down_bps_median: 2000 });
    expect(r.metrics.reconnections_per_hour).toBe(6); // 3 more in half an hour
    expect(r.metrics.delivered_per_published).toBe(0.9);
    expect(Object.values(r.metrics).every((v) => typeof v === 'number')).toBe(true);
    expect(summarize(snaps, { sent: 0, rtts_ms: [], echoes: 0, cohort: 0 }, { minutes: 30, arm: 'eager degree 3!' }).arm).toBe('eagerdegree3');
  });

  it('times propagation with echoes on its own clock, using random session ids', async () => {
    const mesh = fakeMesh();
    const a = probes(mesh.make()), b = probes(mesh.make());
    const stopA = await a.start(), stopB = await b.start();
    a.setActive(true);
    for (let i = 0; i < 3; i++) await a.probe();
    await new Promise((r) => setTimeout(r, 40));
    stopA(); stopB();
    expect(a.result()).toMatchObject({ sent: 3, echoes: 3, cohort: 1 });
    expect(a.result().rtts_ms).toHaveLength(3);
    expect(b.result().sent).toBe(0); // idle sessions answer but don't probe
    expect(a.session).toMatch(/^[0-9a-f]{12}$/);
    expect(a.session).not.toBe(b.session);
  });

  it('a whole session, idle then active then idle, returns a report and publishes nothing', async () => {
    const mesh = fakeMesh();
    const phases: string[] = [];
    const echoer = probes(mesh.make()); const stop = await echoer.start();
    const r = await runSession(mesh.make(), { minutes: 3, sampleSeconds: 30, probeSeconds: 10, sleep: () => new Promise((res) => setTimeout(res, 5)) }, (p) => phases.push(p.phase));
    stop();
    expect(phases[0]).toBe('idle');
    expect(phases).toContain('active');
    expect(phases.at(-1)).toBe('idle');
    expect(r.metrics.probes_sent).toBeGreaterThan(0);
    expect(r.metrics.echoes_per_probe).toBeGreaterThan(0);
  });

  it('a measured result needs enough computers in both arms in the same hours; otherwise it says so', async () => {
    const store = new RecordStore();
    const add = async (arm: string, hour: string, up: number) => store.add(await signRecord({ kind: 'measurement', context: { task: 'x0x home test', domain: ['tech_infrastructure'], environment: 'linux, NAT Symmetric' }, body: { test: TEST_ID, minutes: 15, arm, os: 'linux', cohort_hour: hour, nat_type: 'Symmetric', metrics: { idle_up_bps_median: up } } }, LocalSigner.generate()));
    for (let i = 0; i < 4; i++) { await add('baseline', '2026-11-22T14:00Z', 9000 + i * 100); await add('eager3', '2026-11-22T14:00Z', 6000 + i * 100); }
    await add('eager3', '2026-11-23T09:00Z', 1); // an hour with no baseline: left out
    let c = compare(store.all(), TEST_ID, 'eager3', 'idle_up_bps_median');
    expect(c).toMatchObject({ status: 'not_enough', hours: 1 });
    expect(c.detail).toMatch(/needs 5 computers in each arm in the same hours; has 4 and 4/);
    await add('baseline', '2026-11-22T14:00Z', 9500); await add('eager3', '2026-11-22T14:00Z', 6500);
    c = compare(store.all(), TEST_ID, 'eager3', 'idle_up_bps_median');
    expect(c).toMatchObject({ status: 'measured', separated: true, hours: 1 });
    expect(c.changed!.median).toBe(6200);
    expect(c.detail).toMatch(/median 9200\.00 → 6200\.00 -33%/);
    const s = summary(store.all(), TEST_ID);
    expect(s).toMatchObject({ computers: 11, nat_types: { Symmetric: 11 } });
    // A malformed or text-stuffed report is ignored.
    store.add(await signRecord({ kind: 'measurement', context: { task: 'x', domain: ['x0x'], environment: '' }, body: { test: TEST_ID, minutes: 15, arm: 'baseline', os: 'linux', cohort_hour: '2026-11-22T14:00Z', nat_type: 'x', metrics: { note: 'see my notes' } } }, LocalSigner.generate()));
    expect(summary(store.all(), TEST_ID).computers).toBe(11);
  });

  it('in the app: start, see the numbers, send only on request; results are public aggregates', async () => {
    const mesh = fakeMesh();
    const echoer = probes(mesh.make()); const stopEcho = await echoer.start();
    const hub = new Hub({ signer: LocalSigner.generate(), preview: false, x0x: mesh.make() } as ConstructorParameters<typeof Hub>[0]);
    const web = new WebServer(hub); registerAppRoutes(web); await web.listen(0);
    const { chromium } = createRequire(import.meta.url)('playwright');
    const browser = await chromium.launch();
    try {
      expect(await (await fetch(`${web.url}/api/x0x-test`)).json()).toMatchObject({ running: false, x0x: true });
      expect((await fetch(`${web.url}/api/x0x-test/send`, { method: 'POST' })).status).toBe(409); // nothing to send yet
      const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
      const errors: string[] = [];
      page.on('pageerror', (e: Error) => errors.push(String(e)));
      await page.goto(`${web.url}/#/compute`);
      await page.waitForSelector('#x0x-test');
      expect(await page.textContent('#x0x-test')).toMatch(/Help test x0x.*only numbers are sent: never your address or IDs/s);
      expect(await page.isVisible('#xt-start')).toBe(true);
      expect(errors).toEqual([]);
      expect(hub.node.store.ofKind('measurement')).toHaveLength(0);
    } finally { await browser.close(); await web.close(); stopEcho(); }
  }, 60_000);
});
