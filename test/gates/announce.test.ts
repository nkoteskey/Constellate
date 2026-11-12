import { describe, it, expect, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Hub } from '../../src/hub/hub.js';
import { LocalSigner } from '../../src/core/identity.js';
import { signRecord } from '../../src/core/record.js';
import { RecordStore } from '../../src/store/records.js';
import type { Verifier } from '../../src/work/verifiers.js';
import { Announcer, checkTitle, graphemes, POST_LIMIT, type Item } from '../../src/announce/announce.js';
import { linkFacets, xIntent } from '../../src/announce/sinks.js';

/**
 * The announcer (docs/ANNOUNCE.md) tells people when lent computers make progress a machine has checked, with a call
 * to lend one. It only says what this computer re-checked itself, and never more than "checked by machine, no person
 * has reviewed it yet". Possible finds, catalogue problems, problems from strangers and "whole problem done" wait for
 * the owner. Nothing leaves the computer without `send --yes`; the default destination is a feed file; X is a compose
 * link only; "archived on Autonomi" needs this computer's own storage receipt.
 */
const DAY = 86_400_000;
const MON = Date.parse('2026-11-02T00:00:00Z'); // a Monday
const iso = (t: number) => new Date(t).toISOString();
const ADDR = createHash('sha256').update('a library bundle').digest('hex');
const CTA = 'https://github.com/nkoteskey/Constellate';
const ctx = { task: 'a step', domain: ['maths_physics'], environment: '' };
const CUBES_33 = '8866128975287528 -8778405442862239 -2736111468807040';

/** A stand-in proof check (not a warm-up, not a witness search): "proved" passes. */
const stub: Verifier = { name: 'stub_proof', async check(_s, out) { return { ok: out.trim() === 'proved', detail: '' }; } };
const worker = LocalSigner.generate(), checker = LocalSigner.generate(), stranger = LocalSigner.generate();

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'announce-'));
  const hub = new Hub({ signer: LocalSigner.generate(), store: new RecordStore(), preview: false });
  hub.problems.verifiers.register(stub);
  return { home, hub, ann: new Announcer(hub, home) };
}

const problem = (title: string, o: { verifier?: string; chunks?: string[]; source?: boolean } = {}) => {
  const verifier = o.verifier ?? 'stub_proof';
  return {
    title, goal: 'Settle it.', realm: 'maths_physics' as const,
    definition_of_done: { verifier, description: 'the machine check passes' },
    chunks: (o.chunks ?? ['a', 'b']).map((k) => ({ key: k, title: `step ${k}`, prompt: 'do it', check: verifier === 'three_cubes' ? { n: 33 } : {} })),
    ...(o.source ? { source: { url: 'https://example.org/problems/1', says: 'open', read: '2026-11-01' } } : {}),
  };
};
async function propose(hub: Hub, title: string, o?: Parameters<typeof problem>[1]) {
  return (await hub.problems.propose(problem(title, o), { publish: true })).record.id;
}

/** A worker's answer, then a checkpoint by a different identity and (unless told otherwise) a different model family. */
async function step(hub: Hub, problemId: string, chunk: string, output = 'proved', o: { at?: number; family?: string; by?: LocalSigner; noCheckpoint?: boolean } = {}) {
  const created = o.at ? iso(o.at) : undefined;
  const res = await signRecord({ kind: 'task_result', context: ctx, body: { problem: problemId, chunk, output, model: 'm-1', family: 'llama' }, refs: [problemId], created }, worker);
  expect(hub.node.ingest(res)).toBeTruthy();
  if (o.noCheckpoint) return res.id;
  const cp = await signRecord({ kind: 'checkpoint', context: ctx, body: { problem: problemId, chunk, seq: 1, result: res.id, verifier_model: 'v-1', verifier_family: o.family ?? 'qwen', machine_check: 'passed' }, refs: [problemId, res.id], created }, o.by ?? checker);
  expect(hub.node.ingest(cp)).toBeTruthy();
  return cp.id;
}

const spend = (archive: 'autonomi' | 'local', address: string) => ({
  kind: 'receipt' as const,
  context: { task: 'payment: storage_spend', domain: ['payments', 'storage'], environment: archive },
  body: { type: 'storage_spend', payer: 'fund', payee: archive, amount: 0, tx: address, rail: 'archive', network: archive, address, bytes: 2048, records: 2, atto_ant: '0', archive, by: { core: 2 } },
  refs: [],
});

type Call = { url: string; init?: RequestInit };
function fakeNet(status = 200) {
  const calls: Call[] = [];
  const json = (v: unknown) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
  const fetch = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith('/xrpc/com.atproto.server.createSession')) return json({ accessJwt: 'jwt-1', refreshJwt: 'r', handle: 'constellate-test.bsky.social', did: 'did:plc:abc' });
    if (url.endsWith('/xrpc/com.atproto.repo.createRecord')) return json({ uri: 'at://did:plc:abc/app.bsky.feed.post/3k', cid: 'c1' });
    if (url.endsWith('/api/v1/statuses')) return json({ id: '9', url: 'https://social.example/statuses/9' });
    return new Response('not found', { status: 404 });
  };
  return { calls, fetch };
}
const secrets = (n: 'bluesky' | 'mastodon') => (n === 'bluesky' ? 'app-pw-1' : 'token-1');
const headers = (c: Call) => c.init!.headers as Record<string, string>;
const ofProblem = (items: Item[], id: string) => items.filter((i) => i.problem === id).map((i) => ({ kind: i.kind, tier: i.tier, why: i.why }));

const FIND = 'a possible find on an open search: a person checks it before anyone hears of it';
const CATALOGUE = 'the problem comes from a public catalogue: a person checks the claim against the source first';
const STRANGER = 'proposed by someone this computer does not vouch for';
const WHOLE = 'says a whole problem is done';

afterEach(() => { delete process.env.CONSTELLATE_DENY_TERMS; });

describe('the announcer says only what a machine checked, and only the owner sends it', () => {
  it('by default nothing goes until approved and sent with --yes, and then only to a feed file on this computer', async () => {
    const { home, hub, ann } = setup();
    const p = await propose(hub, 'Every widget graph has a perfect pairing');
    await ann.collect(MON); // announcing starts now; nothing to say yet
    const cp = await step(hub, p, 'a', 'proved', { at: MON + DAY });
    const items = await ann.collect(MON + 2 * DAY);
    expect(items).toHaveLength(1);
    const [i] = items;
    expect(i).toMatchObject({ kind: 'first', tier: 'auto', problem: p, checkpoint: cp, why: [] });
    expect(i.backlog).toBeUndefined();
    expect(i.text).toBe(`"Every widget graph has a perfect pairing" has a step checked by machine on Constellate (1 of 2 done). No person has reviewed it yet.\nLend a computer: ${CTA}`);
    expect(i.feed).toContain(`Problem record: ${p}`);
    expect(i.feed).toContain(`Checkpoint record: ${cp}`);
    expect(i.feed).toContain('How it was checked: the problem\'s machine check (stub_proof) passed again on this computer');
    expect(i.text + i.feed).not.toMatch(/Autonomi/);

    const net = fakeNet();
    expect(ann.list()[0].status).toBe('waits for your approval (automatic posting is off)');
    expect(ann.list()[0].x).toBeUndefined();
    expect(await ann.send({ yes: true, fetch: net.fetch, secret: secrets })).toEqual([]);
    ann.approve(i.id);
    expect(ann.list()[0].x).toBe(xIntent(i.text)); // X: a link the person opens and sends themselves
    expect(await ann.send({ fetch: net.fetch, secret: secrets })).toEqual([{ id: i.id, sink: 'feed', ok: true, detail: 'would send' }]);
    expect(existsSync(ann.feedPath())).toBe(false); // a dry run writes nothing
    expect(await ann.send({ yes: true, fetch: net.fetch, secret: secrets })).toEqual([{ id: i.id, sink: 'feed', ok: true, detail: 'written' }]);
    const feed = readFileSync(join(home, 'announce', 'feed.xml'), 'utf8');
    expect(feed).toContain('<title>Every widget graph has a perfect pairing</title>');
    expect(feed).toContain('No person has reviewed it yet.');
    expect(net.calls).toEqual([]); // no network at all
    expect(ann.list()[0].status).toBe('sent');
    expect(await ann.send({ yes: true, fetch: net.fetch, secret: secrets })).toEqual([]); // never twice

    // Approved words are frozen: more progress doesn't rewrite what the owner approved.
    await step(hub, p, 'b', 'proved', { at: MON + 3 * DAY });
    const again = await ann.collect(MON + 4 * DAY);
    expect(again.find((x) => x.id === i.id)!.text).toBe(i.text);
    expect(ofProblem(again, p)).toEqual([{ kind: 'first', tier: 'auto', why: [] }, { kind: 'solved', tier: 'founder', why: [WHOLE] }]);
  });

  it('a wrong answer, an unchecked one, a check by the same model family or identity, or a warm-up says nothing', async () => {
    const { hub, ann } = setup();
    await ann.collect(MON);
    await step(hub, await propose(hub, 'Wrong answer problem'), 'a', 'not proved', { at: MON + DAY });
    await step(hub, await propose(hub, 'Unchecked answer problem'), 'a', 'proved', { at: MON + DAY, noCheckpoint: true });
    await step(hub, await propose(hub, 'Same family problem'), 'a', 'proved', { at: MON + DAY, family: 'llama' });
    await step(hub, await propose(hub, 'Same identity problem'), 'a', 'proved', { at: MON + DAY, by: worker });
    const toy = (await hub.problems.propose({ ...problem('Warm-up sum', { verifier: 'exact' }), chunks: [{ key: 'a', title: 's', prompt: 'p', check: { answer: '4' } }] }, { publish: true })).record.id;
    await step(hub, toy, 'a', '4', { at: MON + DAY });
    expect(await ann.collect(MON + 2 * DAY)).toEqual([]);
  });

  it('possible finds, catalogue problems, strangers\' problems and "whole problem done" wait for the owner, even with automatic posting on', async () => {
    const { hub, ann } = setup();
    ann.setConfig({ auto: true });
    await ann.collect(MON);
    const find = await propose(hub, 'Sums of three cubes for thirty three', { verifier: 'three_cubes', chunks: ['n33'] });
    await step(hub, find, 'n33', CUBES_33, { at: MON + DAY });
    const cat = await propose(hub, 'A catalogue problem on widget graphs', { source: true });
    await step(hub, cat, 'a', 'proved', { at: MON + DAY });
    const theirs = await signRecord({ kind: 'problem', context: { task: 'A stranger problem on widget graphs', domain: ['maths_physics'], environment: '' }, body: problem('A stranger problem on widget graphs') }, stranger);
    expect(hub.node.ingest(theirs)).toBeTruthy();
    await step(hub, theirs.id, 'a', 'proved', { at: MON + DAY });
    const ours = await propose(hub, 'Our own small widget lemma', { chunks: ['a'] });
    await step(hub, ours, 'a', 'proved', { at: MON + DAY });

    const items = await ann.collect(MON + 2 * DAY);
    expect(ofProblem(items, find)).toEqual([{ kind: 'find', tier: 'founder', why: [FIND] }, { kind: 'solved', tier: 'founder', why: [FIND, WHOLE] }]);
    expect(ofProblem(items, cat)).toEqual([{ kind: 'first', tier: 'founder', why: [CATALOGUE] }]);
    expect(ofProblem(items, theirs.id)).toEqual([{ kind: 'first', tier: 'founder', why: [STRANGER] }]);
    expect(ofProblem(items, ours)).toEqual([{ kind: 'first', tier: 'auto', why: [] }, { kind: 'solved', tier: 'founder', why: [WHOLE] }]);
    const findItem = items.find((i) => i.kind === 'find')!;
    expect(findItem.text).toBe(`Possible find on "Sums of three cubes for thirty three": an answer sent to Constellate passed its machine check. No person has reviewed it yet.\nLend a computer: ${CTA}`);
    expect(items.find((i) => i.kind === 'solved' && i.problem === ours)!.text).toMatch(/^"Our own small widget lemma" is checked by machine on Constellate\. No person has reviewed it yet\.\n/);
    expect(ann.list().find((i) => i.id === findItem.id)!.status).toBe(`waits for your approval (${FIND})`);

    // Automatic posting sends only the auto tier.
    const net = fakeNet();
    const auto = items.find((i) => i.problem === ours && i.kind === 'first')!;
    expect(await ann.send({ yes: true, fetch: net.fetch, secret: secrets })).toEqual([{ id: auto.id, sink: 'feed', ok: true, detail: 'written' }]);
    ann.approve(findItem.id);
    expect(await ann.send({ yes: true, fetch: net.fetch, secret: secrets })).toEqual([{ id: findItem.id, sink: 'feed', ok: true, detail: 'written' }]);
    expect(net.calls).toEqual([]);
  });

  it('progress from before announcing started never goes on its own', async () => {
    const { hub, ann } = setup();
    ann.setConfig({ auto: true });
    const p = await propose(hub, 'Every widget graph has a perfect pairing');
    await step(hub, p, 'a', 'proved', { at: MON - DAY });
    const [i] = await ann.collect(MON);
    expect(i.backlog).toBe(true);
    expect(ann.list()[0].status).toBe('from before announcing started: approve it to send it');
    expect(await ann.send({ yes: true })).toEqual([]);
  });

  it('posts to Bluesky and Mastodon only when the owner set them up, the right way, once', async () => {
    const { home, hub, ann } = setup();
    ann.setConfig({ auto: true, bluesky: { handle: 'constellate-test.bsky.social' }, mastodon: { instance: 'https://social.example/' } });
    await ann.collect(MON);
    const p = await propose(hub, 'Café widgets: a pairing lemma');
    await step(hub, p, 'a', 'proved', { at: MON + DAY });
    const [i] = await ann.collect(MON + 2 * DAY);

    // No password or token stored yet: the feed is written, the accounts are not touched, and they stay to do.
    const none = fakeNet();
    const first = await ann.send({ yes: true, fetch: none.fetch, secret: () => undefined });
    expect(first.map((r) => [r.sink, r.ok, r.detail])).toEqual([
      ['feed', true, 'written'],
      ['bluesky', false, 'no app password stored: `constellate keys set bluesky`'],
      ['mastodon', false, 'no access token stored: `constellate keys set mastodon`'],
    ]);
    expect(none.calls).toEqual([]);

    // A server that says no: reported, not marked sent.
    const refused = fakeNet(401);
    const r401 = await ann.send({ yes: true, fetch: refused.fetch, secret: secrets });
    expect(r401.map((r) => [r.sink, r.ok])).toEqual([['bluesky', false], ['mastodon', false]]);
    expect(r401[0].detail).toMatch(/^Bluesky login: HTTP 401/);

    const net = fakeNet();
    const r = await ann.send({ yes: true, fetch: net.fetch, secret: secrets });
    expect(r.map((x) => [x.sink, x.ok, x.detail])).toEqual([
      ['bluesky', true, 'at://did:plc:abc/app.bsky.feed.post/3k'],
      ['mastodon', true, 'https://social.example/statuses/9'],
    ]);
    expect(net.calls.map((c) => c.url)).toEqual([
      'https://bsky.social/xrpc/com.atproto.server.createSession',
      'https://bsky.social/xrpc/com.atproto.repo.createRecord',
      'https://social.example/api/v1/statuses',
    ]);
    expect(JSON.parse(String(net.calls[0].init!.body))).toEqual({ identifier: 'constellate-test.bsky.social', password: 'app-pw-1' });
    expect(headers(net.calls[1]).authorization).toBe('Bearer jwt-1');
    const rec = JSON.parse(String(net.calls[1].init!.body));
    expect(rec).toMatchObject({ repo: 'did:plc:abc', collection: 'app.bsky.feed.post', record: { $type: 'app.bsky.feed.post', text: i.text, langs: ['en'] } });
    expect(Date.parse(rec.record.createdAt)).not.toBeNaN();
    expect(rec.record.facets).toHaveLength(1);
    const f = rec.record.facets[0];
    expect(Buffer.from(i.text).subarray(f.index.byteStart, f.index.byteEnd).toString()).toBe(CTA); // byte offsets, after the é
    expect(f.features).toEqual([{ $type: 'app.bsky.richtext.facet#link', uri: CTA }]);
    expect(Object.fromEntries(new URLSearchParams(String(net.calls[2].init!.body)))).toEqual({ status: i.text, visibility: 'public', language: 'en' });
    expect(headers(net.calls[2]).authorization).toBe('Bearer token-1');
    expect(headers(net.calls[2])['idempotency-key']).toBe(i.hash);

    // A restart never posts twice, and nothing ever goes to X.
    expect(await new Announcer(hub, home).send({ yes: true, fetch: net.fetch, secret: secrets })).toEqual([]);
    expect(net.calls).toHaveLength(3);
    expect([...none.calls, ...refused.calls, ...net.calls].some((c) => /x\.com|twitter/.test(c.url))).toBe(false);
    expect(ann.list()[0].sent).toMatchObject({ feed: {}, bluesky: { ref: 'at://did:plc:abc/app.bsky.feed.post/3k' }, mastodon: { ref: 'https://social.example/statuses/9' } });
  });

  it('settings take only https addresses', () => {
    const { ann } = setup();
    expect(() => ann.setConfig({ cta: 'http://example.org' })).toThrow(/https/);
    expect(() => ann.setConfig({ mastodon: { instance: 'social.example' } })).toThrow(/https/);
    expect(() => ann.setConfig({ bluesky: { handle: ' ' } })).toThrow(/handle/);
    expect(ann.setConfig({ cta: 'https://example.org/lend' })).toEqual({ auto: false, feed: true, cta: 'https://example.org/lend' });
    expect(ann.setConfig({ cta: undefined })).toEqual({ auto: false, feed: true });
  });

  it('a title with an @, a web address or personal data is blocked, never cleaned up, and can\'t be approved', async () => {
    expect(checkTitle('  The   widget\nbound ')).toEqual({ title: 'The widget bound' });
    expect(checkTitle('')).toEqual({ blocked: 'the problem has no title' });
    expect(checkTitle('Ask @zzyzx about widgets')).toEqual({ blocked: 'the title has an @, which would mention an account' });
    for (const t of ['Widget bounds from zzyzx-bounds.org', 'See https://example.org now', 'See www.example now', 'Widgets at qwerty.io'])
      expect(checkTitle(t)).toEqual({ blocked: 'the title has a link or a web address' });
    expect(checkTitle('The Zzyzx widget bound', ['Zzyzx'])).toMatchObject({ blocked: expect.stringMatching(/^the title may hold personal data or a secret/) });
    expect(checkTitle('Widgets of order 3.14 and the e.g. case')).toEqual({ title: 'Widgets of order 3.14 and the e.g. case' });

    const { hub, ann } = setup();
    await ann.collect(MON);
    const linky = await propose(hub, 'Widget bounds from zzyzx-bounds.org');
    await step(hub, linky, 'a', 'proved', { at: MON + DAY });
    const denied = await propose(hub, 'The Zzyzx widget bound');
    await step(hub, denied, 'a', 'proved', { at: MON + DAY });
    process.env.CONSTELLATE_DENY_TERMS = 'Zzyzx';
    const items = await ann.collect(MON + 2 * DAY);
    const a = items.find((i) => i.problem === linky)!, b = items.find((i) => i.problem === denied)!;
    expect(items).toHaveLength(2);
    expect([a.text, a.feed, a.blocked]).toEqual(['', '', 'the title has a link or a web address']);
    expect([b.text, b.feed, b.blocked]).toEqual(['', '', expect.stringMatching(/^the title may hold personal data or a secret/)]);
    expect(() => ann.approve(a.id)).toThrow(/^Blocked: the title has a link/);
    const status = Object.fromEntries(ann.list().map((i) => [i.id, i.status]));
    expect(status[a.id]).toBe('blocked: the title has a link or a web address');
    expect(status[b.id]).toMatch(/^blocked: the title may hold personal data/);
    expect(await ann.send({ yes: true })).toEqual([]);
  });

  it('a name added to the deny list after approval holds the post back', async () => {
    const { hub, ann } = setup();
    await ann.collect(MON);
    const p = await propose(hub, 'The Qwerty widget bound');
    await step(hub, p, 'a', 'proved', { at: MON + DAY });
    const [i] = await ann.collect(MON + 2 * DAY);
    ann.approve(i.id);
    process.env.CONSTELLATE_DENY_TERMS = 'Qwerty';
    const r = await ann.send({ yes: true });
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ id: i.id, ok: false, detail: expect.stringMatching(/^held: may hold personal data or a secret/) });
    expect(existsSync(ann.feedPath())).toBe(false);
  });

  it('words changed after approval are not sent', async () => {
    const { home, hub, ann } = setup();
    await ann.collect(MON);
    const p = await propose(hub, 'Every widget graph has a perfect pairing');
    await step(hub, p, 'a', 'proved', { at: MON + DAY });
    const [i] = await ann.collect(MON + 2 * DAY);
    ann.approve(i.id);
    const file = join(home, 'announce', 'outbox.json');
    const box = JSON.parse(readFileSync(file, 'utf8'));
    box.items[0].text = box.items[0].text.replace('No person has reviewed it yet.', 'Solved!');
    writeFileSync(file, JSON.stringify(box));
    expect(ann.list()[0].status).toBe('the words changed after approval: approve it again');
    expect(await ann.send({ yes: true })).toEqual([{ id: i.id, ok: false, detail: 'the words changed after approval: approve it again' }]);
    expect(existsSync(ann.feedPath())).toBe(false);
  });

  it('says "archived on Autonomi" only with this computer\'s own Autonomi storage receipt for the bundle, and always fits in a post', async () => {
    const { home, hub, ann } = setup();
    await ann.collect(MON);
    const p = await propose(hub, 'Every widget graph has a perfect pairing');
    const cp = await step(hub, p, 'a', 'proved', { at: MON + DAY });
    const longTitle = `A very long title about widget graphs ${'and their perfect pairings '.repeat(5)}in the end`;
    const long = await propose(hub, longTitle);
    const cpLong = await step(hub, long, 'a', 'proved', { at: MON + DAY });
    const library = (addr: string) => writeFileSync(join(home, 'library.json'), JSON.stringify({ archived: [cp, cpLong], bundles: { [cp]: addr, [cpLong]: addr } }));
    const text = async () => (await ann.collect(MON + 2 * DAY)).find((i) => i.problem === p)!;

    library(ADDR);
    expect((await text()).text).not.toMatch(/Autonomi/); // no receipt
    const foreign = await signRecord(spend('autonomi', ADDR), stranger);
    expect(hub.node.ingest(foreign)).toBeTruthy();
    expect((await text()).text).not.toMatch(/Autonomi/); // another computer's receipt proves nothing here
    const LOCAL = createHash('sha256').update('a local bundle').digest('hex');
    await hub.node.submit(spend('local', LOCAL), { publish: true });
    library(LOCAL);
    expect((await text()).text).not.toMatch(/Autonomi/); // kept on this computer, not on Autonomi

    const { record } = await hub.node.submit(spend('autonomi', ADDR), { publish: true });
    library(ADDR);
    const i = await text();
    expect(i.text).toBe(`"Every widget graph has a perfect pairing" has a step checked by machine on Constellate (1 of 2 done). No person has reviewed it yet.\nLend a computer: ${CTA}\nArchived on Autonomi: ${ADDR}`);
    expect(i.feed).toContain(`Archived on Autonomi: ${ADDR} (the bundle holding the checkpoint; storage receipt ${record.id})`);
    expect(i.text + i.feed).not.toMatch(/ant:\/\/|gateway/);

    const l = (await ann.collect(MON + 2 * DAY)).find((x) => x.problem === long)!;
    expect(graphemes(l.text)).toBeLessThanOrEqual(POST_LIMIT);
    expect(l.text).toMatch(/^"A very long title about widget graphs[^"]*…" has a step checked/);
    expect(l.text).toContain(`Archived on Autonomi: ${ADDR}`);
    expect(l.feed).toContain(longTitle); // the feed keeps the whole title
    for (const x of ann.list()) expect(graphemes(x.text)).toBeLessThanOrEqual(POST_LIMIT);
  });

  it('the weekly digest counts last week\'s checked steps on problems the computer vouches for, and leaves possible finds out', async () => {
    const { hub, ann } = setup();
    const p = await propose(hub, 'Every widget graph has a perfect pairing', { chunks: ['a', 'b', 'c'] });
    const q = await propose(hub, 'Our second widget lemma', { chunks: ['a', 'b', 'c'] });
    const find = await propose(hub, 'Sums of three cubes for thirty three', { verifier: 'three_cubes', chunks: ['n33'] });
    await step(hub, p, 'a', 'proved', { at: MON - 3 * DAY }); // the week before: not counted
    await step(hub, p, 'b', 'proved', { at: MON + DAY });
    await step(hub, q, 'a', 'proved', { at: MON + 6 * DAY });
    await step(hub, find, 'n33', CUBES_33, { at: MON + 2 * DAY }); // a possible find: left out until a person checks it

    const items = await ann.collect(MON + 9 * DAY); // the Wednesday after
    const d = items.find((i) => i.kind === 'digest')!;
    expect(d).toMatchObject({ event: 'digest:2026-11-02', tier: 'auto', why: [], backlog: true });
    expect(d.text).toBe(`Last week on Constellate, 2 steps on 2 problems were checked by machine. No person has reviewed them yet.\nLend a computer: ${CTA}`);
    expect(d.feed.split('\n')[0]).toBe('Week of 2026-11-02');
    expect(d.feed).toContain('from 2026-11-02 to 2026-11-08 (UTC)');

    // The next week's digest goes on its own once automatic posting is on.
    ann.setConfig({ auto: true });
    await step(hub, q, 'b', 'proved', { at: MON + 10 * DAY });
    const next = (await ann.collect(MON + 15 * DAY)).find((i) => i.event === 'digest:2026-11-09')!;
    expect(next.backlog).toBeUndefined();
    expect(next.text).toMatch(/^Last week on Constellate, 1 step on 1 problem was checked by machine\. No person has reviewed it yet\.\n/);
    expect((await ann.send({ yes: true })).map((r) => r.id)).toEqual([next.id]);
  });

  it('the X link and Bluesky link facets carry the exact words', () => {
    const t = 'Café ✓ "pairing" #1 & more?\nLend a computer: https://a.example/x.';
    expect(xIntent(t).startsWith('https://x.com/intent/tweet?text=')).toBe(true);
    expect(new URL(xIntent(t)).searchParams.get('text')).toBe(t);
    const [f, ...rest] = linkFacets(t);
    expect(rest).toEqual([]);
    expect(f.index.byteStart).toBe(Buffer.byteLength(t.slice(0, t.indexOf('https'))));
    expect(Buffer.from(t).subarray(f.index.byteStart, f.index.byteEnd).toString()).toBe('https://a.example/x');
  });

  it('`constellate announce set` stores the account and says how to add its password; send is a dry run without --yes', async () => {
    const home = mkdtempSync(join(tmpdir(), 'announce-cli-'));
    const run = (...a: string[]) => promisify(execFile)(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/cli.ts', 'announce', ...a], { env: { ...process.env, CONSTELLATE_HOME: home } });
    const b = await run('set', 'bluesky', '@constellate-test.bsky.social');
    expect(b.stdout).toContain('Store its app password with `constellate keys set bluesky`');
    expect(JSON.parse(readFileSync(join(home, 'announce.json'), 'utf8'))).toEqual({ auto: false, feed: true, bluesky: { handle: 'constellate-test.bsky.social' } });
    await expect(run('set', 'cta', 'http://example.org')).rejects.toThrow(/https/);
    expect((await run('send')).stdout).toContain('Nothing is cleared to send.');
  }, 90_000);
});
