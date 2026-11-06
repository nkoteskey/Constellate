import { describe, it, expect } from 'vitest';
import { Hub } from '../../src/hub/hub.js';
import { LocalSigner } from '../../src/core/identity.js';
import { signRecord, SignedRecord, Draft } from '../../src/core/record.js';
import { KnowledgeGraph, Bridge } from '../../src/graph/graph.js';
import { Consolidator } from '../../src/graph/consolidate.js';
import { connect } from '../helpers.js';

/**
 * GATE 2 (Amendment 1): in a simulated run, frequently used links outrank unused
 * ones, a planted dead end sinks in ranking, and a cross-realm bridge is
 * detected and emitted.
 */
const DAY = 86_400_000;
const T0 = Date.parse('2026-09-01T00:00:00Z');
const at = (d: number) => new Date(T0 + d * DAY).toISOString();
const ctx = (task: string, domain: string[], environment = 'python 3.13, dateutil 2.9') => ({ task, domain, environment });

describe('GATE 2 — knowledge graph plasticity', () => {
  it('used links strengthen, unused fade, dead ends sink, bridges are emitted', async () => {
    let now = T0;
    const hub = new Hub({ signer: LocalSigner.generate(), preview: false, now: () => now });
    const put = (r: SignedRecord) => expect(hub.node.ingest(r)).not.toBeNull();
    const sign = (d: Draft, s: LocalSigner) => signRecord(d, s);
    const [a1, a2, a3, users] = [LocalSigner.generate(), LocalSigner.generate(), LocalSigner.generate(), Array.from({ length: 6 }, () => LocalSigner.generate())];

    const failure = await sign({ kind: 'failure', context: ctx('parse ISO 8601 durations', ['python', 'dates']), body: { approach: 'datetime.fromisoformat on "P3DT4H"', outcome: 'error', error_summary: 'ValueError: Invalid isoformat string', confidence: 0.9 }, created: at(0) }, a1);
    put(failure);
    // Two answers to the same failure, equally relevant and equally (un)reputed.
    const used = await sign({ kind: 'answer', context: ctx('parse ISO 8601 durations', ['python', 'dates']), body: { question: 'How do I parse ISO 8601 durations like P3DT4H in Python?', answer: 'Use isodate.parse_duration.', proof: { type: 'test', detail: 'pytest passes' } }, refs: [failure.id], created: at(1) }, a2);
    const unused = await sign({ kind: 'answer', context: ctx('parse ISO 8601 durations', ['python', 'dates']), body: { question: 'How do I parse ISO 8601 durations like P3DT4H in Python?', answer: 'Use pendulum.parse for durations.', proof: { type: 'test', detail: 'pytest passes' } }, refs: [failure.id], created: at(1) }, a3);
    put(used); put(unused);
    // A planted dead end: the most keyword-heavy answer of all, which agents keep contradicting under the same conditions.
    const dead = await sign({ kind: 'answer', context: ctx('parse ISO 8601 durations', ['python', 'dates']), body: { question: 'How do I parse ISO 8601 durations P3DT4H in Python parse durations?', answer: 'Parse ISO 8601 durations with a regex: P(\\d+)D', proof: { type: 'test', detail: 'one example passed' } }, refs: [failure.id], created: at(2) }, LocalSigner.generate());
    put(dead);

    // 60 simulated days: agents keep using one answer, ignore the other, and hit the dead end's bugs.
    for (let d = 3; d < 60; d += 3) {
      const u = users[d % users.length];
      put(await sign({ kind: 'use', context: ctx('used a record', ['python']), body: { target: used.id, helpful: true }, refs: [used.id], created: at(d) }, u));
    }
    for (const u of users.slice(0, 4)) put(await sign({ kind: 'contradiction', context: ctx('regex durations', ['python', 'dates']), body: { reason: 'fails on P1Y2M and fractional seconds' }, refs: [dead.id], created: at(10) }, u));
    now = T0 + 60 * DAY;

    const g = hub.graph;
    const edgeUsed = g.edge(KnowledgeGraph.edgeKey(used.id, 'fixes', failure.id))!;
    const edgeUnused = g.edge(KnowledgeGraph.edgeKey(unused.id, 'fixes', failure.id))!;
    expect(edgeUsed.type).toBe('fixes');
    expect(g.weight(edgeUsed)).toBeGreaterThan(g.weight(edgeUnused) * 5); // used strengthens; unused decayed
    expect(g.weight(edgeUnused)).toBeLessThan(1); // fades, but...
    expect(hub.node.store.get(unused.id)).toBeDefined(); // ...nothing is ever deleted

    const { call } = await connect(hub);
    const res = await call('answers_lookup', { question: 'parse ISO 8601 durations P3DT4H in Python', environment: 'python 3.13, dateutil 2.9', limit: 3 });
    const order = res.results.map((r: { id: string }) => r.id);
    expect(order[0]).toBe(used.id);
    expect(order.indexOf(dead.id)).toBe(order.length - 1); // the dead end sinks
    // Association recall: the lookup also returns strongest neighbours.
    expect(res.results[0].neighbours[0].id).toBe(failure.id);
    const fs = await call('failures_search', { query: 'fromisoformat duration ValueError' });
    expect(fs.results[0].neighbours[0].id).toBe(used.id); // the fix you didn't know to ask for

    // Bridges: a maths result starts helping a life-sciences problem.
    const emitted: Bridge[] = [];
    g.onBridge((b) => emitted.push(b));
    const maths = await sign({ kind: 'answer', context: ctx('fast Fourier transform on irregular grids', ['maths_physics']), body: { question: 'Non-uniform FFT?', answer: 'Use NUFFT with Kaiser-Bessel gridding.', proof: { type: 'proof', detail: 'error bound' } }, created: at(55) }, a1);
    const bio = await sign({ kind: 'answer', context: ctx('speed up cryo-EM reconstruction', ['life_sciences']), body: { question: 'Faster cryo-EM?', answer: 'Apply NUFFT gridding to projection data.', proof: { type: 'benchmark', detail: '4x faster' } }, created: at(56) }, a2);
    put(maths); put(bio);
    put(await sign({ kind: 'link', context: ctx('inspiredBy link', ['maths_physics', 'life_sciences']), body: { from: bio.id, to: maths.id, type: 'inspiredBy', note: 'same gridding trick' }, refs: [bio.id, maths.id], created: at(56) }, a3));
    expect(emitted).toHaveLength(0); // one link is not yet a bridge
    const edge = KnowledgeGraph.edgeKey(bio.id, 'inspiredBy', maths.id);
    for (const u of users.slice(0, 3)) put(await sign({ kind: 'use', context: ctx('used link', ['life_sciences']), body: { target: bio.id, edge, helpful: true }, refs: [bio.id], created: at(58) }, u));
    await new Promise((r) => setTimeout(r, 0));
    expect(emitted.map((b) => [b.fromRealm, b.toRealm])).toEqual([['life_sciences', 'maths_physics']]);
    expect(g.bridges()[0].edge).toBe(edge);
    // A listener that attaches later is not told about bridges that already existed (regression: CI run 1).
    const late: Bridge[] = [];
    const g2 = new KnowledgeGraph(hub.node.store, hub.trust, { now: () => now });
    g2.onBridge((b) => late.push(b));
    put(await sign({ kind: 'use', context: ctx('unrelated', ['python']), body: { target: used.id, helpful: true }, refs: [used.id], created: at(59) }, users[0]));
    await new Promise((r) => setTimeout(r, 0));
    expect(late).toEqual([]);

    // JSON-LD node view against the versioned context.
    const ld = g.jsonld(used.id) as Record<string, unknown>;
    expect(ld['@context']).toBe('https://constellate.network/ns/v1');
    expect((ld.fixes as { '@id': string }[])[0]['@id']).toBe(`urn:cst:${failure.id}`);
  }, 120_000);

  it('sleep consolidates a dense cluster into one signed, archived summary, once', async () => {
    const hub = new Hub({ signer: LocalSigner.generate(), preview: false });
    const s = LocalSigner.generate();
    const root = await signRecord({ kind: 'failure', context: ctx('pip install torch on 3.13', ['python']), body: { approach: 'pip install torch==2.1', outcome: 'error', error_summary: 'no wheel', confidence: 0.8 } }, s);
    hub.node.ingest(root);
    for (let i = 0; i < 4; i++) hub.node.ingest(await signRecord({ kind: 'answer', context: ctx('torch wheel', ['python']), body: { question: 'torch on 3.13?', answer: `use torch 2.${5 + i}`, proof: { type: 'test', detail: 'ok' } }, refs: [root.id] }, LocalSigner.generate()));
    const c = new Consolidator(hub);
    expect(await c.sleep()).toEqual({ summarised: 1, skipped: 0 });
    expect(await c.sleep()).toEqual({ summarised: 0, skipped: 1 });
    const sum = hub.node.store.ofKind('summary')[0];
    expect((sum.rec.body as { members: string[] }).members).toHaveLength(5);
    expect(sum.rec.refs).toContain(root.id);
    const key = (sum.rec.body as { cluster: string }).cluster;
    expect(await hub.archive.getPointer(Consolidator.pointerName(key))).toBeTruthy();
  });

  it('sleep distils only lessons, leaves sprawling clusters alone, and its summaries are searchable', async () => {
    const hub = new Hub({ signer: LocalSigner.generate(), preview: false });
    const s = LocalSigner.generate();
    const root = await signRecord({ kind: 'failure', context: ctx('pip install torch on 3.13', ['python']), body: { approach: 'pip install torch==2.1', outcome: 'error', error_summary: 'no wheel for cp313', confidence: 0.8 } }, s);
    hub.node.ingest(root);
    for (let i = 0; i < 3; i++) hub.node.ingest(await signRecord({ kind: 'answer', context: ctx('torch wheel', ['python']), body: { question: 'torch on 3.13?', answer: `use torch 2.${5 + i}`, proof: { type: 'test', detail: 'ok' } }, refs: [root.id] }, LocalSigner.generate()));
    // Votes on the failure are linked to it but are not knowledge.
    for (let i = 0; i < 4; i++) hub.node.ingest(await signRecord({ kind: 'vote', context: ctx('vote', ['python']), body: { choice: 'yes' }, refs: [root.id] }, LocalSigner.generate()));
    // A sprawling chain of 12 failures, each building on the last.
    let prev = '';
    for (let i = 0; i < 12; i++) { const r = await signRecord({ kind: 'failure', context: ctx(`chain ${i}`, ['rust']), body: { approach: `step ${i}`, outcome: 'error', error_summary: 'e', confidence: 0.7 }, refs: prev ? [prev] : [] }, s); hub.node.ingest(r); prev = r.id; }
    const c = new Consolidator(hub, undefined, { maxSize: 10 });
    expect(await c.sleep()).toEqual({ summarised: 1, skipped: 1 });
    const sum = hub.node.store.ofKind('summary')[0];
    const body = sum.rec.body as { title: string; summary: string; members: string[] };
    expect(body.members).toHaveLength(4); // the failure and its three fixes, no votes
    expect(body.title).toBe('pip install torch==2.1');
    expect(body.summary).toMatch(/What went wrong: .*no wheel/);
    expect(body.summary).toMatch(/What fixed it: use torch 2\.5/);
    const found = hub.ledger.learned('torch wheel 3.13');
    expect(found[0]).toMatchObject({ id: sum.rec.id, sources: 4 });
  });

  it('"this helped" is a signed use record that strengthens the link it followed', async () => {
    let now = T0;
    const hub = new Hub({ signer: LocalSigner.generate(), preview: false, now: () => now });
    const f = await signRecord({ kind: 'failure', context: ctx('parse durations', ['python']), body: { approach: 'fromisoformat on P3D', outcome: 'error', error_summary: 'ValueError', confidence: 0.8 }, created: at(0) }, LocalSigner.generate());
    hub.node.ingest(f);
    const fix = await signRecord({ kind: 'answer', context: ctx('parse durations', ['python']), body: { question: 'parse P3D?', answer: 'isodate.parse_duration', proof: { type: 'test', detail: 'ok' } }, refs: [f.id], created: at(0) }, LocalSigner.generate());
    hub.node.ingest(fix);
    now = T0 + 30 * DAY;
    const before = hub.graph.neighbours(f.id, 1)[0].weight;
    for (let i = 0; i < 3; i++) hub.node.ingest(await signRecord({ kind: 'use', context: { task: 'used a record', domain: ['python'], environment: '' }, body: { target: fix.id, helpful: true }, refs: [fix.id], created: at(30) }, LocalSigner.generate()));
    expect(hub.graph.neighbours(f.id, 1)[0].weight).toBeGreaterThan(before);
  });
});
