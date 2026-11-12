import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import type { Browser } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Hub } from '../../src/hub/hub.js';
import { LocalSigner } from '../../src/core/identity.js';
import { signRecord } from '../../src/core/record.js';
import { WebServer } from '../../src/web/server.js';
import { registerAppRoutes } from '../../src/web/app.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { scrub } from '../../src/privacy/scrub.js';
import { parseErdosYaml, parseFormalConjectures, readTarGz } from '../../src/scout/sources.js';
import { Scout, rankCatalogue, ideaFor, scoutingBrief, SCOUT_ID, SCOUT_SOURCES, type ScoutCatalogue } from '../../src/scout/scout.js';

/**
 * The problem scout (docs/SCOUT.md): reads public catalogues of open problems, ranks them, and makes proposing one a
 * click. The fixtures copy the real catalogues' formats, with text planted where people's names sit in the real ones
 * (contributor notes, reference lists, crediting sentences): none of it may ever come out.
 */
const PLANTED = /SECRET|Zzyzx|Qwerty/;

const YAML = `- number: "1"
  prize: "$500"
  informal_status:
    state: "falsifiable"
    last_update: "2025-08-31"
  formal_status:
    state: "unformalized"
    note: "SECRET-NOTE-TEXT opens here and
  tags: [\\"SECRET-NOTE-TEXT\\"]
      closes here"
  status:
    state: "falsifiable"
    last_update: "2025-08-31"
  oeis: ["A000001", "N/A"]
  formalized:
    state: "yes"
    last_update: "2025-08-31"
  tags: ["graph theory", "cycles"]
  comments: "toy cycle conjecture"
- number: "2"
  prize: "no"
  status:
    state: "verifiable"
    last_update: "2025-08-31"
  oeis: ["N/A"]
  formalized:
    state: "no"
  tags: ["number theory"]
- number: "3"
  prize: "£25"
  status:
    state: "open"
  formalized:
    state: "yes"
  tags: ["additive combinatorics"]
- number: "4"
  status:
    state: "open"
  formalized:
    state: "no"
  tags: ["geometry"]
- number: "5"
  status:
    state: "open (Lean)"
  formalized:
    state: "yes"
- number: "6"
  status:
    state: "proved"
  formal_status:
    state: "Lean"
    note: "SECRET-NOTE-TEXT, a one-line note"
- number: "7"
  status:
    state: "falsifiable"
  comments: "ambiguous statement"
  tags: ["primes"]
- number: "8"
  status:
    state: "decidable"
  formalized:
    state: "no"
  tags: ["primes"]
`;

const lean = (title: string, desc: string, theorems: string) => `import FormalConjectures.Util.ProblemImports

/-!
# ${title}
${desc}
*References:*
- [Zz99] SECRET-REF-TEXT, A Book of Toy Problems
-/

namespace Toy

${theorems}

end Toy
`;
const FC = [
  { path: 'ErdosProblems/1.lean', text: lean('Erdős Problem 1', '', `/-- Every toy graph has a toy cycle. -/
@[category research open, AMS 5]
theorem erdos_1 : True := by
  sorry

/-- A solved variant. -/
@[category research solved, AMS 5]
theorem erdos_1.variants.easy : True := by
  trivial`) },
  { path: 'ErdosProblems/3.lean', text: lean('Erdős Problem 3', '', `/-- Every toy set has a toy progression. This was conjectured by Zzyzx. -/
@[category research open, AMS 5 11]
theorem erdos_3 : True := by
  sorry`) },
  { path: 'OEIS/123.lean', text: lean('Toy sequence conjecture', 'The sequence counts toy objects of size $n$.\n', `/-- Every term of the toy sequence is odd. - _Zzyzx Qwerty_, Jul 01 2010 -/
@[category research open, AMS 11]
theorem OeisA000123.conjecture : True := by
  sorry`) },
  { path: 'Millennium/Toy.lean', text: lean('The Toy Conjecture', '', `/-- The toy conjecture: every toy $x \\in \\mathbb{N}$ has $\\tau(x)^{2} \\leq x$. -/
set_option maxHeartbeats 0 in
@[category research open, AMS 11 14]
theorem toy_weak : True := by
  sorry`) },
  { path: 'Arxiv/2501.00001/Toy.lean', text: lean('Toy paper problems', 'SECRET-REF-TEXT wrote this paper.\n', `/-- A toy lemma holds, from Qwerty. -/
@[category research open, AMS 68]
theorem toy_lemma : True := by
  sorry

/-- A second toy question. -/
@[category research open, AMS 68]
theorem toy_question : True := by
  sorry`) },
  { path: 'Wikipedia/Solved.lean', text: lean('A solved toy', '', `/-- Done. -/
@[category research solved, AMS 5]
theorem toy_done : True := by
  trivial`) },
];

/** A ustar archive the way GitHub serves one: a long path in a pax header, another split into prefix and name. */
function tar(files: { path: string; text: string }[]): Uint8Array {
  const block = (name: string, size: number, type: string, prefix = '') => {
    const h = Buffer.alloc(512);
    h.write(name.slice(0, 100), 0, 'utf8');
    h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
    h.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
    h.write('00000000000\0', 136); h.write('        ', 148); h.write(type, 156);
    h.write('ustar\0', 257); h.write('00', 263);
    if (prefix) h.write(prefix, 345, 'utf8');
    return h;
  };
  const pad = (b: Buffer) => Buffer.concat([b, Buffer.alloc((512 - (b.length % 512)) % 512)]);
  const parts: Buffer[] = [block('pax_global_header', 0, 'g')];
  files.forEach((f, i) => {
    const body = Buffer.from(f.text);
    if (i % 2 === 0) {
      let rec = ` path=${f.path}\n`;
      rec = `${rec.length + String(rec.length + 2).length}${rec}`;
      parts.push(block('PaxHeader', rec.length, 'x'), pad(Buffer.from(rec)), block('truncated', body.length, '0'), pad(body));
    } else {
      const cut = f.path.lastIndexOf('/');
      parts.push(block(f.path.slice(cut + 1), body.length, '0', f.path.slice(0, cut)), pad(body));
    }
  });
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}
const ROOT = 'formal-conjectures-main/FormalConjectures/';
const TAR = tar([...FC.map((f) => ({ path: ROOT + f.path, text: f.text })), { path: 'formal-conjectures-main/README.md', text: 'not Lean' }]);

const fakeFetch = (yaml: string, gz: Uint8Array, seen: string[] = []) => (async (url: string) => {
  seen.push(String(url));
  return String(url) === SCOUT_SOURCES.erdos.url ? new Response(yaml) : String(url) === SCOUT_SOURCES.fc.url ? new Response(gz) : new Response('', { status: 404 });
}) as unknown as typeof fetch;

const catalogue = (): ScoutCatalogue => ({ read: '2026-11-01', erdos: parseErdosYaml(YAML), fc: parseFormalConjectures(FC) });
const home = () => { const h = mkdtempSync(join(tmpdir(), 'scout-')); mkdirSync(join(h, 'scout')); writeFileSync(join(h, 'scout', 'catalogue.json'), JSON.stringify(catalogue())); return h; };

describe('the problem scout', () => {
  it('reads only the safe fields: notes, reference lists and crediting sentences never come out', () => {
    const erdos = parseErdosYaml(YAML);
    expect(erdos.map((e) => e.number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(erdos[0]).toEqual({ number: 1, prize: '$500', status: 'falsifiable', updated: '2025-08-31', formalized: true, oeis: ['A000001'], tags: ['graph theory', 'cycles'], name: 'toy cycle conjecture' });
    expect(erdos[1].prize).toBeUndefined(); // "no"
    expect(erdos[4].status).toBe('open (lean)');
    const fc = parseFormalConjectures(FC);
    expect(fc.map((f) => f.path)).toEqual(['ErdosProblems/1.lean', 'ErdosProblems/3.lean', 'OEIS/123.lean', 'Millennium/Toy.lean', 'Arxiv/2501.00001/Toy.lean']); // the solved file has nothing open
    expect(fc[0].open.map((o) => o.name)).toEqual(['erdos_1']);
    expect(fc[1].open[0]).toMatchObject({ name: 'erdos_3', statement: 'Every toy set has a toy progression.', ams: [5, 11] });
    expect(fc[2]).toMatchObject({ title: 'Toy sequence conjecture', summary: 'The sequence counts toy objects of size $n$.', open: [{ statement: 'Every term of the toy sequence is odd.' }] });
    expect(fc[3].open[0]).toMatchObject({ name: 'toy_weak', ams: [11, 14] }); // after a set_option line
    expect(fc[4].summary).toBeUndefined(); // a paper's description is not read
    expect(fc[4].open[0].statement).toBeUndefined(); // the only sentence credits someone
    expect(JSON.stringify([erdos, fc])).not.toMatch(PLANTED);
  });

  it('unpacks a GitHub source archive in memory, pax paths and ustar prefixes alike', () => {
    const files = readTarGz(TAR, (p) => p.endsWith('.lean'));
    expect(files.map((f) => f.path)).toEqual(FC.map((f) => ROOT + f.path));
    expect(files[2].text).toBe(FC[2].text);
    expect(readTarGz(TAR, () => true, 5)).toEqual([]); // nothing over the size cap
  });

  it('ranks into lanes: finite and checkable first, prizes and famous problems as moonshots, Lean-stated as formal', () => {
    const ranked = rankCatalogue(catalogue());
    const by = Object.fromEntries(ranked.map((c) => [c.id, c]));
    expect(Object.keys(by).sort()).toEqual(['erdos:1', 'erdos:2', 'erdos:3', 'erdos:4', 'erdos:7', 'erdos:8', 'fc:Arxiv/2501.00001/Toy.lean', 'fc:Millennium/Toy.lean', 'fc:OEIS/123.lean']);
    // "open (Lean)" (a Lean solution awaiting a human reading) and proved problems are not open.
    expect(by['erdos:1']).toMatchObject({ lane: 'moonshot', title: 'Erdős problem #1: toy cycle conjecture', prize: '$500', statement: 'Every toy graph has a toy cycle.', check: { kind: 'finite_search', theorem: 'erdos_1' } });
    expect(by['erdos:2']).toMatchObject({ lane: 'quick_win', check: { kind: 'finite_search' }, why: ['If it is true, one finite example proves it, and a computer can check an example'] });
    expect(by['erdos:3']).toMatchObject({ lane: 'formal', prize: '£25', check: { kind: 'lean', theorem: 'erdos_3' } });
    expect(by['erdos:4']).toMatchObject({ lane: 'needs_check', check: { kind: 'none' } });
    expect(by['erdos:7']).toMatchObject({ lane: 'needs_check', title: 'Erdős problem #7' });
    expect(by['erdos:7'].score).toBeLessThan(by['erdos:2'].score);
    expect(by['erdos:8'].why[0]).toMatch(/finite/);
    expect(by['fc:Millennium/Toy.lean']).toMatchObject({ lane: 'moonshot', prize: '$1,000,000', title: 'The Toy Conjecture', field: 'number theory' });
    expect(by['fc:OEIS/123.lean']).toMatchObject({ lane: 'formal', statement: 'Every term of the toy sequence is odd.' });
    expect(by['fc:Arxiv/2501.00001/Toy.lean']).toMatchObject({ statement: 'A second toy question.', check: { theorem: 'toy_question' } });
    expect(by['erdos:1'].sources.map((s) => s.url)).toEqual(['https://www.erdosproblems.com/1', 'https://github.com/teorth/erdosproblems', 'https://github.com/google-deepmind/formal-conjectures/blob/main/FormalConjectures/ErdosProblems/1.lean']);
    // Deterministic, and everything shown passes the network's personal-data check.
    expect(rankCatalogue(catalogue())).toEqual(ranked);
    for (const c of ranked) {
      expect(scrub({ c, idea: ideaFor(c) }, { level: 'standard' }).ok, c.id).toBe(true);
      expect(SCOUT_ID.test(c.id), c.id).toBe(true);
    }
    expect(JSON.stringify(ranked.map((c) => [c, ideaFor(c)]))).not.toMatch(PLANTED);
  });

  it('ids are a fixed shape, so a proposal can only point at a suggestion', () => {
    for (const ok of ['erdos:1', 'fc:OEIS/123.lean', 'fc:Arxiv/2501.00001/Toy.lean', 'seed:ramsey_graph']) expect(SCOUT_ID.test(ok), ok).toBe(true);
    for (const bad of ['erdos:x', 'erdos:123456', 'fc:../x.lean', 'fc:OEIS/../x.lean', 'fc:OEIS/<b>.lean', 'fc:OEIS/x.txt', 'seed:Bad', 'http://x', '']) expect(SCOUT_ID.test(bad), bad).toBe(false);
  });

  it('turns a suggestion into an idea that says how it would be checked', () => {
    const by = Object.fromEntries(rankCatalogue(catalogue()).map((c) => [c.id, c]));
    expect(ideaFor(by['erdos:1']).done).toBe("A counterexample found by search passes a machine check written for it, or a Lean proof of formal-conjectures' erdos_1 builds with no sorry");
    expect(ideaFor(by['erdos:2']).done).toBe('An example found by search passes a machine check written for it');
    expect(ideaFor(by['erdos:8']).done).toBe('The finite case analysis found by search passes a machine check written for it');
    expect(ideaFor(by['erdos:3']).done).toMatch(/Lean proof \(or disproof\) of formal-conjectures' erdos_3 builds against it with no sorry and only the standard axioms/);
    expect(ideaFor(by['erdos:4']).done).toBe('A precise statement exists that a machine can check');
    const idea = ideaFor(by['fc:OEIS/123.lean']);
    expect(idea).toMatchObject({ title: 'Toy sequence conjecture', realm: 'maths_physics' });
    expect(idea.goal).toMatch(/^Every term of the toy sequence is odd\.\n\n.+\n\nSource \(read 2026-11-01\): https:\/\/github\.com\/google-deepmind\/formal-conjectures\/blob\/main\/FormalConjectures\/OEIS\/123\.lean\nText from google-deepmind\/formal-conjectures \(Apache-2\.0\)\.$/s);
    // The statement text is formal-conjectures' (Apache-2.0), and an Erdős proposal says so with a link to the file.
    expect(ideaFor(by['erdos:1']).goal).toMatch(/Source \(read 2026-11-01\): https:\/\/www\.erdosproblems\.com\/1\nText from google-deepmind\/formal-conjectures \(Apache-2\.0\): https:\/\/github\.com\/google-deepmind\/formal-conjectures\/blob\/main\/FormalConjectures\/ErdosProblems\/1\.lean$/);
    expect(ideaFor(by['erdos:2']).goal).not.toMatch(/Text from/); // no statement text, nothing to credit
  });

  it('refreshes from the public sources, keeps only parsed fields, and keeps its copy when a source fails', async () => {
    const h = mkdtempSync(join(tmpdir(), 'scout-'));
    const seen: string[] = [];
    const s = new Scout(h, fakeFetch(YAML, TAR, seen));
    expect(s.catalogue()).toBeNull();
    expect(s.list().items.length).toBe(0); // the network's own problems are never suggested again
    expect(await s.refresh(new Date('2026-11-02T10:00:00Z'))).toEqual({ erdos: 8, fc: 5, read: '2026-11-02' });
    expect(seen.sort()).toEqual([SCOUT_SOURCES.erdos.url, SCOUT_SOURCES.fc.url].sort());
    const disk = readFileSync(join(h, 'scout', 'catalogue.json'), 'utf8');
    expect(disk).not.toMatch(PLANTED);
    expect(existsSync(join(h, 'scout', 'catalogue.json.tmp'))).toBe(false);
    expect(s.age(new Date('2026-11-09T10:00:00Z'))).toBe(7);
    // An empty or failing source never replaces a good copy.
    const empty = new Scout(h, fakeFetch('', TAR));
    await expect(empty.refresh()).rejects.toThrow(/came back empty/);
    await expect(new Scout(h, fakeFetch(YAML, new Uint8Array(0))).refresh()).rejects.toThrow();
    await expect(new Scout(h, (async () => new Response('', { status: 503 })) as unknown as typeof fetch).refresh()).rejects.toThrow(/HTTP 503/);
    expect(readFileSync(join(h, 'scout', 'catalogue.json'), 'utf8')).toBe(disk);
    expect(new Scout(h).catalogue()?.read).toBe('2026-11-02');
  });

  it('lists by lane, search words and realm; leaves out what is not yet checkable unless asked', () => {
    const s = new Scout(home());
    const r = s.list();
    expect(r.read).toBe('2026-11-01');
    expect(r.counts).toEqual({ quick_win: 2, moonshot: 2, formal: 3, needs_check: 0 });
    expect(r.items.map((c) => c.id)).not.toContain('erdos:4');
    expect(r.items.some((c) => c.on_network)).toBe(false);
    expect(s.list({ lane: 'needs_check' }).items.map((c) => c.id).sort()).toEqual(['erdos:4', 'erdos:7']);
    const all = s.list({ all: true, limit: 200 });
    expect(all.items.some((c) => c.id.startsWith('seed:'))).toBe(true);
    expect(all.counts.needs_check).toBe(2);
    expect(s.list({ q: 'toy SEQUENCE' }).items.map((c) => c.id)).toEqual(['fc:OEIS/123.lean']);
    expect(s.list({ realm: 'life_sciences' }).items).toEqual([]);
    expect(s.list({ limit: 1 }).items.length).toBe(1);
    expect(s.get('erdos:2')?.lane).toBe('quick_win');
    // Ties break by id, so every computer shows the same order.
    expect(s.list({ limit: 200 }).items.map((c) => c.id)).toEqual(new Scout(home()).list({ limit: 200 }).items.map((c) => c.id));
  });

  it('gives agents a way to scout realms with no catalogue, to the network’s naming rule', () => {
    const b = scoutingBrief('life_sciences');
    expect(b).toMatch(/No catalogue for life_sciences/);
    expect(b).toMatch(/public source URL and the date you read it/);
    expect(b).toMatch(/public @handle or an organisation: never a personal name/);
    expect(b).toMatch(/proposing is their call/);
  });
});

describe('the scout in the app, the CLI and for agents', () => {
  let h: string, hub: Hub, web: WebServer, browser: Browser | undefined;
  const person = LocalSigner.generate();
  const post = async (body: Record<string, unknown>) => {
    const rec = await signRecord({ kind: 'proposal', body, context: { task: String(body.title), domain: ['maths_physics'], environment: 'human (browser)' } }, person);
    const r = await fetch(`${web.url}/api/records`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(rec) });
    return { status: r.status, body: await r.json() };
  };
  const get = async (p: string) => (await fetch(web.url + p)).json();

  beforeAll(async () => {
    h = home();
    process.env.CONSTELLATE_HOME = h;
    process.env.CONSTELLATE_SCOUT_REFRESH = 'off';
    hub = new Hub({ signer: LocalSigner.generate(), preview: false });
    web = new WebServer(hub);
    registerAppRoutes(web, { scout: new Scout(h, (async () => { throw new Error('no network in tests'); }) as unknown as typeof fetch) });
    await web.listen(0);
  }, 60_000);
  afterAll(async () => { await browser?.close(); await web?.close(); delete process.env.CONSTELLATE_SCOUT_REFRESH; });

  it('serves the lanes, and marks a suggestion once someone has proposed it', async () => {
    const r = await get('/api/scout?per_lane=6');
    expect(r.read).toBe('2026-11-01');
    expect(r.lanes.map((l: { lane: string }) => l.lane)).toEqual(['quick_win', 'moonshot', 'formal']);
    const quick = r.lanes[0];
    expect(quick.total).toBe(2);
    expect(quick.items[0]).toMatchObject({ id: 'erdos:2', idea: { done: 'An example found by search passes a machine check written for it' } });
    expect(quick.items[0].proposed).toBeUndefined();
    expect((await get('/api/scout?per_lane=6&all=1')).lanes.map((l: { lane: string }) => l.lane)).toContain('needs_check');
    expect((await get('/api/scout?lane=formal&limit=1')).items.length).toBe(1);

    const idea = { ...quick.items[0].idea, check: 'machine (test or benchmark)' };
    expect((await post({ ...idea, scout: '../../etc/passwd' })).body.error).toMatch(/scout must be the id of a suggested problem/);
    expect((await post({ ...idea, scout: 42 })).status).toBe(400);
    const ok = await post({ ...idea, scout: 'erdos:2' });
    expect(ok.status).toBe(200);
    const after = await get('/api/scout?per_lane=6');
    expect(after.lanes[0].items.find((c: { id: string }) => c.id === 'erdos:2').proposed).toBe(ok.body.accepted);
  });

  it('the CLI lists the lanes and prints an idea; it never posts', async () => {
    const run = (args: string[]) => promisify(execFile)(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/cli.ts', ...args], { env: { ...process.env, CONSTELLATE_HOME: h } });
    const list = (await run(['scout'])).stdout;
    expect(list).toMatch(/Quick wins: a machine checks an answer, or a finite search could settle it \(2\)/);
    expect(list).toMatch(/erdos:2 · number theory/);
    expect(list).toMatch(/Moonshots: big prizes and famous problems \(2\)/);
    expect(list).not.toMatch(/Not yet machine-checkable/);
    const idea = (await run(['scout', '--propose', 'fc:OEIS/123.lean'])).stdout;
    expect(idea).toMatch(/^Title: {2}Toy sequence conjecture$/m);
    expect(idea).toMatch(/^Done: {3}A Lean proof \(or disproof\)/m);
    expect(idea).toMatch(/press "Propose this"/);
    const missing = await run(['scout', '--propose', 'erdos:999']).catch((e) => e);
    expect(missing.stdout).toMatch(/No problem with id erdos:999/);
    expect(hub.node.store.ofKind('proposal').length).toBe(1); // only the one posted above
  }, 60_000);

  it('agents get problems_scout in full mode only; it reads, and briefs them for realms with no catalogue', async () => {
    const tools = async (mode: 'lean' | 'full') => {
      const server = createMcpServer(hub, { mode });
      const [a, b] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'claude-code', version: '1' });
      await Promise.all([server.connect(a), client.connect(b)]);
      return client;
    };
    expect((await (await tools('lean')).listTools()).tools.map((t) => t.name)).not.toContain('problems_scout');
    const client = await tools('full');
    const call = async (args: Record<string, unknown>) => JSON.parse(((await client.callTool({ name: 'problems_scout', arguments: args })).content as { text: string }[])[0].text);
    const r = await call({ lane: 'quick_win' });
    expect(r.read).toBe('2026-11-01');
    expect(r.items.map((c: { id: string }) => c.id)).toEqual(['erdos:2', 'erdos:8']);
    expect(r.items[0].idea.done).toBe('An example found by search passes a machine check written for it');
    expect(r.next).toMatch(/let them choose/);
    expect(r.scouting).toBeUndefined();
    const life = await call({ realm: 'life_sciences' });
    expect(life.items).toEqual([]);
    expect(life.scouting).toMatch(/never a personal name/);
    expect(JSON.stringify([r, life])).not.toMatch(PLANTED);
  });

  it('in the app: Suggested shows the lanes, Propose this fills the form, and it then says it is already an idea', async () => {
    const { chromium } = createRequire(import.meta.url)('playwright');
    browser = await chromium.launch();
    const page = await browser!.newPage({ viewport: { width: 1280, height: 900 } });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(web.url);
    await page.evaluate(() => { localStorage.setItem('onboarded', 'true'); localStorage.setItem('proposalsTab', JSON.stringify('scout')); });
    await page.goto(`${web.url}/#/proposals`);
    await page.waitForSelector('#scout-lanes');
    expect(await page.textContent('[data-ptab="scout"]')).toMatch(/Suggested\s*7/);
    const lanes = await page.textContent('#scout-lanes');
    expect(lanes).toMatch(/Quick wins/);
    expect(lanes).toMatch(/Erdős problem #8/);
    expect(lanes).not.toMatch(PLANTED);
    // Catalogue TeX reads as maths on a card: Unicode in italics, never the raw markup.
    expect(await page.textContent('#scout-lanes .math >> nth=0')).toBe('x ∈ ℕ');
    expect(lanes).toMatch(/τ\(x\)² ≤ x/);
    expect(lanes).not.toMatch(/\\(mathbb|tau|leq)/);
    // erdos:2 was proposed above, so it says so instead of inviting the same idea twice.
    expect(await page.locator('[data-goto-tab="ideas"]').count()).toBe(1);
    await page.click('[data-scout="erdos:8"]');
    await page.waitForSelector('#idea');
    expect(await page.inputValue('#i-title')).toBe('Erdős problem #8');
    expect(await page.inputValue('#i-done')).toBe('The finite case analysis found by search passes a machine check written for it');
    expect(await page.inputValue('#i-goal')).toMatch(/Source \(read 2026-11-01\): https:\/\/www\.erdosproblems\.com\/8/);
    expect(await page.textContent('#idea')).toMatch(/Filled in from a public catalogue/);
    await page.click('#idea button.primary');
    await page.waitForFunction(() => document.querySelector('#toast')?.textContent?.includes('Proposed'));
    const posted = hub.node.store.ofKind('proposal').map((s) => s.rec.body as { scout?: string; done?: string }).find((b) => b.scout === 'erdos:8');
    expect(posted?.done).toMatch(/finite case analysis/);
    // Searching redraws the lists from the whole catalogue.
    await page.evaluate(() => localStorage.setItem('proposalsTab', JSON.stringify('scout')));
    await page.goto('about:blank');
    await page.goto(`${web.url}/#/proposals`);
    await page.waitForSelector('#scout-q');
    expect(await page.locator('[data-goto-tab="ideas"]').count()).toBe(2);
    await page.fill('#scout-q', 'toy sequence');
    await page.waitForFunction(() => !document.querySelector('#scout-lanes')?.textContent?.includes('Erdős problem #8'));
    expect(await page.textContent('#scout-lanes')).toMatch(/Toy sequence conjecture/);
    expect(errors).toEqual([]);
  }, 120_000);
});
