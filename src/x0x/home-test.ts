import { randomBytes } from 'node:crypto';
import type { Hub } from '../hub/hub.js';
import type { X0xClient, GossipMessage } from './client.js';

/**
 * The x0x home test (docs/X0X_HOME_TEST.md): a short session on this computer that measures how x0x behaves on a
 * real home connection, and reduces it to numbers and categories before anything is shown or sent.
 *
 * x0xd's own endpoints carry IP addresses and peer ids, so they are read here and never uploaded. `summarize`
 * builds the report field by field from numbers (and the NAT type as one of a fixed list), so nothing else can slip
 * into it. The person sees the exact report first (`preview`) and nothing is published until they say yes.
 *
 * Propagation is measured with echoes on a test topic: this computer publishes small probes, other computers in
 * the test answer each one, and the round trip is timed on this computer's own clock, so clocks needn't agree.
 */
export const TEST_ID = 'x0x-home-v1';
export const TEST_TOPIC = 'constellate.x0x-home-test.v1';
const NAT = ['FullCone', 'RestrictedCone', 'PortRestricted', 'Symmetric', 'None', 'Unknown'];

export interface Snapshot { at: number; phase: 'idle' | 'active'; raw: Record<string, unknown> }
export interface Report {
  test: string; minutes: number; arm: string; os: string; cohort_hour: string;
  nat_type: string;
  metrics: Record<string, number>;
}

type Get = (path: string) => Promise<unknown>;

/** The first numeric value under `key` anywhere in a JSON value (x0xd's shapes vary by version). */
export function findNum(v: unknown, key: string): number | null {
  if (!v || typeof v !== 'object') return null;
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (k === key && typeof x === 'number' && Number.isFinite(x)) return x;
  for (const x of Object.values(v as Record<string, unknown>)) { const n = findNum(x, key); if (n !== null) return n; }
  return null;
}
/** The sum of every numeric `key` found under an object whose own key matches `under`. */
export function sumUnder(v: unknown, under: RegExp, key: string, inside = false): number {
  if (!v || typeof v !== 'object') return 0;
  let s = 0;
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (k === key && inside && typeof x === 'number') s += x;
    else if (x && typeof x === 'object') s += sumUnder(x, under, key, inside || under.test(k));
  }
  return s;
}

const ENDPOINTS = ['/health', '/peers', '/network/status', '/diagnostics/transport', '/diagnostics/gossip', '/status'];

/** One reading of every endpoint, kept on this computer only. */
export async function snapshot(get: Get, phase: Snapshot['phase']): Promise<Snapshot> {
  const raw: Record<string, unknown> = {};
  for (const e of ENDPOINTS) raw[e] = await get(e).catch(() => null);
  return { at: Date.now(), phase, raw };
}

const median = (xs: number[]) => { const s = xs.filter(Number.isFinite).sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN; };
const round = (x: number, d = 3) => Math.round(x * 10 ** d) / 10 ** d;

/** Numbers and one category, built field by field: never an address, an id or any other text from x0xd. */
export function summarize(snaps: Snapshot[], probes: { sent: number; rtts_ms: number[]; echoes: number; cohort: number }, meta: { arm?: string; minutes: number; now?: Date }): Report {
  const m: Record<string, number> = {};
  const put = (k: string, x: number) => { if (Number.isFinite(x)) m[k] = round(x); };
  const at = (e: string) => snaps.map((s) => s.raw[e]);
  const peersList = at('/peers').map((p) => (p && typeof p === 'object' && Array.isArray((p as { peers?: unknown[] }).peers) ? (p as { peers: { link?: string }[] }).peers : null)).filter((x): x is { link?: string }[] => !!x);
  put('peers_median', median(peersList.map((l) => l.length)));
  put('peers_min', peersList.length ? Math.min(...peersList.map((l) => l.length)) : NaN);
  put('degraded_share_median', median(peersList.map((l) => (l.length ? l.filter((p) => p.link === 'degraded').length / l.length : 0))));
  const net = at('/network/status');
  put('direct_share_median', median(net.map((n) => { const c = findNum(n, 'connected_peers'), d = findNum(n, 'direct_connections'); return c ? (d ?? NaN) / c : NaN; })));
  put('relayed_connections_median', median(net.map((n) => findNum(n, 'relayed_connections') ?? NaN)));
  put('hole_punch_success_rate', median(net.map((n) => findNum(n, 'hole_punch_success_rate') ?? NaN)));
  put('avg_rtt_ms_median', median(net.map((n) => findNum(n, 'avg_rtt_ms') ?? NaN)));
  const natRaw = net.map((n) => (n && typeof n === 'object' ? String((n as { nat_type?: unknown }).nat_type ?? '') : '')).find(Boolean) ?? '';
  const nat = NAT.find((x) => natRaw.toLowerCase().replace(/[^a-z]/g, '') === x.toLowerCase()) ?? (natRaw ? 'Other' : 'Unknown');

  // Counters: the change over the session, per hour or per minute.
  const first = snaps[0], last = snaps.at(-1);
  const hours = first && last ? Math.max(1e-6, (last.at - first.at) / 3_600_000) : NaN;
  const delta = (e: string, key: string) => (first && last ? (findNum(last.raw[e], key) ?? NaN) - (findNum(first.raw[e], key) ?? NaN) : NaN);
  put('reconnections_per_hour', delta('/diagnostics/transport', 'generations_replaced') / hours);
  const pub = delta('/diagnostics/gossip', 'publish_total'), del = delta('/diagnostics/gossip', 'delivered_to_subscriber');
  if (pub > 0) put('delivered_per_published', del / pub);
  put('duplicates_dropped_per_minute', delta('/diagnostics/gossip', 'eager_duplicate_dropped_pre_verify') / (hours * 60));
  if (first && last) {
    put('verify_ms_per_minute', (sumUnder(last.raw['/diagnostics/gossip'], /verify/i, 'total_ns') - sumUnder(first.raw['/diagnostics/gossip'], /verify/i, 'total_ns')) / 1e6 / (hours * 60));
    put('slow_dispatch_per_hour', (sumUnder(last.raw['/diagnostics/gossip'], /dispatch/i, 'over_100ms_count') - sumUnder(first.raw['/diagnostics/gossip'], /dispatch/i, 'over_100ms_count')) / hours);
  }
  // Bandwidth from x0xd's rolling 60 s rates, by phase.
  for (const phase of ['idle', 'active'] as const) {
    const st = snaps.filter((s) => s.phase === phase).map((s) => (s.raw['/status'] as { bandwidth?: { up_bps?: Record<string, number>; down_bps?: Record<string, number> } } | null)?.bandwidth);
    put(`${phase}_up_bps_median`, median(st.map((b) => b?.up_bps?.total ?? NaN)));
    put(`${phase}_down_bps_median`, median(st.map((b) => b?.down_bps?.total ?? NaN)));
    put(`${phase}_up_gossip_bps_median`, median(st.map((b) => b?.up_bps?.gossip ?? NaN)));
  }
  // Propagation, from echoes timed on this computer's clock.
  put('probes_sent', probes.sent);
  put('echo_rtt_ms_median', median(probes.rtts_ms));
  put('echoes_per_probe', probes.sent ? probes.echoes / probes.sent : NaN);
  put('cohort_seen', probes.cohort);
  const now = meta.now ?? new Date();
  return { test: TEST_ID, minutes: meta.minutes, arm: (meta.arm ?? 'baseline').replace(/[^\w.-]/g, '').slice(0, 40) || 'baseline', os: process.platform, cohort_hour: `${now.toISOString().slice(0, 13)}:00Z`, nat_type: nat, metrics: m };
}

/** Echo probes on the test topic. Session ids are random per session: never an agent or machine id. */
export function probes(x0x: Pick<X0xClient, 'publish' | 'subscribe' | 'events'>) {
  const session = randomBytes(6).toString('hex');
  const sent = new Map<string, number>(), answered = new Set<string>(), rtts: number[] = [], senders = new Set<string>();
  let echoes = 0, n = 0, active = false;
  const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
  const onMessage = (msg: GossipMessage) => {
    if (msg.topic !== TEST_TOPIC) return;
    let j: { s?: string; probe?: string; echo?: string; to?: string };
    try { j = JSON.parse(new TextDecoder().decode(msg.payload)); } catch { return; }
    if (!j.s || j.s === session) return;
    senders.add(j.s);
    if (j.probe) void x0x.publish(TEST_TOPIC, enc({ s: session, echo: j.probe, to: j.s })).catch(() => {}); // answer every probe, even when idle
    if (j.echo && j.to === session && sent.has(j.echo)) {
      echoes++;
      if (!answered.has(j.echo)) { answered.add(j.echo); rtts.push(Date.now() - sent.get(j.echo)!); } // the first echo is the round trip
    }
  };
  return {
    async start() { await x0x.subscribe(TEST_TOPIC); return x0x.events(onMessage); },
    async probe() { if (!active) return; const id = `${session}-${n++}`; sent.set(id, Date.now()); await x0x.publish(TEST_TOPIC, enc({ s: session, probe: id })).catch(() => {}); },
    setActive(a: boolean) { active = a; },
    /** Round trips (first echo of each probe), all echoes (reach), and how many other sessions were heard. */
    result() { return { sent: n, rtts_ms: rtts, echoes, cohort: senders.size }; },
    onMessage, session,
  };
}

export interface SessionOpts { minutes?: number; arm?: string; sampleSeconds?: number; probeSeconds?: number; sleep?: (ms: number) => Promise<void> }

/** A session: a third idle, a third sending probes, a third idle. Returns the report; publishes nothing. */
export async function runSession(x0x: X0xClient, o: SessionOpts = {}, onProgress?: (p: { phase: string; done: number }) => void): Promise<Report> {
  const minutes = Math.max(1, Math.min(60, o.minutes ?? 15));
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const get: Get = (p) => x0x.getJson(p);
  const pr = probes(x0x);
  const stop = await pr.start();
  const snaps: Snapshot[] = [];
  const total = minutes * 60_000, step = (o.sampleSeconds ?? 30) * 1000, probeEvery = (o.probeSeconds ?? 5) * 1000;
  try {
    for (let t = 0; t <= total; t += step) {
      const phase = t >= total / 3 && t < (2 * total) / 3 ? 'active' : 'idle';
      pr.setActive(phase === 'active');
      snaps.push(await snapshot(get, phase));
      onProgress?.({ phase, done: t / total });
      if (t + step > total) break;
      for (let s = 0; s < step; s += probeEvery) { await pr.probe(); await sleep(Math.min(probeEvery, step - s)); }
    }
  } finally { stop(); }
  const r = pr.result();
  return summarize(snaps, r, { arm: o.arm, minutes });
}

/** Publish a report the person approved, as a signed measurement record. */
export async function publishReport(hub: Hub, report: Report, problem?: string) {
  const { record } = await hub.node.submit({ kind: 'measurement', context: { task: `x0x home test (${report.arm})`, domain: ['tech_infrastructure', 'x0x'], environment: `${report.os}, NAT ${report.nat_type}` }, body: report as unknown as Record<string, unknown>, refs: problem ? [problem] : [] }, { publish: true });
  return record.id;
}
