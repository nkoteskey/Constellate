/**
 * Build the static site for GitHub Pages: the demo network (with Saorsa Labs'
 * public history) frozen into JSON files, the app served as plain files, search
 * and signature checks running in the browser. Usage: npx tsx scripts/build-static.mts [outDir]
 */
import { mkdirSync, writeFileSync, readFileSync, cpSync, existsSync, rmSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedDemo } from '../src/demo.js';
import { WebServer } from '../src/web/server.js';
import { registerAppRoutes } from '../src/web/app.js';
import { registerEconomyRoutes } from '../src/economy/routes.js';
import type { StoredRecord } from '../src/store/records.js';
import { topicContext } from '../src/services/ledger.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(process.argv[2] ?? join(root, 'site'));
const pub = join(root, 'src/web/public');

process.env.CONSTELLATE_DEMO = '1';
const t0 = Date.now();
const demo = await seedDemo({ knowledge: 'all' });
for (let i = 0; i < 6; i++) await demo.tick();
const web = new WebServer(demo.viewer);
registerAppRoutes(web);
registerEconomyRoutes(web, demo.viewer.economy!);
await web.listen(0);

if (existsSync(out)) rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const write = (rel: string, data: unknown) => { const f = join(out, rel); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, typeof data === 'string' ? data : JSON.stringify(data)); };
const get = async (p: string) => { const r = await fetch(web.url + p); if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`); return r.json(); };
const mirror = async (p: string) => write(`${p.replace(/^\//, '')}.json`, await get(p));

// ── Data ───────────────────────────────────────────────────────────
const sky = await get('/api/sky');
write('api/sky.json', sky);
for (const p of ['/api/graph', '/api/proposals', '/api/deliberations', '/api/people', '/api/teams', '/api/metrics', '/api/ideas', '/api/galleries', '/api/challenges', '/api/work/next', '/api/court']) await mirror(p);
for (const g of await get('/api/galleries')) await mirror(`/api/galleries/${g.id}`);
for (const p of sky.problems) {
  if (p.kind === 'deliberation') { await mirror(`/api/deliberations/${p.id}`); continue; }
  for (const x of [`/api/problems/${p.id}/page`, `/api/problems/${p.id}`, `/api/chat/${p.id}`, `/api/huddle/${p.id}`, `/api/problems/${p.id}/help`]) await mirror(x);
}
for (const d of await get('/api/deliberations')) if (!existsSync(join(out, `api/deliberations/${d.id}.json`))) await mirror(`/api/deliberations/${d.id}`);
for (const person of await get('/api/people')) await mirror(`/api/me/${person.operator}`);
write('.well-known/agent-card.json', await get('/.well-known/agent-card.json'));

const store = demo.viewer.node.store;
let records = 0;
for (const s of store.all()) {
  if (s.visibility !== 'public' || s.rec.kind === 'memory') continue;
  await mirror(`/api/records/${s.rec.id}`);
  records++;
}
// A compact ledger index: search runs in the browser.
const ledger = store.all().filter((s) => s.visibility === 'public' && (s.rec.kind === 'failure' || s.rec.kind === 'answer')).map((s) => {
  const b = s.rec.body as Record<string, any>;
  const t = demo.viewer.trust.explain(s);
  return {
    id: s.rec.id, kind: s.rec.kind, task: s.rec.context.task, domain: s.rec.context.domain, environment: s.rec.context.environment,
    approach: b.approach, original: b.original, applies_when: b.applies_when, headline: b.headline, outcome: b.outcome, error_summary: b.error_summary, question: b.question, answer: b.answer, proof: b.proof,
    confirmations: t.confirmations, contradictions: t.contradictions, evidence: s.rec.evidence,
    fixed_by: s.rec.kind === 'failure' ? store.referencing(s.rec.id, 'answer').map((a) => a.rec.id) : undefined,
    neighbours: demo.viewer.graph.neighbours(s.rec.id, 3).map((n) => ({ id: n.id, link: n.link, kind: n.kind, title: n.title.slice(0, 140) })),
  };
});
// What the network learned: the latest summary per cluster, from "sleep".
const latest = new Map<string, StoredRecord>();
for (const s of store.ofKind('summary')) { const k = (s.rec.body as { cluster: string }).cluster; const p = latest.get(k); if (!p || p.rec.created < s.rec.created) latest.set(k, s); }
const learned = [...latest.values()].map((s) => {
  const b = s.rec.body as { title: string; summary: string; members: string[]; realms: string[] };
  return { id: s.rec.id, title: b.title, summary: b.summary, sources: b.members.length, realms: b.realms, domain: s.rec.context.domain, members: b.members.slice(0, 5), ...topicContext(store, b.members) };
});
const skills = store.ofKind('skill').map((s) => { const b = s.rec.body as { name: string; description: string; capabilities: string[] }; return { id: s.rec.id, name: b.name, description: b.description, capabilities: b.capabilities, source: s.rec.evidence[0] ?? null }; });
write('api/ledger.json', { built: new Date().toISOString(), records: ledger, learned, skills });

// ── App files ──────────────────────────────────────────────────────
for (const f of ['app.js', 'identity.js', 'logo.svg', 'style.css', 'embed.html', 'js', 'fonts']) cpSync(join(pub, f), join(out, f), { recursive: true });
let html = readFileSync(join(pub, 'index.html'), 'utf8')
  .replaceAll('href="/', 'href="./').replaceAll('src="/', 'src="./').replaceAll('"/vendor/', '"./vendor/')
  .replace('<script type="module"', '<script>window.__CONSTELLATE_STATIC__ = true;</script>\n<script type="module"');
write('index.html', html);
write('style.css', readFileSync(join(pub, 'style.css'), 'utf8').replaceAll('url("/fonts/', 'url("fonts/'));
write('embed.html', readFileSync(join(pub, 'embed.html'), 'utf8')
  .replace('fetch(`/api/problems/${id}`)', 'fetch(`api/problems/${id}.json`)')
  .replace('fetch(`/api/deliberations/${id}`)', 'fetch(`api/deliberations/${id}.json`)')
  .replace("const es = new EventSource('/api/events');", "const es = {}; // static preview: no live events")
  .replaceAll('href="/#/', 'href="./#/'));
write('.nojekyll', '');

// Browser crypto, served from the site itself (no CDN).
const vendor = (pkg: string, entry: string) => {
  const dir = dirname(fileURLToPath(import.meta.resolve(entry)));
  const copyJs = (from: string, to: string) => {
    for (const f of readdirSync(from)) {
      const p = join(from, f);
      if (statSync(p).isDirectory()) { if (!['node_modules', 'src', 'test', 'bench', 'types'].includes(f)) copyJs(p, join(to, f)); }
      else if (f.endsWith('.js')) { mkdirSync(to, { recursive: true }); cpSync(p, join(to, f)); }
    }
  };
  copyJs(dir, join(out, 'vendor', pkg));
};
vendor('@noble/post-quantum', '@noble/post-quantum/ml-dsa.js');
vendor('@noble/hashes', '@noble/hashes/sha2.js');
vendor('@noble/curves', '@noble/curves/utils.js');
vendor('cborg', 'cborg');

await web.close();
const size = (d: string): number => readdirSync(d).reduce((n, f) => { const p = join(d, f); return n + (statSync(p).isDirectory() ? size(p) : statSync(p).size); }, 0);
console.log(`static site: ${out}\n  ${sky.problems.length} problems and debates, ${ledger.length} lessons searchable, ${learned.length} distilled by sleep, ${records} signed records, ${(size(out) / 1e6).toFixed(1)} MB, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
process.exit(0);
