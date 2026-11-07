import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Hub } from '../../src/hub/hub.js';
import { LocalSigner } from '../../src/core/identity.js';
import { signRecord, SignedRecord } from '../../src/core/record.js';
import { Consolidator } from '../../src/graph/consolidate.js';
import { MAP_CHARS, PageBody } from '../../src/graph/pages.js';
import { createMcpServer } from '../../src/mcp/server.js';

/**
 * Memory that gets wiser (docs/MEMORY.md), after Anthropic's study of agent memory: topic pages written as
 * rules with evidence and status, a small map at the start of every session, a page plus search on lookup,
 * and dreaming that re-checks pages against the signed record when their evidence changes.
 */
const ctx = (task: string, domain = ['x0x']) => ({ task, domain, environment: 'x0xd 0.48' });
const someone = () => LocalSigner.generate();

async function topic(hub: Hub) {
  const author = someone();
  const fail = await signRecord({ kind: 'failure', context: ctx('start a named x0x instance'), body: { approach: 'start x0xd with instance_name and no network_id', outcome: 'error', error_summary: 'refuses to start: named instance needs a network id', confidence: 0.8 } }, author) as SignedRecord;
  hub.node.ingest(fail);
  const answers: SignedRecord[] = [];
  const texts = [
    'Set network_id = "x0x.prod" in the config. Named instances refuse to start without it.',
    'Use the default instance if you don\'t need a name. Then no network id is required.',
    'Pin x0xd to 0.48.1 or later. Older builds give a confusing error here.',
  ];
  for (const [i, answer] of texts.entries()) {
    const r = await signRecord({ kind: 'answer', context: ctx('start a named x0x instance'), body: { question: 'x0xd named instance will not start', answer, proof: { type: i === 2 ? 'citation' : 'test', detail: i === 2 ? 'fixed by a merged pull request' : 'started cleanly' } }, refs: [fail.id] }, someone()) as SignedRecord;
    hub.node.ingest(r); answers.push(r);
  }
  const confirm = async (id: string) => hub.node.ingest(await signRecord({ kind: 'confirmation', refs: [id], context: ctx('confirm'), body: { verdict: 'reproduced', note: '' } }, someone()) as SignedRecord);
  await confirm(answers[0].id); await confirm(answers[0].id);
  return { fail, answers, confirm };
}
const page = (hub: Hub) => hub.pages.latest()[0];
const body = (hub: Hub) => page(hub).rec.body as unknown as PageBody;

describe('memory: topic pages, the map, and dreaming', () => {
  it('sleep writes a topic page: rules with evidence and status, traps, the fix verbatim, smaller than its sources', async () => {
    const hub = new Hub({ signer: someone(), preview: false });
    const { fail, answers } = await topic(hub);
    expect(await new Consolidator(hub).sleep()).toMatchObject({ summarised: 1 });
    const b = body(hub);
    expect(b.v).toBe(2);
    expect(b.rules[0]).toMatchObject({ text: 'Set network_id = "x0x.prod" in the config.', status: 'checked', confirmations: 2 });
    expect(b.rules[0].evidence).toEqual([answers[0].id, fail.id]);
    expect(b.rules.find((r) => r.evidence[0] === answers[2].id)?.status).toBe('merged');
    expect(b.rules.find((r) => r.evidence[0] === answers[1].id)?.status).toBe('unconfirmed');
    expect(b.traps[0].evidence).toEqual([fail.id]);
    expect(b.fix).toEqual({ text: (answers[0].body as { answer: string }).answer, from: answers[0].id }); // word for word
    expect(b.page_bytes).toBeLessThanOrEqual(b.source_bytes);
  });

  it('the map is small, carries only supported rules, and points down to pages', async () => {
    const hub = new Hub({ signer: someone(), preview: false });
    expect(hub.pages.brief()).toBe(''); // nothing learned, nothing injected
    await topic(hub);
    await new Consolidator(hub).sleep();
    const map = hub.pages.brief();
    expect(map.length).toBeLessThanOrEqual(MAP_CHARS);
    expect(map).toContain(page(hub).rec.id.slice(0, 12));
    expect(map).toContain('Set network_id');
    expect(map).not.toContain('Use the default instance'); // unconfirmed rules stay off the map
    expect(hub.pages.brief({ max: 200 }).length).toBeLessThanOrEqual(200);
  });

  it('dreaming demotes a disputed rule into a trap, promotes a newly confirmed one, and leaves unchanged pages alone', async () => {
    const hub = new Hub({ signer: someone(), preview: false });
    const { answers, confirm } = await topic(hub);
    await new Consolidator(hub).sleep();
    await new Promise((r) => setTimeout(r, 5));
    expect(await hub.pages.dream()).toMatchObject({ rewritten: 0 }); // nothing changed since it was written

    for (let i = 0; i < 3; i++) hub.node.ingest(await signRecord({ kind: 'contradiction', refs: [answers[0].id], context: ctx('dispute'), body: { reason: 'still refused on 0.49' } }, someone()) as SignedRecord);
    await confirm(answers[1].id);
    const d = await hub.pages.dream();
    expect(d).toMatchObject({ rewritten: 1 });
    const b = body(hub);
    expect(b.rules.map((r) => r.evidence[0])).not.toContain(answers[0].id);
    expect(b.traps[0]).toMatchObject({ disputed_fix: true, evidence: [answers[0].id] });
    expect(b.rules.find((r) => r.evidence[0] === answers[1].id)?.status).toBe('checked');
    expect(b.dreamed).toContain('new confirmations or disputes');
    expect(b.supersedes).toBeTruthy();
    expect(hub.pages.brief()).not.toContain('Set network_id');
    await new Promise((r) => setTimeout(r, 5));
    expect(await hub.pages.dream()).toMatchObject({ rewritten: 0 });
  });

  it('dreaming retires a topic whose records are gone and merges a near-duplicate into the larger topic', async () => {
    const hub = new Hub({ signer: someone(), preview: false });
    await topic(hub);
    await new Consolidator(hub).sleep();
    const big = body(hub);
    // A duplicate page over most of the same lessons, and a page whose records were pruned.
    const dup = await hub.node.submit({ kind: 'summary', context: ctx('consolidate'), body: { ...big, cluster: 'dup', members: big.members.slice(0, 3), supersedes: null }, refs: big.members.slice(0, 3) }, { publish: true });
    const gone = await hub.node.submit({ kind: 'summary', context: ctx('consolidate'), body: { ...big, cluster: 'gone', members: ['f'.repeat(64), 'e'.repeat(64)], links: ['nowhere'], supersedes: null }, refs: [] }, { publish: true });
    const d = await hub.pages.dream();
    expect(d.retired).toBe(1);
    expect(d.merged).toBe(1);
    const live = hub.pages.latest().map((s) => (s.rec.body as unknown as PageBody).cluster);
    expect(live).toEqual([big.cluster]);
    expect(dup.record.id).toBeTruthy(); expect(gone.record.id).toBeTruthy();
  });

  it('agents start with the map and get the page before the search results', async () => {
    const hub = new Hub({ signer: someone(), preview: false });
    await topic(hub);
    await new Consolidator(hub).sleep();
    const server = createMcpServer(hub);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 't', version: '1' });
    await Promise.all([server.connect(a), client.connect(b)]);
    expect(client.getInstructions()).toContain('Map of what other agents learned');
    expect(client.getInstructions()).toContain('rules are worth more than failures alone');
    const call = async (args: Record<string, unknown>) => JSON.parse(((await client.callTool({ name: 'answers_lookup', arguments: args })).content as { text: string }[])[0].text);
    const r = await call({ question: 'x0xd named instance will not start network id' });
    expect(r.page.rules[0].status).toBe('checked');
    expect(r.results.length).toBeGreaterThan(0);
    const opened = await call({ question: '', page: page(hub).rec.id.slice(0, 12) });
    expect(opened.page.title).toBe(body(hub).title);
    await client.close();
  });
});
