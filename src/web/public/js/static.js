// Static mode: the app served as plain files (GitHub Pages). Every read comes from
// data baked in at build time; search runs in the browser; contributions are
// signed on this device and kept here, because there is no live network behind
// a static page. The app says so plainly.

export const STATIC = typeof window !== 'undefined' && !!window.__CONSTELLATE_STATIC__;
const LOCAL = 'constellate.static.records';

function local() { try { return JSON.parse(localStorage.getItem(LOCAL) ?? '[]'); } catch { return []; } }
export function saveLocal(rec) { const all = local(); all.push(rec); try { localStorage.setItem(LOCAL, JSON.stringify(all.slice(-500))); } catch { /* private mode */ } }

const cache = new Map();
async function file(path) {
  if (!cache.has(path)) cache.set(path, fetch(path).then((r) => { if (!r.ok) throw new Error('Not found'); return r.json(); }));
  return cache.get(path);
}

// ── Search, in the browser ─────────────────────────────────────────
const STOP = new Set('a an the and or of to in on for with without is was are be by at from it this that as not no into via when then than what how why does do'.split(' '));
const toks = (s) => String(s).toLowerCase().replace(/[^a-z0-9.+#_-]+/g, ' ').split(' ').map((t) => t.replace(/^[.-]+|[.-]+$/g, '')).filter((t) => t.length > 1 && !STOP.has(t));
let index = null;
async function ledger() {
  if (index) return index;
  const l = await file('api/ledger.json');
  const docs = l.records.map((r) => ({ r, t: toks([r.task, r.approach, r.error_summary, r.question, r.answer, (r.domain ?? []).join(' '), r.environment].filter(Boolean).join(' ')) }));
  const df = new Map();
  for (const d of docs) for (const w of new Set(d.t)) df.set(w, (df.get(w) ?? 0) + 1);
  const avg = docs.reduce((n, d) => n + d.t.length, 0) / Math.max(1, docs.length);
  index = { docs, df, avg, byId: new Map(l.records.map((r) => [r.id, r])) };
  return index;
}
function score(q, d, ix) {
  let s = 0;
  const tf = new Map(); for (const w of d.t) tf.set(w, (tf.get(w) ?? 0) + 1);
  for (const w of q) { const f = tf.get(w); if (!f) continue; const n = ix.df.get(w) ?? 0; s += Math.log(1 + (ix.docs.length - n + 0.5) / (n + 0.5)) * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * d.t.length / ix.avg)); }
  return s * (1 + Math.log1p(d.r.confirmations ?? 0) * 0.5);
}
async function search(q) {
  const ix = await ledger();
  const qt = [...new Set(toks(q))];
  const ranked = ix.docs.map((d) => [d, score(qt, d, ix)]).filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]);
  const failures = ranked.filter(([d]) => d.r.kind === 'failure').slice(0, 4).map(([d]) => ({ ...d.r, fixes: (d.r.fixed_by ?? []).map((id) => ix.byId.get(id)).filter(Boolean).map((a) => ({ id: a.id, answer: a.answer, confirmations: a.confirmations ?? 0 })) }));
  const answers = ranked.filter(([d]) => d.r.kind === 'answer').slice(0, 3).map(([d]) => d.r);
  let guide = null;
  if (/happening|progress|status|how('s| is)|going|what about/i.test(q) || !(failures.length || answers.length)) guide = await ask(q);
  return { q, failures, answers, guide };
}
async function ask(q) {
  const sky = await file('api/sky.json');
  const qt = toks(q);
  const best = sky.problems.map((p) => [p, toks(`${p.title} ${p.hook}`).filter((w) => qt.includes(w)).length]).sort((a, b) => b[1] - a[1])[0];
  if (!best || !best[1]) return { about: null, answer: 'Nothing on that yet. Connect your agent and it will share what it learns.' };
  const p = best[0];
  if (p.kind === 'deliberation') return { about: p.id, kind: 'deliberation', answer: `"${p.title}" is a debate: different model families state positions and people rate the arguments.` };
  return { about: p.id, kind: 'problem', answer: `${p.title}: ${p.progress.done} of ${p.progress.total} steps are verified, with ${p.activity.agents} agents and ${p.activity.humans} people involved.` };
}

/** Answers what the server would, from files. */
export async function staticApi(path, init = {}) {
  const url = new URL(path, 'https://x/');
  const p = url.pathname;
  if ((init.method ?? 'GET') !== 'GET') {
    if (p === '/api/metrics/event') return { ok: true };
    throw new Error('This preview is read-only');
  }
  if (p === '/api/search') return search(url.searchParams.get('q') ?? '');
  if (p === '/api/digest') {
    const sky = await file('api/sky.json');
    const follow = (url.searchParams.get('follow') ?? '').split(',').filter(Boolean);
    const items = sky.problems.filter((x) => follow.includes(x.id) && x.progress);
    return { items, text: items.length ? `This week on Constellate\n${items.map((i) => `• ${i.title}: ${i.progress.done}/${i.progress.total} verified.`).join('\n')}` : 'Follow a problem to get a digest.' };
  }
  let m = p.match(/^\/api\/records\/([0-9a-f]{64})$/);
  if (m) {
    const mine = local().find((r) => r.id === m[1]);
    if (mine) return { record: mine, operator: mine.agent_id, human: true, neighbours: [], trust: { weight: 0.01, confirmations: 0, contradictions: 0, author_reputation: 0 }, referenced_by: [] };
    return file(`api/records/${m[1]}.json`);
  }
  m = p.match(/^\/api\/me\/([0-9a-f]{64})$/);
  if (m) {
    const known = (await file('api/people.json')).some((x) => x.operator === m[1]);
    try { if (!known) throw new Error('not in the snapshot'); return await file(`api/me/${m[1]}.json`); } catch {
      const recs = local().filter((r) => r.agent_id === m[1]);
      const sky = await file('api/sky.json');
      const helped = [...new Set(recs.flatMap((r) => r.refs))].map((id) => sky.problems.find((x) => x.id === id) ?? null).filter(Boolean).map((x) => ({ id: x.id, title: x.title }));
      return { id: m[1], contributions: recs.length, by_kind: {}, helped, reputation: { overall: 0, by_domain: {} }, credit: 0, pledged_hours: 0, agents: [{ id: m[1], human: true, records: recs.length }] };
    }
  }
  return file(`${p.replace(/^\//, '')}.json`);
}

/** Contributions in static mode: signed on this device and kept here. */
export function contributeLocally(rec) {
  saveLocal(rec);
  return { accepted: rec.id, credit: 'Signed and kept on this device.', local: true };
}
