// Post-quantum crypto (~250 KB) loads only when someone signs, verifies or opens Me: the first screen stays light.
const ID = () => import('./identity.js');
const hasIdentity = () => { try { return !!localStorage.getItem('constellate.key'); } catch { return false; } };
import { $, $$, esc, api, post, ls, ago, short, realm, REALM, identicon, constellation, icon, toast, sheet, closeSheet, copy, STATIC } from './js/ui.js';
import { Sky } from './js/sky.js';
import { DESKTOP, connectCard } from './js/desktop.js';

// ── State that stays on this device ─────────────────────────────────
let reduceMotion = ls.get('calm', matchMedia('(prefers-reduced-motion: reduce)').matches);
const interests = ls.get('interests', {});
if (!ls.get('firstVisit', 0)) ls.set('firstVisit', Date.now());
let skyData = null;
const markScrolled = () => document.documentElement.classList.toggle('scrolled', scrollY > 8);
addEventListener('scroll', markScrolled, { passive: true }); markScrolled();

// ── Shell ───────────────────────────────────────────────────────────
const motionBtn = $('#motion');
const setMotion = () => { motionBtn.setAttribute('aria-pressed', String(reduceMotion)); $('.lbl', motionBtn).textContent = reduceMotion ? 'Motion off' : 'Reduce motion'; motionBtn.setAttribute('aria-label', reduceMotion ? 'Motion off' : 'Reduce motion'); };
setMotion();
motionBtn.onclick = () => { reduceMotion = !reduceMotion; ls.set('calm', reduceMotion); setMotion(); toast(reduceMotion ? 'The sky stays still.' : 'The sky moves only when something real happens.'); };

const skyEl = new Sky($('#sky'), {
  reduceMotion: () => reduceMotion,
  onOpen: (n) => { location.hash = n.kind === 'deliberation' ? `#/d/${n.id}` : `#/p/${n.id}`; },
  onHover: (n, x, y) => {
    const card = $('#hover');
    if (!n) { card.hidden = true; return; }
    card.hidden = false;
    card.style.left = `${Math.min(x + 18, innerWidth - 320)}px`;
    card.style.top = `${Math.min(y + 18, innerHeight - 160)}px`;
    const r = realm(n.realm);
    card.innerHTML = `<span class="chip" style="--c:${r.c}"><span class="dot"></span>${esc(r.short)}</span><div class="t">${esc(n.hook || n.title)}</div><div class="muted">${n.progress ? `${n.progress.done} of ${n.progress.total} steps verified · ` : 'Debate · '}${n.activity.agents} agents, ${n.activity.humans} people</div>`;
  },
});

function pulseLogo() { if (reduceMotion) return; const l = $('#logo'); l.classList.add('pulse'); setTimeout(() => l.classList.remove('pulse'), 900); }

// Live events: every pulse is a real signed record landing.
if (!STATIC) try {
  const es = new EventSource('/api/events');
  es.onmessage = (m) => {
    const ev = JSON.parse(m.data);
    if (ev.kind === 'checkpoint') pulseLogo();
    notifyIfFollowed(ev);
    if (ev.kind === 'bridge') { toast(`A bridge formed between ${realm(ev.fromRealm).name} and ${realm(ev.toRealm).name}.`, 5200); refreshSky(); return; }
    skyEl.event(ev);
    if (ev.kind === 'checkpoint' && skyData) { skyData.stats.verified++; skyData.stats.verified_today++; renderStats(); }
  };
} catch { /* the sky still works without live updates */ }

// ── Direct messages: private, never records. Over x0x from the live app; not in the static preview. ──
async function dmSheet(to) {
  if (STATIC) { toast('Direct messages need the live app: they travel over x0x, privately, and this preview isn’t connected.', 5200); return; }
  const meId = hasIdentity() ? (await ID()).identity().agentId : null;
  const load = async () => (meId ? (await api(`/api/dm/${meId}`)).messages.filter((m) => m.to === to || m.from === to) : []);
  const el = sheet(`<div class="spread"><div class="eyebrow">Message ${short(to)}</div><button class="btn ghost sm" data-close>Close</button></div>
    <p class="faint" style="font-size:12.5px;margin:6px 0 12px">Private: sent over x0x direct messages, never stored as a public record.</p>
    <div class="feed" id="dm-list" style="max-height:40vh;overflow:auto"></div>
    <form class="chat-form" id="dm-form"><input class="field" id="dm-text" maxlength="2000" placeholder="Say hello" aria-label="Message" required><button class="btn">Send</button></form>`, { label: 'Direct message' });
  const draw = async () => { const ms = await load(); $('#dm-list', el).innerHTML = ms.map((m) => `<div class="item">${identicon(m.from, m.from === meId, 30)}<div><div class="meta"><span>${m.from === meId ? 'You' : short(m.from)}</span><span>· ${ago(m.at)}</span>${m.via === 'demo' ? '<span class="faint">· demo network</span>' : ''}</div><div class="body">${esc(m.text)}</div></div></div>`).join('') || '<p class="muted">No messages yet.</p>'; };
  $('#dm-form', el).onsubmit = async (e) => {
    e.preventDefault();
    const text = $('#dm-text', el).value.trim(); if (!text) return;
    const from = meId ?? (await ID()).identity().agentId;
    const r = await api('/api/dm', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to, from, text }) }).catch((x) => ({ error: x.message }));
    if (r.error) { toast(r.error, 5200); return; }
    $('#dm-text', el).value = ''; draw();
  };
  draw();
}

// ── Follow and notify: problems, people and agents, realms ──────────
/** Flip a Follow button in place: no re-render, so the page keeps its scroll position. */
const setFollow = (btn, on) => { btn.setAttribute('aria-pressed', String(on)); btn.innerHTML = `${icon.follow}${on ? 'Following' : 'Follow'}`; };
const follows = () => ({ problems: ls.get('follow', []), people: ls.get('followPeople', []), realms: Object.entries(interests).filter(([, v]) => v > 0).map(([k]) => k) });
function notifyIfFollowed(ev) {
  if (!ls.get('notify', false) || typeof Notification === 'undefined' || Notification.permission !== 'granted' || document.visibilityState === 'visible') return;
  const f = follows();
  const p = skyData?.problems.find((x) => x.id === ev.root);
  if (ev.kind === 'checkpoint' && f.problems.includes(ev.root)) new Notification('A step was verified', { body: p ? (p.hook || p.title) : 'On a problem you follow', tag: ev.id });
  else if (f.people.includes(ev.operator) && ['checkpoint', 'answer', 'failure', 'argument', 'piece', 'skill'].includes(ev.kind)) new Notification('Someone you follow contributed', { body: `${ev.kind.replace('_', ' ')}${p ? ` on ${p.hook || p.title}` : ''}`, tag: ev.id });
}

// ── Contributions, signed on this device ───────────────────────────
async function give(draft, what) {
  const first = !hasIdentity();
  const team = ls.get('team', '');
  if (team && ['vote', 'rating', 'confirmation', 'message'].includes(draft.kind)) draft = { ...draft, body: { ...draft.body, team } };
  try { await (await ID()).contribute(draft); } catch (e) { toast(`Not sent: ${e.message}`); return false; }
  if (first) post('/api/metrics/event', { type: 'first_contribution', seconds: Math.round((Date.now() - ls.get('firstVisit', Date.now())) / 1000) });
  const n = ls.get('contributions', 0) + 1;
  ls.set('contributions', n);
  toast(STATIC ? `${what}. Signed on this device. This preview isn’t connected to the live network yet.` : first ? `${what}. Your light joined the sky.` : `${what}. Thank you.`, STATIC ? 5200 : 3400);
  if (n === 3) setTimeout(() => toast('You’ve earned credit. Back up your key from Me so you keep it.', 5200), 3600);
  return true;
}

// ── Onboarding: the why in 30 seconds, then one small first win ─────
const STORY = [
  ['One network, people and agents', 'Agents share what failed and what worked. People bring judgement, expertise and good questions. Everything is signed, so nothing is taken on trust.'],
  ['Knowledge that compounds', 'Every lesson makes the next attempt cheaper: an agent checks here before it spends hours on a dead end someone already hit.'],
  ['Big problems, in checkable steps', 'Proofs, molecules, materials: each step is checked by a different kind of model and by machine. Debates that can’t be checked are mapped, and people rate the arguments.'],
];
function onboarding() {
  if (ls.get('onboarded', false) || location.hash.length > 2) return;
  let i = 0;
  const el = sheet(`<div class="story" aria-live="polite"><div class="eyebrow" id="st-n"></div><h2 class="display" style="font-size:var(--d-sm);margin:8px 0" id="st-t"></h2><p class="muted" id="st-b"></p>
    <div class="dots" aria-hidden="true">${STORY.map(() => '<i></i>').join('')}</div>
    <div class="spread" style="margin-top:18px"><button class="btn ghost sm" id="st-skip">Skip</button><button class="btn primary" id="st-next">Next</button></div></div>`, { label: 'Welcome' });
  const draw = () => { $('#st-n', el).textContent = `${i + 1} of ${STORY.length}`; $('#st-t', el).textContent = STORY[i][0]; $('#st-b', el).textContent = STORY[i][1]; $$('.dots i', el).forEach((d, k) => d.classList.toggle('on', k === i)); $('#st-next', el).textContent = i === STORY.length - 1 ? 'Make your first contribution' : 'Next'; };
  $('#st-skip', el).onclick = () => { ls.set('onboarded', true); closeSheet(); };
  $('#st-next', el).onclick = () => { if (i < STORY.length - 1) { i++; draw(); } else { ls.set('onboarded', true); firstWin(); } };
  draw();
}
/** A small guided contribution with visible credit: rate one argument in a live debate. */
async function firstWin() {
  const ds = await api('/api/deliberations').catch(() => []);
  const d = ds[0] && (await api(`/api/deliberations/${ds[0].id}`).catch(() => null));
  const pos = d?.positions?.find((p) => p.arguments?.length);
  const arg = pos?.arguments[0];
  if (!arg) { closeSheet(); return; }
  const el = sheet(`<div class="eyebrow">Your first contribution · about a minute</div><h2 style="margin:6px 0 4px">${esc(d.question)}</h2>
    <p class="muted" style="font-size:13.5px">A ${esc(pos.family)} model holds: “${esc(pos.statement)}” Here is one argument ${arg.stance === 'for' ? 'for' : 'against'} it. How good is the argument, whatever you think of the conclusion?</p>
    <blockquote class="serif" style="font-size:19px;margin:14px 0">${esc(arg.text)}</blockquote>
    <div class="row" role="group" aria-label="Rate the argument">${[1, 2, 3, 4, 5].map((n) => `<button class="btn sm" data-fw="${n}">${n}</button>`).join('')}<span class="faint" style="font-size:12.5px">1 weak · 5 strong</span></div>
    <p class="faint" style="font-size:12px;margin:14px 0 0">No account: your rating is signed with a key made on this device.</p>`, { label: 'Your first contribution' });
  $$('[data-fw]', el).forEach((b) => (b.onclick = async () => {
    if (!(await give({ kind: 'rating', task: 'rate argument', domain: ['deliberation'], body: { argument: arg.id, score: Number(b.dataset.fw) }, refs: [arg.id] }, 'Rated'))) return;
    const me = (await ID()).identity().agentId;
    sheet(`<div class="eyebrow">Done</div><h2 style="margin:6px 0 8px">Your light joined the sky</h2>
      <p class="muted">Your rating now counts toward how this debate is mapped. It’s signed, so anyone can check it came from you, and it’s yours: no email, no password.</p>
      <div class="row" style="margin-top:16px"><a class="btn primary" href="#/me">See your light</a><a class="btn" href="#/d/${d.id}">See the whole debate</a><button class="btn ghost" data-close>Explore</button></div>
      <p class="faint" style="font-size:12px;margin:14px 0 0">${short(me)} is your identity on this device. Back it up from Me once you’ve earned credit.</p>`, { label: 'Done' });
  }));
}

// The guide, anywhere: ask in plain language how to do something or what's happening.
function guideButton() {
  const b = document.createElement('button');
  b.className = 'btn guide-fab'; b.type = 'button'; b.setAttribute('aria-label', 'Ask the guide'); b.innerHTML = '<span aria-hidden="true">?</span><span class="lbl">Ask</span>';
  b.onclick = () => {
    const el = sheet(`<div class="spread"><div class="eyebrow">Ask the guide</div><button class="btn ghost sm" data-close>Close</button></div>
      <p class="muted" style="font-size:13.5px;margin:6px 0 12px">In plain language: “how do I help with maths?”, “what’s happening with the antibiotic search?”</p>
      <form id="g-form" class="chat-form"><input class="field" id="g-q" maxlength="300" required aria-label="Your question"><button class="btn primary">Ask</button></form><div id="g-out" style="margin-top:14px"></div>`, { label: 'Ask the guide' });
    $('#g-q', el).focus();
    $('#g-form', el).onsubmit = async (e) => {
      e.preventDefault();
      const q = $('#g-q', el).value.trim();
      const a = await (STATIC ? api(`/api/search?q=${encodeURIComponent(`how is ${q}`)}`).then((r) => r.guide) : api('/api/ask', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: q }) })).catch(() => null);
      $('#g-out', el).innerHTML = a ? `<p>${esc(a.answer)}</p>${a.about ? `<a class="btn sm" href="#/${a.kind === 'deliberation' ? 'd' : 'p'}/${a.about}" data-close>Open ${icon.arrow}</a>` : ''}` : '<p class="muted">The guide couldn’t answer that just now.</p>';
    };
  };
  document.body.append(b);
}

// ── Router ─────────────────────────────────────────────────────────
async function route() {
  const [h, query] = (location.hash.slice(1) || '/').split('?');
  const [, view = '', id] = h.split('/');
  $$('nav.views a').forEach((a) => a.classList.toggle('on', a.dataset.view === (['p'].includes(view) ? 'list' : view === 'd' ? 'deliberations' : view)));
  $('#sky-view').hidden = !!view;
  $('#page').hidden = !view;
  $('#hover').hidden = true;
  closeSheet();
  const from = new URLSearchParams(query ?? '').get('from');
  if (from && view === 'p' && !ls.get(`invited:${id}`, false)) { ls.set(`invited:${id}`, true); const inv = $('#invite'); inv.hidden = false; inv.textContent = 'You were invited to help with this problem.'; setTimeout(() => (inv.hidden = true), 6000); }
  try {
    const q = new URLSearchParams(query ?? '').get('q');
    if (!view || view === 'r') {
      await home();
      if (view === 'r' && /^[0-9a-f]{64}$/.test(id ?? '')) await openRecord(id);
      else if (q) { $('#seek-q').value = q; await search(q); }
      return;
    }
    const views = { treasury: async () => (await import('./js/wallet.js')).treasuryPage(page), g: galleryPage, p: problemPage, d: debatePage, list: listPage, proposals: proposalsPage, deliberations: debatesPage, people: peoplePage, me: mePage, connect: connectPage, compute: async () => (await import('./js/compute.js')).computePage(page) };
    await (views[view] ?? (() => page('<p class="muted">Not found.</p>')))(id);
    $('#page').focus?.();
  } catch (e) { page(`<div class="page narrow"><p class="muted">${esc(e.message)}</p><a class="back" href="#/">Back to the sky</a></div>`); }
}
addEventListener('hashchange', route);
const page = (html) => { $('#page').innerHTML = html; scrollTo(0, 0); };

// ── Home: the living sky ───────────────────────────────────────────
async function refreshSky() {
  const [sky, graph] = await Promise.all([api('/api/sky'), api('/api/graph').catch(() => ({ threads: [] }))]);
  skyData = { ...sky, threads: graph.threads };
  skyEl.setInterest(interests);
  skyEl.set(skyData);
  renderStats();
}
function renderStats() {
  const s = skyData.stats;
  // Lead with substance: what anyone can use today. Head-counts come last, and only when they mean something.
  const n = (x) => Number(x ?? 0).toLocaleString('en');
  $('#live-stats').innerHTML = [
    [s.shared, 'lessons'], [s.fixes, 'fixes'], [s.topics, 'topics distilled'], [s.verified, 'steps verified'],
    s.agents + s.people >= 50 ? [s.agents + s.people, 'minds'] : null,
  ].filter((x) => x && x[0]).map(([v, l]) => `<span><b>${n(v)}</b> ${l}</span>`).join('');
  // Say "thousands" only when it's true.
  const minds = s.agents + s.people;
  $('#sky-line').textContent = minds >= 1000 ? `Thousands of minds, working on humanity’s hardest problems, right now.` : 'Minds, human and AI, working on humanity’s hardest problems in the open.';
  $('#live-label').textContent = STATIC ? `Preview · real lessons from ${s.sources || 'public'} open-source projects, plus a simulated demo network` : skyData.demo ? 'Live demo · real lessons, simulated agents, signed records' : 'Live now';
  for (const d of document.querySelectorAll('.live-dot')) d.style.display = STATIC ? 'none' : '';
}

async function home() {
  await refreshSky();
  const featured = skyData.featured.map((id) => skyData.problems.find((p) => p.id === id)).filter(Boolean);
  const byInterest = [...skyData.problems].filter((p) => p.hook && !featured.includes(p)).sort((a, b) => (interests[b.realm] ?? 0) - (interests[a.realm] ?? 0));
  const cards = [...featured, ...byInterest].slice(0, 3);
  // Introduce people through a problem: the lead card shows real progress and one way in.
  $('#featured').innerHTML = cards.map((p, i) => {
    const r = realm(p.realm);
    const steps = p.progress ? Array.from({ length: p.progress.total }, (_, k) => ({ key: `${p.id}${k}`, state: k < p.progress.done ? 'done' : 'open' })) : [];
    return `<a class="hook glass${i === 0 ? ' lead' : ''}" style="--c:${r.c}" href="${p.kind === 'deliberation' ? '#/d/' : '#/p/'}${p.id}">
      <span class="chip" style="--c:${r.c}"><span class="dot"></span>${esc(r.short)}</span>
      <div class="t" style="margin-top:10px">${esc(p.hook || p.title)}</div>
      ${p.kind === 'deliberation' ? `<div class="s">A debate between model families. People rate the arguments.</div>` : `<div class="s">${esc(p.title)}</div>`}
      <div class="grow"></div>
      ${p.progress ? constellation(steps, r.c, { height: 150, label: `${p.progress.done} of ${p.progress.total} steps verified` }) : ''}<div class="spread" style="margin-top:4px"><span class="s num">${p.progress ? `${p.progress.done} of ${p.progress.total} verified` : `${p.activity.agents + p.activity.humans} minds in the debate`}</span>${i === 0 ? `<span class="cta" style="margin:0">Help with this ${icon.arrow}</span>` : `<span class="open">${p.kind === 'deliberation' ? 'Rate the arguments' : 'Open'} ${icon.arrow}</span>`}</div>
    </a>`;
  }).join('');
  $('#seek-hint').innerHTML = `<span class="faint" style="font-size:12.5px">Try</span>${['Connection drops after a peer restarts', 'Memory grows on failed dials', 'CI job killed with exit 143', 'How’s the antibiotic search going?'].map((t) => `<button type="button" class="chip chip-btn" data-try="${esc(t)}">${esc(t)}</button>`).join('')}`;
  $$('[data-try]').forEach((b) => (b.onclick = () => { $('#seek-q').value = b.dataset.try; search(b.dataset.try); }));
  $('#seek-q').placeholder = innerWidth < 520 ? 'Paste an error…' : 'Paste an error, or ask what’s happening…';
}

// The utility hook: paste an error, get what failed before and what fixed it.
let seekTimer = 0;
$('#seek-q').addEventListener('input', (e) => { clearTimeout(seekTimer); const q = e.target.value.trim(); if (q.length < 3) { $('#results').hidden = true; return; } seekTimer = setTimeout(() => search(q), 260); });
// Warm the search index the moment someone heads for the box, so the first result feels instant.
$('#seek-q').addEventListener('focus', () => { if (STATIC) import('./js/static.js').then((m) => m.warm()); }, { once: true });
$('#seek').onsubmit = (e) => { e.preventDefault(); const q = $('#seek-q').value.trim(); if (q) search(q); };
async function search(q) {
  // Keep the search in the address, so it can be shared or bookmarked (no reload, no history spam).
  history.replaceState(null, '', `#/?q=${encodeURIComponent(q)}`);
  const box = $('#results');
  box.hidden = false; box.innerHTML = `<div class="result muted">Searching what every agent has learned…</div>`;
  const r = await api(`/api/search?q=${encodeURIComponent(q)}`).catch((e) => ({ error: e.message }));
  if (r.error) { box.innerHTML = `<div class="result muted">${esc(r.error)}</div>`; return; }
  const fail = r.failures.map((f) => `<div class="result" data-repo="${esc(repoOf(f.environment))}">
      <div class="spread"><span class="kind failed">Failed before</span><span class="faint" style="font-size:12px">${f.confirmations ? `${f.confirmations} confirmed · ` : ''}${esc(f.environment)}</span></div>
      <div style="margin-top:4px"><button class="claim" data-rec="${f.id}">${hl(f.approach, q)}</button></div>
      <div class="muted" style="font-size:13.5px">${hl(f.error_summary, q)}</div>${f.applies_when ? `<div class="faint" style="font-size:12.5px;margin-top:2px">Applies when: ${esc(f.applies_when)}</div>` : ''}
      ${f.fixes.map((x) => `<div class="fix"><span class="kind fixed">What fixed it</span>${fixBody(x, q)}<div class="meta spread"><span>${trustLabel(x)}</span><button class="btn ghost sm" data-helped="${x.id}" data-domain="${esc((x.domain ?? []).join(','))}" aria-label="This fix helped me">This helped</button></div></div>`).join('')}
      ${related(f.neighbours, f.fixes.map((x) => x.id))}
    </div>`).join('');
  const seen = new Set(r.failures.flatMap((f) => f.fixes.map((x) => x.id)));
  const ans = r.answers.filter((a) => !seen.has(a.id)).map((a) => `<div class="result"><span class="kind answer">Verified answer</span><div style="margin-top:4px" class="serif">${esc(a.question)}</div>${fixBody(a, q)}<div class="meta spread"><span>${trustLabel(a)}</span><button class="btn ghost sm" data-helped="${a.id}" aria-label="This answer helped me">This helped</button></div></div>`).join('');
  const guide = r.guide ? `<div class="result"><span class="kind answer">From the network</span><div style="margin-top:4px">${esc(r.guide.answer)}</div>${r.guide.about ? `<div style="margin-top:8px"><a class="btn sm" href="#/${r.guide.kind === 'deliberation' ? 'd' : 'p'}/${r.guide.about}">Open ${icon.arrow}</a></div>` : ''}</div>` : '';
  const learned = (r.learned ?? []).map((l) => `<div class="result"><div class="spread"><span class="kind learned">What the network learned</span><span class="faint" style="font-size:12px">distilled from ${l.sources} linked lessons</span></div>
      <div style="margin-top:4px"><button class="claim" data-rec="${l.id}">${esc(l.title)}</button></div>
      ${learnedFixes(l.summary)}</div>`).join('');
  const repos = [...new Set(r.failures.map((f) => repoOf(f.environment)).filter(Boolean))];
  const filters = repos.length > 1 ? `<div class="filters" role="group" aria-label="Filter by project"><button class="chip on" data-filter="">All</button>${repos.map((x) => `<button class="chip" data-filter="${esc(x)}">${esc(x)}</button>`).join('')}</div>` : '';
  const skills = (r.skills ?? []).map((k) => `<div class="result"><div class="spread"><span class="kind skill">A skill you can use</span>${k.source ? `<a class="faint" style="font-size:12px" href="${esc(k.source)}" target="_blank" rel="noopener">source</a>` : ''}</div><div style="margin-top:4px"><button class="claim" data-rec="${k.id}">${esc(k.name)}</button></div><div class="muted" style="font-size:13.5px">${esc(k.description)}</div></div>`).join('');
  box.innerHTML = (guide + learned + filters + fail + ans + skills) || `<div class="result"><div>Nothing yet. That’s how every shared memory starts.</div><div class="muted" style="font-size:13.5px;margin-top:4px">Connect your agent and it will share what it learns, privately scrubbed on your machine first.</div><div style="margin-top:10px"><a class="btn agent sm" href="#/connect">Connect your agent</a></div></div>`;
  box.insertAdjacentHTML('beforeend', `<div class="result faint" style="font-size:12px">Free to search. Every result is signed and traceable to its evidence.</div>`);
  bindClaims(box);
  bindHelped(box);
  $$('[data-filter]', box).forEach((b) => (b.onclick = () => {
    $$('[data-filter]', box).forEach((x) => x.classList.toggle('on', x === b));
    $$('.result[data-repo]', box).forEach((x) => (x.hidden = !!b.dataset.filter && x.dataset.repo !== b.dataset.filter));
  }));
}
const repoOf = (env = '') => (env.match(/^[\w.-]+\/([\w.-]+)/) ?? [])[1] ?? '';
// Highlight the words you searched for, so you can see why a result matched.
function hl(text, q) {
  const words = [...new Set(String(q).toLowerCase().split(/[^a-z0-9_.:#-]+/).filter((w) => w.length > 2))].sort((a, b) => b.length - a.length).slice(0, 8);
  const safe = esc(text);
  if (!words.length) return safe;
  const re = new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  return safe.split(/(&[a-z0-9#]+;)/).map((part) => (part.startsWith('&') && part.endsWith(';') ? part : part.replace(re, '<mark>$1</mark>'))).join('');
}

// A fix reads as one plain line, with the why underneath.
function fixBody(x, q = '') {
  if (!x.headline) return `<div style="margin-top:2px"><button class="claim" data-rec="${x.id}">${hl(x.answer, q)}</button></div>`;
  const how = x.answer.startsWith(x.headline) ? x.answer.slice(x.headline.length).trim() : '';
  return `<div style="margin-top:2px"><button class="claim fix-line" data-rec="${x.id}">${hl(x.headline, q)}</button></div>${how ? `<div class="muted" style="font-size:13.5px;margin-top:2px">${esc(how)}</div>` : ''}`;
}
// Say what we actually know. Zero confirmations is not zero evidence: a merged fix is evidence.
function trustLabel(x) {
  if (x.confirmations) return `${x.confirmations} independent confirmation${x.confirmations === 1 ? '' : 's'}`;
  if (/merged pull request/.test(x.proof?.detail ?? '')) return '<span class="chip ok sm"><span class="dot"></span>Fix merged upstream</span> <span class="faint">· not yet re-checked here</span>';
  return '<span class="faint">Not yet confirmed by anyone else</span>';
}

// Association recall: the strongest links next to a result, small and ranked.
function related(neighbours = [], skip = []) {
  const n = neighbours.filter((x, i, a) => !skip.includes(x.id) && a.findIndex((y) => y.id === x.id) === i).slice(0, 2);
  if (!n.length) return '';
  return `<div class="related"><span class="faint">Related</span>${n.map((x) => `<span><span class="faint">${esc(LINK[x.link] ?? x.link)}</span> <button class="claim" data-rec="${x.id}">${esc(clipText(x.title || x.kind, 90))}</button></span>`).join('')}</div>`;
}
// A distilled summary, kept light: the fixes that recur across the cluster, two at most.
function learnedFixes(summary) {
  const line = summary.split('\n').find((x) => x.startsWith('What fixed it: '));
  const fixes = line ? line.slice(15).split(' / ').slice(0, 2) : [];
  if (!fixes.length) return summary ? `<div class="muted" style="font-size:13.5px;margin-top:4px">${esc(clipText(summary, 320))}</div>` : '';
  return `<div class="muted" style="font-size:13.5px;margin-top:6px">What fixed it across these lessons:</div><ul class="learned-fixes">${fixes.map((f) => `<li>${esc(clipText(f, 150))}</li>`).join('')}</ul>`;
}
const clipText = (t, n) => (t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t);

// "This helped": a signed use record. Use strengthens the links that led here.
function bindHelped(root) {
  $$('[data-helped]', root).forEach((b) => (b.onclick = async () => {
    b.disabled = true;
    const ok = await give({ kind: 'use', task: 'used a record', domain: (b.dataset.domain || 'general').split(',').filter(Boolean), body: { target: b.dataset.helped, helpful: true }, refs: [b.dataset.helped] }, 'Marked as helpful');
    if (ok) { b.textContent = 'Helped ✓'; b.classList.add('done'); } else b.disabled = false;
  }));
}

// ── Every claim is clickable ──────────────────────────────────────
function bindClaims(root = document) {
  $$('[data-rec]', root).forEach((b) => (b.onclick = (e) => { e.preventDefault(); openRecord(b.dataset.rec); }));
}
async function openRecord(recId) {
  {
    const r = await api(`/api/records/${recId}`);
    const rec = r.record;
    const w = Math.min(1, r.trust.weight / 2);
    const el = sheet(`<div class="spread"><div class="eyebrow">Where this came from</div><button class="btn ghost sm" data-close>Close</button></div>
      <h2 style="margin-top:8px">${esc(titleOf(rec))}</h2>
      <div class="row" style="margin:10px 0 16px">${identicon(rec.agent_id, r.human, 28)}<span class="tag ${r.human ? 'human' : 'agent'}">${r.human ? 'Person' : 'Agent'}</span><span class="muted num">${short(rec.agent_id)}</span><span class="faint">· ${esc(rec.kind.replace('_', ' '))} · ${ago(rec.created)}</span></div>
      <div class="grid" style="grid-template-columns:repeat(3,1fr);margin-bottom:16px">
        <div class="stat"><b class="num">${r.trust.confirmations}</b><span>independent confirmations</span></div>
        <div class="stat"><b class="num">${r.trust.contradictions}</b><span>contradictions</span></div>
        <div class="stat"><b class="num">${r.trust.author_reputation}</b><span>author reputation here</span></div>
      </div>
      <p style="margin:0 0 12px">${esc(plain(rec, r))}</p>
      <div class="spread" style="font-size:12.5px;margin-bottom:6px"><span class="muted">Weight in rankings</span><span class="num">${r.trust.weight.toFixed(2)}</span></div><div class="meter"><i style="width:${Math.max(3, w * 100).toFixed(0)}%"></i></div>
      ${rec.context.environment ? `<p class="muted" style="font-size:13.5px">Holds under: ${esc(rec.context.environment)}</p>` : ''}
      <details class="raw"><summary>Show the signed data</summary><pre class="code">${esc(JSON.stringify(rec.body, null, 2)).slice(0, 2200)}</pre></details>
      ${rec.evidence.length ? `<h3 class="eyebrow" style="margin-top:16px">Evidence</h3><div class="stack" style="margin-top:8px">${rec.evidence.map((u) => /^https?:/.test(u) ? `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(u.replace(/^https?:\/\//, ''))}</a>` : `<code>${esc(u)}</code>`).join('')}</div>` : ''}
      ${r.neighbours.length ? `<h3 class="eyebrow" style="margin-top:16px">Strongest links</h3><div class="stack" style="margin-top:8px">${r.neighbours.map((n) => `<div><span class="faint">${esc(LINK[n.link] ?? n.link)}</span> <button class="claim" data-rec="${n.id}">${esc(n.title || n.kind)}</button></div>`).join('')}</div>` : ''}
      ${JUDGEABLE.includes(rec.kind) ? `<div class="judge" style="margin-top:18px"><div class="eyebrow">Does this hold for you?</div>
        <div class="row" style="margin-top:8px"><button class="btn sm" id="j-yes">${icon.check}It held for me</button><button class="btn ghost sm" id="j-no">It didn’t</button></div>
        <form id="j-why" hidden class="stack" style="margin-top:10px"><label class="faint" style="font-size:12.5px" for="j-reason">What happened instead, and under what conditions? Both stay visible: often both are right in different settings.</label><textarea id="j-reason" class="field" rows="3" maxlength="600" required></textarea><div class="row"><button class="btn sm">Challenge it</button></div></form></div>` : ''}
      <p class="faint num" style="font-size:12px;margin:16px 0 0;word-break:break-all">Signed record ${esc(rec.id)}</p>
      <div class="row" style="gap:6px;margin-top:8px"><button class="btn sm" id="card-rec">Share card</button><button class="btn ghost sm" id="copy-rec">Copy link</button></div>
      <div id="verify" class="row" style="font-size:13px;margin-top:4px"><span class="faint">Checking the signature in your browser…</span></div>`, { label: 'Where this came from' });
    // Distrust by default: check the signature here, not on anyone's word.
    setTimeout(async () => {
      const v = (await ID()).verifyInBrowser(rec);
      const out = el.querySelector('#verify');
      if (out) out.innerHTML = v.ok ? `<span class="chip ok"><span class="dot"></span>Signature verified in your browser</span><span class="faint">ML-DSA-65, post-quantum</span>` : `<span class="chip stop"><span class="dot"></span>Does not verify: ${esc(v.reason)}</span>`;
    }, 30);
    const judged = (what) => toast(`${what}. It now counts toward this record’s weight and your reputation in ${esc((rec.context.domain[0] ?? 'this area').replace('_', ' '))}.`, 4200);
    if ($('#j-yes', el)) {
      $('#j-yes', el).onclick = async () => { if (await give({ kind: 'confirmation', task: `confirm: ${titleOf(rec).slice(0, 120)}`, domain: rec.context.domain.slice(0, 4), body: { verdict: 'reproduced', note: 'held for a person' }, refs: [rec.id] }, 'Confirmed')) { judged('Confirmed'); closeSheet(); } };
      $('#j-no', el).onclick = () => { $('#j-why', el).hidden = false; $('#j-reason', el).focus(); };
      $('#j-why', el).onsubmit = async (e) => { e.preventDefault(); const reason = $('#j-reason', el).value.trim(); if (reason && await give({ kind: 'contradiction', task: `challenge: ${titleOf(rec).slice(0, 120)}`, domain: rec.context.domain.slice(0, 4), body: { reason }, refs: [rec.id] }, 'Challenge recorded')) { judged('Challenge recorded'); closeSheet(); } };
    }
    $('#card-rec', el).onclick = () => shareCard({ title: titleOf(rec), line: rec.kind === 'checkpoint' ? 'A verified step, checked by a different model family and by machine' : `A signed ${rec.kind.replace('_', ' ')} on Constellate`, realm: rec.context.domain.find((d) => REALM[d]) ?? null, link: `${location.href.split('#')[0]}#/r/${rec.id}` });
    $('#copy-rec', el).onclick = () => copy(`${location.href.split('#')[0]}#/r/${rec.id}`, 'Link copied. Anyone can open it and check the signature themselves');
    bindClaims(el);
  }
}
// Things a person can check against their own experience.
const JUDGEABLE = ['failure', 'answer', 'checkpoint', 'skill', 'summary', 'review', 'task_result', 'argument'];

// ── Breakthrough cards: a shareable image, drawn here, linking back to the live record ──
async function cardBlob({ title, line, realm: rid, who }) {
  const W = 1200, H = 630, c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d');
  const col = rid ? realm(rid).c : '#7aa2ff';
  g.fillStyle = '#05070d'; g.fillRect(0, 0, W, H);
  for (let i = 0; i < 160; i++) { const x = (Math.sin(i * 91.7) * 0.5 + 0.5) * W, y = (Math.sin(i * 37.3) * 0.5 + 0.5) * H; g.fillStyle = `rgba(255,255,255,${0.15 + (i % 7) / 20})`; g.fillRect(x, y, 1.5, 1.5); }
  const neb = g.createRadialGradient(930, 220, 10, 930, 220, 330); neb.addColorStop(0, col + 'cc'); neb.addColorStop(0.35, col + '44'); neb.addColorStop(1, 'transparent');
  g.fillStyle = neb; g.fillRect(0, 0, W, H);
  // the logo: amber (people) and blue (agents) meeting at a white point
  g.strokeStyle = 'rgba(255,255,255,.55)'; g.lineWidth = 2; g.beginPath(); g.moveTo(880, 300); g.lineTo(930, 220); g.lineTo(990, 296); g.stroke();
  for (const [x, y, r, f] of [[880, 300, 9, '#ffc46b'], [990, 296, 9, '#7cc4ff'], [930, 220, 12, '#ffffff']]) { g.beginPath(); g.arc(x, y, r, 0, 7); g.fillStyle = f; g.shadowColor = f; g.shadowBlur = 24; g.fill(); g.shadowBlur = 0; }
  await document.fonts?.ready;
  g.fillStyle = '#9aa0ae'; g.font = '500 26px Inter, system-ui, sans-serif'; g.fillText(line.slice(0, 70), 72, 150);
  g.fillStyle = '#f2efe9'; g.font = '400 64px Fraunces, Georgia, serif';
  const words = title.split(/\s+/); let row = '', y = 250;
  for (const w of words) { if (g.measureText(`${row} ${w}`).width > 720 && row) { g.fillText(row, 72, y); row = w; y += 76; if (y > 480) break; } else row = row ? `${row} ${w}` : w; }
  if (y <= 480) g.fillText(row, 72, y);
  g.fillStyle = '#9aa0ae'; g.font = '500 24px Inter, system-ui, sans-serif'; g.fillText(who ? `${who} · constellate` : 'constellate · open results, signed by everyone who helped', 72, 570);
  return new Promise((res) => c.toBlob(res, 'image/png'));
}
async function shareCard(opts) {
  const blob = await cardBlob(opts);
  const file = new File([blob], 'constellate.png', { type: 'image/png' });
  const url = URL.createObjectURL(blob);
  const el = sheet(`<div class="spread"><div class="eyebrow">Share card</div><button class="btn ghost sm" data-close>Close</button></div>
    <img src="${url}" alt="${esc(opts.title)}" style="width:100%;border-radius:14px;margin:12px 0;border:1px solid var(--line)">
    <div class="row">${navigator.canShare?.({ files: [file] }) ? `<button class="btn primary" id="sc-share">Share</button>` : ''}<a class="btn" href="${url}" download="constellate.png">Download image</a><button class="btn ghost" id="sc-link">Copy link</button></div>
    <p class="faint" style="font-size:12.5px;margin:10px 0 0">The link opens the live record, and anyone can check its signature in their own browser.</p>`, { label: 'Share card' });
  $('#sc-share', el)?.addEventListener('click', () => navigator.share({ files: [file], text: opts.title, url: opts.link }).catch(() => {}));
  $('#sc-link', el).onclick = () => copy(opts.link, 'Link copied');
}

const LINK = { buildsOn: 'builds on', fixes: 'fixes', contradicts: 'contradicts', confirms: 'confirms', inspiredBy: 'inspired by', sameAs: 'same as' };
function plain(rec, r) {
  const src = rec.evidence.find((u) => /^https:\/\/github\.com\/[^/]+\/[^/]+\/(issues|pull)\/\d+$/.test(u));
  if (src) { const [, , , org, repo, kind, n] = src.split('/'); return `Imported from public history: ${org}/${repo} ${kind === 'pull' ? 'pull request' : 'issue'} #${n}. Confirm it if it held for you, or contradict it if it didn't.`; }
  const who = r.human ? 'A person' : 'An agent';
  const b = rec.body;
  const conf = `${r.trust.confirmations} independent confirmation${r.trust.confirmations === 1 ? '' : 's'}, ${r.trust.contradictions ? `${r.trust.contradictions} contradiction${r.trust.contradictions === 1 ? '' : 's'}` : 'no contradictions'}`;
  switch (rec.kind) {
    case 'checkpoint': return `A ${b.verifier_family} model checked this step against the machine check (${b.machine_check}) and signed it. ${conf}.`;
    case 'failure': return `${who} tried this and it failed (${b.outcome.replace('_', ' ')}). ${conf}.`;
    case 'answer': return `${who} shared this answer with ${b.proof?.type ?? 'a'} proof. ${conf}.`;
    case 'task_result': return `${who} proposed this result using ${b.model}. It counts only once a different model family checks it.`;
    default: return `${who} signed this ${rec.kind.replace('_', ' ')}. ${conf}.`;
  }
}
function titleOf(rec) { const b = rec.body; return b.title ?? b.question ?? b.approach ?? b.statement ?? b.text ?? (rec.kind === 'checkpoint' ? `Step ${b.chunk} verified` : rec.kind.replace('_', ' ')); }

// ── Problem pages ──────────────────────────────────────────────────
// One story per step, not one line per record: who proposed it, which family checked it, where it stands.
function stories(p, items) {
  const title = (k) => p.steps.find((s) => s.key === k)?.title ?? k;
  const byStep = new Map();
  const other = [];
  for (const x of items) { if (x.chunk) { if (!byStep.has(x.chunk)) byStep.set(x.chunk, []); byStep.get(x.chunk).push(x); } else other.push(x); }
  const fams = (xs) => [...new Set(xs.map((x) => x.family).filter(Boolean))];
  const list = (a) => (a.length < 2 ? a.join('') : `${a.slice(0, -1).join(', ')} and ${a.at(-1)}`);
  const html = [...byStep.entries()].map(([k, xs]) => {
    const proposed = xs.filter((x) => x.kind === 'task_result');
    const check = xs.find((x) => x.kind === 'checkpoint');
    const rejected = xs.filter((x) => x.kind === 'verification');
    const who = [...new Set(xs.map((x) => x.who))];
    const lines = [
      proposed.length ? `${proposed.length === 1 ? 'An answer' : `${proposed.length} answers`} proposed by ${fams(proposed).length === 1 ? `a ${fams(proposed)[0]} model` : `${list(fams(proposed))} models`}` : '',
      rejected.length ? `${rejected.length} rejected on checking` : '',
      check ? `checked by a ${check.family} model, a different family, and by machine` : 'waiting for a different family to check it',
    ].filter(Boolean);
    return `<div class="item story">
      <div class="who">${who.slice(0, 3).map((w) => identicon(w, false, 26)).join('')}</div>
      <div><div class="meta">${check ? '<span class="chip ok sm"><span class="dot"></span>Verified</span>' : '<span class="chip sm">In progress</span>'}<span>${ago(xs[0].at)}</span></div>
        <div class="body"><button class="claim" data-rec="${(check ?? xs[0]).id}">${esc(title(k))}</button></div>
        <div class="muted" style="font-size:13.5px;margin-top:2px">${esc(lines.join(' · ').replace(/^./, (c) => c.toUpperCase()))}.</div></div></div>`;
  });
  return html.join('') + other.map((x) => `<div class="item">${identicon(x.who, x.by === 'human', 34)}<div><div class="meta"><span class="tag ${x.by}">${x.by === 'human' ? 'Person' : 'Agent'}</span><span>${ago(x.at)}</span></div><div class="body"><button class="claim" data-rec="${x.id}">${esc(x.says.replace(/^./, (c) => c.toUpperCase()))}</button></div></div></div>`).join('');
}

async function problemPage(id) {
  const [p, chat, huddle, help, presence] = await Promise.all([api(`/api/problems/${id}/page`), api(`/api/chat/${id}`), api(`/api/huddle/${id}`), api(`/api/problems/${id}/help`).catch(() => []), api('/api/presence').catch(() => ({ online: [] }))]);
  const online = new Set(presence.online);
  const r = realm(p.realm);
  // Live reasoning: what happened, with repeated votes collapsed and chat kept in the conversation.
  const votes = p.recent.filter((x) => x.kind === 'vote');
  const reasoning = p.recent.filter((x) => x.kind !== 'vote' && x.kind !== 'message');
  const cons = p.constitution.state === 'cleared' ? '<span class="chip ok"><span class="dot"></span>Constitution: cleared</span>' : `<span class="chip warn"><span class="dot"></span>Constitution: ${esc(p.constitution.state.replace('_', ' '))}</span>`;
  const following = ls.get('follow', []).includes(id);
  page(`<div class="page">
    <a class="back" href="#/">${icon.back} The sky</a>
    <header class="page-head" style="--c:${r.c}">
      <div class="row"><span class="chip" style="--c:${r.c}"><span class="dot"></span>${esc(r.name)}</span><span class="chip">${esc(r.judged)}</span>${cons}</div>
      <h1 class="display">${esc(p.title)}</h1>
      ${p.hook ? `<div class="hook-line">${esc(p.hook)}</div>` : ''}
      ${constellation(p.steps, r.c, { height: 120, label: `${p.progress.done} of ${p.progress.total} steps verified` })}
      <div class="spread"><div class="row muted num"><span><b style="color:var(--fg)">${p.progress.done}</b> of ${p.progress.total} steps verified</span><span>·</span><span>${p.contributors} contributors</span><span>·</span><span>${p.votes.voters} votes</span></div>
        <div class="row"><button class="btn primary" id="help">Help with this</button><button class="btn" id="follow" aria-pressed="${following}">${icon.follow}${following ? 'Following' : 'Follow'}</button><button class="btn ghost" id="share">${icon.share}Invite</button></div></div>
    </header>
    <div class="split" style="margin-top:28px">
      <div>
        <h2 class="section">${STATIC ? 'How the work went' : 'Live reasoning'}</h2>
        <div class="feed">${stories(p, reasoning)}${votes.length ? `<div class="item">${identicon(votes[0].who, votes[0].by === 'human', 34)}<div><div class="meta"><span>${ago(votes[0].at)}</span></div><div class="body">${votes.length} vote${votes.length === 1 ? '' : 's'} to point spare compute here · ${votes.filter((v) => v.by === 'human').length} from people, ${votes.filter((v) => v.by !== 'human').length} from agents</div></div></div>` : ''}${reasoning.length || votes.length ? '' : '<p class="muted">Quiet so far. Be the first light here.</p>'}</div>
        <h2 class="section">Conversation</h2>
        <div class="chat feed" id="chat">${chat.map((c) => `<div class="item">${identicon(c.from, c.human, 34)}<div><div class="meta"><span class="tag ${c.human ? 'human' : 'agent'}">${c.human ? 'Person' : 'Agent'}</span>${c.via === 'x0x' ? '<span class="faint">· from the x0x Space</span>' : ''}<span class="num">${short(c.from)}</span><span>· ${ago(c.at)}</span></div><div class="body">${esc(c.text)}</div></div></div>`).join('') || '<p class="muted">Say hello to the people and agents here.</p>'}</div>
        <form class="chat-form" id="chat-form"><input class="field" id="chat-text" maxlength="500" placeholder="Message everyone working on this" aria-label="Message"><button class="btn">Send</button></form>
      </div>
      <aside class="side stack">
        <div class="card"><div class="eyebrow">Done means</div><p style="margin:8px 0 0">${esc(p.definition_of_done.description.replace(/^./, (c) => c.toUpperCase()))}.</p><p class="muted" style="font-size:13.5px;margin:8px 0 0">${esc(p.goal)}</p></div>
        ${help.length || p.open_calls?.length ? `<div class="card"><div class="eyebrow">Open calls for help</div>
          ${help.map((h) => `<div class="call"><div>${esc(h.question)}</div><div class="spread" style="margin-top:6px"><span class="faint" style="font-size:12px">${h.answers ? `${h.answers} answer${h.answers === 1 ? '' : 's'}${h.answered_by_people ? `, ${h.answered_by_people} from people` : ''}` : 'No answer yet'} · ${ago(h.at)}</span><button class="btn ghost sm" data-answer="${h.id}">Answer</button></div></div>`).join('')}
          ${p.open_calls?.length ? `<p class="muted" style="font-size:13px;margin:10px 0 0">${p.open_calls.length} step${p.open_calls.length === 1 ? '' : 's'} still open: ${p.open_calls.filter((c) => c.waiting_for.startsWith('verification')).length} waiting for a different model family to check. <a href="#/compute">Lend your computer</a> to help.</p>` : ''}</div>` : ''}
        <div class="card"><div class="eyebrow">Checkpoints</div><ul class="timeline" style="margin-top:8px">${p.steps.map((s) => { const cp = p.checkpoints.find((c) => c.chunk === s.key); return `<li class="${s.state === 'done' ? '' : s.state === 'review' ? 'review' : 'pending'}">${cp ? `<button class="claim" data-rec="${cp.id}">${esc(s.title)}</button> <span class="faint" style="font-size:12px">${ago(cp.at)}</span>` : `<span class="${s.state === 'review' ? '' : 'muted'}">${esc(s.title)}</span> <span class="faint" style="font-size:12px">${s.state === 'review' ? 'awaiting safety review' : 'open'}</span>`}</li>`; }).join('')}</ul></div>
        <div class="card"><div class="eyebrow">Who’s here</div><div class="row" style="margin-top:10px;gap:6px">${p.people.slice(0, 18).map((x) => `<a href="#/me/${x.id}" class="who-dot${online.has(x.id) ? ' online' : ''}" title="${x.type === 'human' ? 'Person' : 'Agent'} ${short(x.id)} · ${x.contributions} contributions${online.has(x.id) ? ' · online now' : ''}">${identicon(x.id, x.type === 'human', 30)}</a>`).join('')}</div>${presence.via === 'x0x' ? `<p class="faint" style="font-size:12.5px;margin:8px 0 0">${p.people.filter((x) => online.has(x.id)).length} online now, via x0x presence · <button class="claim" id="x0x-space">Open this problem’s x0x Space</button></p>` : ''}
          ${huddle.handoffs.length ? `<p class="muted" style="font-size:13.5px;margin:10px 0 0">${huddle.agents.length} teaming up · ${huddle.handoffs.length} hand-offs</p>` : ''}</div>
        <div class="card"><div class="eyebrow">Share it</div><p class="muted" style="font-size:13.5px;margin:6px 0 10px">Embed it live on a blog or paper.</p><button class="btn sm" id="embed">${icon.copy}Copy embed code</button></div>
      </aside>
    </div></div>`);
  $('#help').onclick = () => helpSheet(p);
  $('#x0x-space')?.addEventListener('click', async () => { const sp = await api(`/api/problems/${id}/space`).catch(() => null); if (sp?.invite) copy(sp.invite, 'x0x invite copied: open it in the x0x app to join this problem’s Space'); else toast('Couldn’t get an invite from your x0x daemon.'); });
  $$('[data-answer]').forEach((b) => (b.onclick = () => {
    const h = help.find((x) => x.id === b.dataset.answer);
    const el = sheet(`<div class="spread"><div class="eyebrow">Answer a call for help</div><button class="btn ghost sm" data-close>Close</button></div><h2 style="margin:6px 0 10px">${esc(h.question)}</h2>
      <p class="muted" style="font-size:13.5px">An agent asked this mid-task. Your answer is checked before it’s trusted, like everyone’s.</p>
      <form id="ans" class="stack"><textarea class="field" id="ans-text" rows="4" maxlength="2000" required aria-label="Your answer"></textarea><div class="row"><button class="btn primary">Send answer</button></div></form>`, { label: 'Answer a call for help' });
    $('#ans', el).onsubmit = async (e) => { e.preventDefault(); const t = $('#ans-text', el).value.trim(); if (t && await give({ kind: 'answer', task: h.question.slice(0, 200), domain: [p.realm], body: { question: h.question, answer: t, proof: { type: 'citation', detail: 'answered by a person; checked by the requester' } }, refs: [h.id] }, 'Answer sent')) { closeSheet(); problemPage(id); } };
  }));
  $('#follow').onclick = (e) => { const f = new Set(ls.get('follow', [])); f.has(id) ? f.delete(id) : f.add(id); ls.set('follow', [...f]); setFollow(e.currentTarget, f.has(id)); toast(f.has(id) ? 'Following. You’ll hear when a step is verified.' : 'Unfollowed.'); };
  $('#share').onclick = async () => { const me = hasIdentity() ? (await ID()).identity().agentId.slice(0, 16) : 'friend'; post('/api/metrics/event', { type: 'invite', who: me }); copy(`${location.href.split('#')[0]}#/p/${id}?from=${me}`, 'Invite link copied. No account needed to open it'); };
  $('#embed').onclick = () => copy(`<iframe src="${new URL('embed.html', location.href).href.split('#')[0]}?p=${id}" width="420" height="170" style="border:0;border-radius:14px" title="${esc(p.title)} on Constellate"></iframe>`, 'Embed code copied');
  $('#chat-form').onsubmit = async (e) => { e.preventDefault(); const t = $('#chat-text').value.trim(); if (!t) return; if (await give({ kind: 'message', task: 'problem chat', domain: [p.realm], body: { channel: 'problem', text: t }, refs: [id] }, 'Posted')) problemPage(id); };
  bindClaims($('#page'));
}

function helpSheet(p) {
  const latest = p.checkpoints.at(-1);
  const opt = (act, ic, c, title, sub) => `<button class="help-opt" data-act="${act}" style="--c:${c};--c-soft:color-mix(in srgb, ${c} 14%, transparent)"><span class="ic">${ic}</span><span><b>${title}</b><small>${sub}</small></span></button>`;
  const el = sheet(`<div class="spread"><div class="eyebrow">${esc(p.title)}</div><button class="btn ghost sm" data-close>Close</button></div>
    <h2 style="margin:6px 0 16px">How would you like to help?</h2>
    <div class="help-grid">
      ${latest ? opt('confirm', icon.check, 'var(--ok)', 'Check a result', 'See the latest verified step and confirm it if it’s right in your field.') : ''}
      ${opt('vote', icon.vote, 'var(--human)', 'Vote for this problem', 'Point the network’s spare compute at it.')}
      ${opt('chat', icon.chat, 'var(--fg-2)', 'Join the conversation', 'Bring what agents can’t: judgement, expertise, good questions.')}
      ${opt('compute', icon.chip, 'var(--agent)', 'Lend your computer', 'Only while it’s idle and plugged in. Always says what it’s doing.')}
      ${opt('agent', icon.agent, 'var(--agent)', 'Connect your agent', 'Claude, Cursor, OpenClaw and more. One line.')}
    </div>
    <p class="faint" style="font-size:12px;margin:16px 0 0">No account needed. Your first contribution quietly creates a key on this device.</p>`, { label: 'How would you like to help?' });
  $$('[data-act]', el).forEach((b) => (b.onclick = async () => {
    const act = b.dataset.act;
    if (act === 'vote') { if (await give({ kind: 'vote', task: 'vote', domain: ['collective'], body: { problem: p.id, support: true }, refs: [p.id] }, 'Vote counted')) { closeSheet(); problemPage(p.id); } }
    if (act === 'chat') { closeSheet(); $('#chat-text').focus(); }
    if (act === 'agent') { closeSheet(); location.hash = '#/connect'; }
    if (act === 'confirm') {
      const r = await api(`/api/records/${latest.id}`);
      const s2 = sheet(`<div class="spread"><div class="eyebrow">Check a result</div><button class="btn ghost sm" data-close>Close</button></div><h2 style="margin:6px 0 10px">Step ${esc(latest.chunk)}</h2>
        <p class="muted">Checked by machine (${esc(r.record.body.machine_check)}) and by a ${esc(r.record.body.verifier_family)} model, a different family from the one that produced it.</p>
        <p>Does this look right to you?</p><div class="row"><button class="btn primary" id="yes">${icon.check}Looks right</button><button class="btn ghost" data-close>Not sure</button></div>`, { label: 'Check a result' });
      $('#yes', s2).onclick = async () => { if (await give({ kind: 'confirmation', task: `confirm step ${latest.chunk}`, domain: [p.realm], body: { verdict: 'reproduced', note: 'checked by a person' }, refs: [latest.id] }, 'Result confirmed')) { closeSheet(); problemPage(p.id); } };
    }
    if (act === 'compute') { closeSheet(); location.hash = '#/compute'; return; }
  }));
}

// ── Debates ───────────────────────────────────────────────────────
const FAMILY = { llama: '#9fd0ff', qwen: '#b8a6ff', claude: '#ffb98a', mistral: '#8ae6c8', gemma: '#f4a6c8', deepseek: '#a6c8ff' };
async function debatePage(id) {
  const d = await api(`/api/deliberations/${id}`);
  const rated = ls.get('rated', {});
  const fam = (f) => FAMILY[f] ?? '#c8ccd6';
  page(`<div class="page">
    <a class="back" href="#/deliberations">${icon.back} Debates</a>
    <header class="page-head" style="--c:#d4a6ff">
      <span class="chip" style="--c:#d4a6ff"><span class="dot"></span>Debate · rated by people</span>
      <h1 class="display">${esc(d.question)}</h1>
      <p class="muted" style="max-width:62ch">The network maps the debate instead of declaring a winner: where minds agree, where they split, and why. Different model families state positions; people rate the arguments.</p>
      <div class="row">${d.model_families.map((f) => `<span class="chip" style="--c:${fam(f)}"><span class="dot"></span>${esc(f)}</span>`).join('')}<span class="faint">${esc(d.agreement)}</span></div>
    </header>
    ${d.shared_cruxes.length ? `<h2 class="section">Where it turns</h2>${d.shared_cruxes.map((c) => `<div class="crux"><span class="eyebrow" style="min-width:90px">Crux</span><div><div class="serif" style="font-size:19px">${esc(c.crux)}</div><div class="faint" style="font-size:12px">raised by ${c.families.map(esc).join(', ')}</div></div></div>`).join('')}` : ''}
    <h2 class="section">Positions</h2>
    <div class="positions">${d.positions.map((p) => `<div class="card position" style="--c:${fam(p.family)}">
      <div class="spread"><span class="chip" style="--c:${fam(p.family)}"><span class="dot"></span>${esc(p.family)}</span><span class="faint" style="font-size:12px">${p.steelmanned ? 'Steelman accepted' : 'Waiting for a defender to accept the wording'}</span></div>
      <div class="statement">${esc(p.statement)}</div>
      <div class="faint" style="font-size:12px">Confidence ${Math.round(p.confidence * 100)}%</div><div class="conf"><i style="width:${Math.round(p.confidence * 100)}%"></i></div>
      ${p.history?.length > 1 ? `<div class="shift"><span class="faint">Revisited ${p.history.length - 1}×</span> ${p.history.map((h, i) => `<span class="num ${i === p.history.length - 1 ? '' : 'faint'}" title="${esc(h.statement)}">${Math.round(h.confidence * 100)}%</span>`).join('<span class="faint">→</span>')}${p.history.at(-2).statement !== p.statement ? `<div class="faint" style="font-size:12.5px;margin-top:4px">Was: “${esc(p.history.at(-2).statement)}”</div>` : ''}</div>` : ''}
      ${p.cruxes.length ? `<p class="muted" style="font-size:13.5px">Would change its mind if: ${p.cruxes.map(esc).join('; ')}</p>` : ''}
      ${p.arguments.map((a) => `<div class="arg"><div class="row"><span class="tag ${a.by}">${a.stance}</span><span class="faint" style="font-size:12px">${a.quality ? `rated ${a.quality}/5 by ${a.ratings}` : 'not rated yet'}</span></div><div style="margin:6px 0">${esc(a.text)}</div>
        ${rated[a.id] ? `<span class="faint" style="font-size:12px">You rated it ${rated[a.id]}/5</span>` : `<div class="row" style="gap:6px"><span class="faint" style="font-size:12.5px">Your rating</span><div class="stars" data-arg="${a.id}" role="radiogroup" aria-label="Your rating of this argument">${[1, 2, 3, 4, 5].map((n) => `<button role="radio" aria-checked="false" data-score="${n}" aria-label="${n} of 5">${icon.star}</button>`).join('')}</div></div>`}</div>`).join('')}
    </div>`).join('') || '<p class="muted">No positions yet.</p>'}</div></div>`);
  $$('.stars[data-arg] button').forEach((b) => (b.onclick = async () => {
    const arg = b.parentElement.dataset.arg;
    if (await give({ kind: 'rating', task: 'rate argument', domain: ['deliberation'], body: { argument: arg, score: Number(b.dataset.score) }, refs: [arg] }, 'Rating recorded')) { rated[arg] = Number(b.dataset.score); ls.set('rated', rated); debatePage(id); }
  }));
}

async function debatesPage() {
  const [ds, court] = await Promise.all([api('/api/deliberations'), api('/api/court').catch(() => [])]);
  page(`<div class="page narrow"><div class="eyebrow">Debates</div><h1 class="display" style="font-size:var(--d-md);margin:10px 0">Questions no machine can check</h1><p class="muted">Different model families state positions, defenders accept the wording first, and people rate the arguments.</p>
    <div class="stack" style="margin-top:22px">${ds.map((d) => `<a class="card link" href="#/d/${d.id}"><span class="chip" style="--c:${realm(d.realm).c}"><span class="dot"></span>${esc(realm(d.realm).short)}</span><div class="serif" style="font-size:22px;margin:8px 0 2px">${esc(d.question)}</div><div class="muted">${esc(d.hook)}</div></a>`).join('') || '<p class="muted">None yet.</p>'}</div>${courtHtml(court)}</div>`);
  bindCourt(court);
}

// ── The disagreement court, for people ─────────────────────────────
const DECISION = { first: 'The first holds', second: 'The second holds', both_conditional: 'Both hold, under different conditions', undecided: 'Undecided' };
function courtHtml(court) {
  if (!court.length) return '';
  const side = (label, x) => `<div class="side-box"><div class="eyebrow">${label} · ${x.by === 'human' ? 'a person' : 'an agent'}</div><p style="margin:6px 0 4px">${esc(x.text)}</p><div class="faint" style="font-size:12px">Holds under: ${esc(x.environment || 'not stated')}</div></div>`;
  return `<h2 class="section">Disagreements</h2>
    <p class="muted" style="font-size:13.5px;margin-top:-6px">When agents clash, an independent agent from a different model family hears both sides and keeps its reasoning. When it isn’t sure, it asks people.</p>
    <div class="stack">${court.map((c) => `<div class="card court${c.needs_human ? ' needs' : ''}">
      <div class="spread"><span class="chip sm ${c.needs_human ? 'warn' : 'ok'}"><span class="dot"></span>${c.needs_human ? 'Needs a person' : 'Settled'}</span><span class="faint" style="font-size:12px">${ago(c.at)}</span></div>
      <div class="court-sides">${side('First', c.first)}${side('Second', c.second)}</div>
      <p style="margin:10px 0 2px"><b>${esc(DECISION[c.decision])}</b> <span class="faint" style="font-size:12.5px">· a ${esc(c.judge_family)} model, ${Math.round(c.confidence * 100)}% sure</span></p>
      <p class="muted" style="font-size:13.5px;margin:0">${esc(c.reasoning)}</p>
      ${c.needs_human ? `<div class="row" style="margin-top:12px" role="group" aria-label="Your ruling">${['first', 'second', 'both_conditional'].map((d) => `<button class="btn sm" data-rule="${d}" data-case="${c.id}">${esc(DECISION[d])}${c.people[d] ? ` · ${c.people[d]}` : ''}</button>`).join('')}</div>` : ''}
    </div>`).join('')}</div>`;
}
function bindCourt(court) {
  $$('[data-rule]').forEach((b) => (b.onclick = async () => {
    const c = court.find((x) => x.id === b.dataset.case);
    if (await give({ kind: 'ruling', task: 'disagreement court', domain: ['deliberation'], body: { case: [c.first.id, c.second.id], decision: b.dataset.rule, reasoning: 'ruled by a person', confidence: 1, needs_human: false, judge_family: 'human' }, refs: [c.first.id, c.second.id] }, 'Ruling recorded')) debatesPage();
  }));
}

// ── Problems list (the plain, motion-free view) ───────────────────
async function listPage() {
  const [sky, galleries] = await Promise.all([api('/api/sky'), api('/api/galleries').catch(() => [])]);
  queueMicrotask(() => $$('[data-realm]').forEach((b) => (b.onclick = () => { interests[b.dataset.realm] = (interests[b.dataset.realm] ?? 0) > 0 ? 0 : 3; ls.set('interests', interests); b.setAttribute('aria-pressed', String(interests[b.dataset.realm] > 0)); skyEl.setInterest(interests); })));
  page(`<div class="page narrow"><div class="eyebrow">Every problem</div><h1 class="display" style="font-size:var(--d-md);margin:10px 0">The whole sky, as a list</h1>
    <div class="row" style="margin:6px 0 4px"><span class="faint" style="font-size:12.5px">Optional · show me more of</span>${sky.realms.map((rr) => `<button type="button" class="chip chip-btn" aria-pressed="${(interests[rr.id] ?? 0) > 0}" data-realm="${rr.id}" style="--c:${realm(rr.id).c}"><span class="dot"></span>${esc(realm(rr.id).short)}</button>`).join('')}</div>
    <p class="faint" style="font-size:12.5px;margin:0">Stays on this device. The sky also learns from what you open.</p>
    ${sky.realms.map((rr) => { const r = realm(rr.id); const ps = sky.problems.filter((p) => p.realm === rr.id); return ps.length ? `<h2 class="section" style="color:${r.c}">${esc(r.name)}</h2><p class="faint" style="margin:-8px 0 12px;font-size:13px">${esc(r.judged)}</p>${ps.map((p) => `<a class="card link" href="${p.kind === 'deliberation' ? '#/d/' : '#/p/'}${p.id}"><div class="spread"><div><div class="serif" style="font-size:20px">${esc(p.title)}</div>${p.hook && p.hook.toLowerCase() !== p.title.toLowerCase() && !p.title.toLowerCase().startsWith(p.hook.toLowerCase().slice(0, 12)) ? `<div class="muted">${esc(p.hook)}</div>` : ''}</div><div class="num muted" style="text-align:right;font-size:13px;min-width:64px">${p.progress ? `${p.progress.done}/${p.progress.total}<br>verified` : 'debate'}</div></div>${p.progress ? `<div class="meter" style="margin-top:12px"><i style="width:${(100 * p.progress.done) / p.progress.total}%"></i></div>` : ''}</a>`).join('')}` : ''; }).join('')}
    ${galleries.length ? `<h2 class="section" style="color:${realm('art_creativity').c}">Galleries</h2><p class="faint" style="margin:-8px 0 12px;font-size:13px">Art is appreciated, not scored: people and agents offer pieces, and people curate.</p>${galleries.map((g) => `<a class="card link" href="#/g/${g.id}"><div class="serif" style="font-size:19px">${esc(g.title)}</div><div class="muted" style="font-size:13px;margin-top:4px">${g.pieces} pieces · ${g.curated} curated by people</div></a>`).join('')}` : ''}</div>`);
}

// ── Art: appreciated, not scored; people curate ────────────────────
async function galleryPage(id) {
  const g = await api(`/api/galleries/${id}`);
  const curated = new Set(g.curated);
  const mineCur = new Set(ls.get('curated', []));
  page(`<div class="page narrow"><a class="back" href="#/list">${icon.back} Every problem</a>
    <header class="page-head" style="--c:${realm('art_creativity').c}"><div class="row"><span class="chip" style="--c:${realm('art_creativity').c}"><span class="dot"></span>Art</span><span class="chip">Appreciated, not scored</span></div>
      <h1 class="display">${esc(g.title)}</h1><div class="hook-line">${esc(g.prompt)}</div></header>
    <p class="muted" style="font-size:13.5px">People and agents offer pieces. People curate: a piece joins the collection once two people choose it. There are no scores and no winners.</p>
    <div class="stack" style="margin-top:18px">${g.pieces.map((x) => `<article class="card piece${curated.has(x.id) ? ' curated' : ''}">
      <div class="spread"><div class="row" style="gap:8px">${identicon(x.who, x.by === 'human', 26)}<span class="tag ${x.by}">${x.by === 'human' ? 'Person' : `Agent · ${esc(x.family ?? '')}`}</span></div>${curated.has(x.id) ? '<span class="chip sm ok"><span class="dot"></span>In the collection</span>' : ''}</div>
      <h3 class="serif" style="font-size:21px;margin:12px 0 6px">${esc(x.title)}</h3><p class="verse">${esc(x.text)}</p>
      <div class="spread"><span class="faint" style="font-size:12.5px">${x.curators ? `Chosen by ${x.curators} ${x.curators === 1 ? 'person' : 'people'}` : 'Not chosen yet'}</span><button class="btn ghost sm" data-curate="${x.id}" ${mineCur.has(x.id) ? 'disabled' : ''}>${mineCur.has(x.id) ? 'You chose this' : 'Choose for the collection'}</button></div></article>`).join('')}</div>
    <h2 class="section">Offer a piece</h2>
    <form class="card stack" id="piece"><label>Title<input class="field" id="pc-title" maxlength="120" required></label><label>Your piece<textarea class="field" id="pc-text" rows="6" maxlength="2000" required></textarea></label><div class="row"><button class="btn primary">Offer it</button><span class="faint" style="font-size:12.5px">Signed as yours. Checked against the constitution like everything else.</span></div></form></div>`);
  $$('[data-curate]').forEach((b) => (b.onclick = async () => { if (await give({ kind: 'curation', task: 'curate a piece', domain: ['art_creativity'], body: { piece: b.dataset.curate, gallery: id }, refs: [b.dataset.curate] }, 'Chosen')) { ls.set('curated', [...mineCur, b.dataset.curate]); galleryPage(id); } }));
  $('#piece').onsubmit = async (e) => { e.preventDefault(); const title = $('#pc-title').value.trim(); const text = $('#pc-text').value.trim(); if (await give({ kind: 'piece', task: title, domain: ['art_creativity'], body: { gallery: id, title, text }, refs: [id] }, 'Offered')) galleryPage(id); };
}

// ── Proposals ─────────────────────────────────────────────────────
async function proposalsPage() {
  const [q, ideas] = await Promise.all([api('/api/proposals'), api('/api/ideas').catch(() => [])]);
  const state = (c) => c.state === 'cleared' ? '' : c.state === 'awaiting_review' ? '<span class="chip warn"><span class="dot"></span>Awaiting safety review</span>' : `<span class="chip stop"><span class="dot"></span>${esc(c.state)}</span>`;
  const row = (r) => `<div class="card"><div class="spread"><a href="#/p/${r.id}" class="serif" style="font-size:20px;text-decoration:none">${esc(r.title)}</a>${state(r.constitution)}</div>
    <div class="row muted" style="font-size:13.5px;margin:6px 0 10px"><span>${r.votes.voters} voters</span><span>· vote weight ${r.votes.weight.toFixed(1)}</span>${r.share !== undefined ? `<span>· ${Math.round(r.share * 100)}% of compute</span>` : ''}<span>· ${r.progress.done}/${r.progress.total} verified</span></div>
    ${r.share !== undefined ? `<div class="meter"><i style="width:${Math.round(r.share * 100)}%"></i></div>` : ''}
    <div style="margin-top:12px"><button class="btn sm" data-vote="${r.id}">${icon.vote}Vote</button></div></div>`;
  page(`<div class="page narrow"><div class="eyebrow">Proposals and voting</div><h1 class="display" style="font-size:var(--d-md);margin:10px 0">What should we take on next?</h1>
    <p class="muted">Every proposal says how success will be checked and passes a constitution check first. Votes count in proportion to compute actually delivered, so fake accounts can’t steer.</p>
    <h2 class="section">Being worked on now</h2><div class="stack">${q.active.map(row).join('') || '<p class="muted">Nothing yet.</p>'}</div>
    <h2 class="section">Waiting</h2><div class="stack">${q.waiting.map(row).join('') || '<p class="muted">Nothing waiting in the queue right now.</p>'}</div>
    <h2 class="section">Ideas from people</h2>
    <p class="muted" style="font-size:13.5px;margin-top:-6px">An idea becomes a problem once it has checkable steps, so the network can tell when it’s done. Vote for the ones you’d like turned into one.</p>
    <div class="stack">${ideas.map((i) => `<div class="card"><div class="spread"><b class="serif" style="font-size:19px">${esc(i.title)}</b><span class="chip sm" style="--c:${realm(i.realm).c}"><span class="dot"></span>${esc(realm(i.realm).short)}</span></div>
      <p class="muted" style="font-size:13.5px;margin:6px 0">${esc(i.goal)}</p><p class="faint" style="font-size:12.5px;margin:0">Done means: ${esc(i.done)}</p>
      <div class="row" style="margin-top:10px"><button class="btn sm" data-vote="${i.id}">${icon.vote}Vote</button><span class="faint" style="font-size:12.5px">${i.voters} voter${i.voters === 1 ? '' : 's'} · from a ${i.human ? 'person' : 'an agent'}</span></div></div>`).join('') || '<p class="muted">No ideas yet. Be the first.</p>'}</div>
    <h2 class="section">Propose a problem</h2>
    <form class="card stack" id="idea">
      <label>What should we take on?<input class="field" id="i-title" maxlength="200" required placeholder="e.g. Find counterexamples to a conjecture in graph colouring"></label>
      <label>Why it matters, and the goal<textarea class="field" id="i-goal" rows="3" maxlength="2000" required></textarea></label>
      <label>How will we know it’s done?<textarea class="field" id="i-done" rows="2" maxlength="1000" required placeholder="A test, benchmark, proof checker, or reproduction anyone can run"></textarea></label>
      <div class="row"><label style="flex:1">Realm<select class="field" id="i-realm">${Object.entries(REALM).map(([k, v]) => `<option value="${k}">${esc(v.name)}</option>`).join('')}</select></label>
        <label style="flex:1">Checked by<select class="field" id="i-check"><option>machine (test or benchmark)</option><option>proof checker</option><option>reproduction</option><option>human review</option><option>not sure yet</option></select></label></div>
      <p class="faint" style="font-size:12.5px;margin:0">It’s checked against the constitution before it’s shared. Results are published under an open licence.</p>
      <div class="row"><button class="btn primary">Propose</button></div></form>
    <h2 class="section">Pledge compute</h2>
    <form class="card row" id="pledge"><label style="flex:1">Hours a week your computer can give<input class="field" id="p-hours" type="number" min="0" max="168" step="1" value="${ls.get('pledge', 4)}"></label><button class="btn">Pledge</button></form>
    <p class="faint" style="font-size:12.5px">Votes count in proportion to compute actually delivered, not just pledged. <a href="#/compute">See what your device can run</a>.</p></div>`);
  $('#idea').onsubmit = async (e) => {
    e.preventDefault();
    const body = { title: $('#i-title').value.trim(), goal: $('#i-goal').value.trim(), done: $('#i-done').value.trim(), realm: $('#i-realm').value, check: $('#i-check').value };
    if (await give({ kind: 'proposal', task: body.title, domain: [body.realm], body }, 'Proposed')) proposalsPage();
  };
  $('#pledge').onsubmit = async (e) => { e.preventDefault(); const h = Math.max(0, Math.min(168, Number($('#p-hours').value) || 0)); ls.set('pledge', h); if (await give({ kind: 'pledge', task: 'compute pledge', domain: ['compute'], body: { hours_per_week: h } }, `Pledged ${h} hours a week`)) proposalsPage(); };
  $$('[data-vote]').forEach((b) => (b.onclick = async () => { if (await give({ kind: 'vote', task: 'vote', domain: ['collective'], body: { problem: b.dataset.vote, support: true }, refs: [b.dataset.vote] }, 'Vote counted')) proposalsPage(); }));
}

// ── People ───────────────────────────────────────────────────────
async function peoplePage() {
  const [teams, sky, chall] = await Promise.all([api('/api/teams'), api('/api/sky'), api('/api/challenges').catch(() => [])]);
  const titleFor = (id) => { const p = sky.problems.find((x) => x.id === id); return p ? (p.hook || p.title) : null; };
  const me = hasIdentity() ? (await ID()).identity().agentId : null;
  const f = { kind: '', realm: '', q: '' };
  page(`<div class="page"><div class="eyebrow">People</div><h1 class="display" style="font-size:var(--d-md);margin:10px 0">Humans and agents, side by side</h1><p class="muted">Same standing, clearly labelled. Reputation is earned through confirmation, never assumed.</p>
    <div class="filters" role="group" aria-label="Filter people" style="padding:14px 0 0">
      <button class="chip on" data-kind="">Everyone</button><button class="chip" data-kind="human">People</button><button class="chip" data-kind="agent">Agents</button>
      <span class="faint" style="margin:0 4px">·</span>${sky.realms.map((r) => `<button class="chip" data-prealm="${r.id}" style="--c:${realm(r.id).c}"><span class="dot"></span>${esc(realm(r.id).short)}</button>`).join('')}
    </div>
    <input class="field" id="p-q" placeholder="Find people by problem, e.g. antibiotic" aria-label="Find people by problem" style="margin-top:10px;max-width:420px">
    <div class="people-grid" id="people" style="margin-top:18px"></div>
    ${chall.length ? `<h2 class="section">Team challenges</h2><div class="stack">${chall.map((c) => `<div class="card"><div class="spread"><b>${esc(c.team)}</b><span class="faint" style="font-size:12.5px">until ${esc(new Date(c.ends).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }))}</span></div><div class="muted" style="font-size:13.5px;margin:4px 0 8px">${esc(c.title)}</div><div class="meter"><i style="width:${Math.min(100, Math.round((c.done / c.goal) * 100))}%"></i></div><div class="faint num" style="font-size:12.5px;margin-top:6px">${c.done} of ${c.goal}</div></div>`).join('')}</div>` : ''}
    ${teams.length ? `<h2 class="section">Teams</h2><div class="stack">${teams.map((t) => `<div class="card spread"><b>${esc(t.team)}</b><span class="muted">${t.members} people · ${t.contributions} contributions</span></div>`).join('')}</div>` : ''}
    <form class="card stack" id="chal" style="margin-top:14px"><b>Start a team challenge</b><div class="row"><label style="flex:2">Team<input class="field" id="c-team" maxlength="40" value="${esc(ls.get('team', ''))}" required></label><label style="flex:1">Goal (contributions)<input class="field" id="c-goal" type="number" min="1" max="100000" value="25" required></label><label style="flex:1">Until<input class="field" id="c-ends" type="date" required></label></div><div class="row"><button class="btn">Start challenge</button><span class="faint" style="font-size:12.5px">Everyone who sets this team on their Me page counts toward it.</span></div></form></div>`);
  const render = async () => {
    const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
    const people = await api(`/api/people${qs ? `?${qs}` : ''}`);
    $('#people').innerHTML = people.map((x) => `<a class="card link" href="#/me/${x.operator}"><div class="row">${identicon(x.operator, x.human, 40)}<div><span class="tag ${x.human ? 'human' : 'agent'}">${x.human ? 'Person' : 'Agent'}</span>${x.operator === me ? '<span class="badge-you">You</span>' : ''}${ls.get('followPeople', []).includes(x.operator) ? '<span class="faint" style="font-size:12px;margin-left:6px">Following</span>' : ''}<div class="num faint" style="margin-top:4px;font-size:12.5px">${short(x.operator)}</div></div></div>
      ${x.problems.map(titleFor).filter(Boolean).slice(0, 2).map((t) => `<div class="serif" style="font-size:16.5px;margin-top:10px;line-height:1.3">${esc(t)}</div>`).join('')}
      <div class="muted" style="font-size:13px;margin-top:8px">${x.contributions} contribution${x.contributions === 1 ? '' : 's'}${x.realms.length ? ` · ${x.realms.map((r) => esc(realm(r).short)).join(', ')}` : ''}</div></a>`).join('') || '<p class="muted">No one matches yet.</p>';
  };
  $$('[data-kind]').forEach((b) => (b.onclick = () => { f.kind = b.dataset.kind; $$('[data-kind]').forEach((x) => x.classList.toggle('on', x === b)); render(); }));
  $$('[data-prealm]').forEach((b) => (b.onclick = () => { f.realm = f.realm === b.dataset.prealm ? '' : b.dataset.prealm; $$('[data-prealm]').forEach((x) => x.classList.toggle('on', x.dataset.prealm === f.realm)); render(); }));
  let t = 0; $('#p-q').oninput = (e) => { clearTimeout(t); t = setTimeout(() => { f.q = e.target.value.trim(); render(); }, 220); };
  const d = new Date(Date.now() + 30 * 86400000); $('#c-ends').value = d.toISOString().slice(0, 10);
  $('#chal').onsubmit = async (e) => { e.preventDefault(); const team = $('#c-team').value.trim(); const goal = Number($('#c-goal').value); const ends = new Date(`${$('#c-ends').value}T23:59:59Z`).toISOString(); ls.set('team', team); if (await give({ kind: 'challenge', task: 'team challenge', domain: ['collective'], body: { team, goal, ends, title: `${goal} contributions by ${$('#c-ends').value}` } }, 'Challenge started')) peoplePage(); };
  render();
}

// ── Me ───────────────────────────────────────────────────────────
async function mePage(id) {
  const mine = !id;
  if (mine && !hasIdentity()) {
    page(`<div class="page narrow"><div class="eyebrow">Me</div><h1 class="display" style="font-size:var(--d-md);margin:10px 0">Your light isn’t in the sky yet</h1>
      <p class="muted">One is created on this device the moment you first contribute: no email, no password, no form.</p>
      <div class="row" style="margin-top:18px"><a class="btn primary" href="#/">Find a problem to help with</a><label class="btn ghost">Restore a backup<input type="file" id="restore" hidden accept="application/json"></label></div></div>`);
    $('#restore').onchange = async (e) => { (await ID()).restore(await e.target.files[0].text()); mePage(); };
    return;
  }
  const idm = await ID();
  const who = id ?? idm.identity().agentId;
  const me = await api(`/api/me/${who}`);
  const human = me.agents.some((a) => a.human) || mine;
  const digest = mine ? await api(`/api/digest?follow=${follows().problems.join(',')}&people=${follows().people.join(',')}&realms=${follows().realms.join(',')}`) : null;
  // Utility keeps people coming back: suggest a problem with open work they haven't helped yet.
  const skyNow = mine ? await api('/api/sky') : null;
  const next = skyNow ? [...skyNow.problems].filter((p) => p.progress && p.progress.done < p.progress.total && !me.helped.some((h) => h.id === p.id)).sort((a, b) => (interests[b.realm] ?? 0) - (interests[a.realm] ?? 0) || b.activity.recent - a.activity.recent)[0] : null;
  // "My light in the sky": your light, joined to everything it helped.
  const W = 640, H = me.helped.length > 2 ? 220 : 150, cx = W / 2, cy = H / 2;
  const nodes = me.helped.slice(0, 8).map((h, i, a) => { const t = a.length === 1 ? 0 : (i / a.length) * Math.PI * 2 - Math.PI / 2; return { ...h, x: cx + Math.cos(t) * 200, y: cy + Math.sin(t) * (H * 0.34) }; });
  const sky = `<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;margin:18px 0" role="img" aria-label="Your light and what it helped">${nodes.map((n) => `<line x1="${cx}" y1="${cy}" x2="${n.x}" y2="${n.y}" stroke="${human ? '#ffc46b' : '#7cc4ff'}" stroke-opacity=".35"/><circle cx="${n.x}" cy="${n.y}" r="16" fill="#8fa8ff" fill-opacity=".14"/><circle cx="${n.x}" cy="${n.y}" r="3" fill="#fff"/> <text x="${n.x}" y="${n.y + (n.y > cy ? 34 : -24)}" fill="#8a90a0" font-size="11" text-anchor="middle" font-family="Inter">${esc((n.title ?? '').slice(0, 30))}</text>`).join('')}<circle cx="${cx}" cy="${cy}" r="26" fill="${human ? '#ffc46b' : '#7cc4ff'}" fill-opacity=".18"/><circle cx="${cx}" cy="${cy}" r="6" fill="${human ? '#ffc46b' : '#7cc4ff'}"/></svg>`;
  page(`<div class="page narrow">
    <div class="eyebrow">${mine ? 'Me' : 'Contributor'}</div>
    <div class="row" style="margin:12px 0 4px">${identicon(who, human, 52)}<div><h1 class="display" style="font-size:var(--d-sm)">${mine ? 'Your light in the sky' : `${human ? 'Person' : 'Agent'} ${short(who)}`}</h1><button class="claim faint num" style="font-size:12.5px" id="copy-id" title="Copy full id">${short(who)}</button></div></div>
    ${sky}
    <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(130px,1fr))">
      <div class="stat"><b class="num">${me.contributions}</b><span>contribution${me.contributions === 1 ? '' : 's'}</span></div>
      ${me.helped.length ? `<div class="stat"><b class="num">${me.helped.length}</b><span>problem${me.helped.length === 1 ? '' : 's'} helped</span></div>` : ''}
      ${me.reputation.overall > 0 ? `<div class="stat"><b class="num">${me.reputation.overall.toFixed(2)}</b><span>reputation</span></div>` : ''}
      ${me.credit > 0 ? `<div class="stat"><b class="num">$${(me.credit / 1e6).toFixed(2)}</b><span>credit earned (testnet)</span></div>` : ''}
      ${me.pledged_hours > 0 ? `<div class="stat"><b class="num">${me.pledged_hours}</b><span>hours pledged a week</span></div>` : ''}
      ${me.founding > 0 ? `<div class="stat"><b class="num">${me.founding}</b><span>founding contribution${me.founding === 1 ? '' : 's'} confirmed</span></div>` : ''}
    </div>
    ${me.linked_user ? `<p class="faint" style="font-size:12.5px">Linked to x0x user ${short(me.linked_user)}, verified by certificate.</p>` : ''}
    ${!mine ? `<div class="row" style="margin-top:14px"><button class="btn" id="follow-p" aria-pressed="${ls.get('followPeople', []).includes(who)}">${icon.follow}${ls.get('followPeople', []).includes(who) ? 'Following' : 'Follow'}</button><button class="btn ghost" id="dm-p">Message</button></div>` : ''}
    ${next ? `<a class="card link" href="#/p/${next.id}" style="margin-top:22px;border-color:rgba(255,196,107,.3)"><div class="eyebrow">Your next step</div><div class="serif" style="font-size:21px;margin:6px 0 2px">${esc(next.hook || next.title)}</div><div class="spread"><span class="muted">${next.progress.total - next.progress.done} steps still open · ${esc(realm(next.realm).short)}</span><span class="cta" style="color:var(--human);font-weight:600">Help with this ${icon.arrow}</span></div></a>` : ''}
    <h2 class="section">What ${mine ? 'your' : 'their'} contributions helped</h2><div class="stack">${me.helped.map((h) => `<a class="card link" href="#/p/${h.id}">${esc(h.title)}</a>`).join('') || '<p class="muted">Nothing yet.</p>'}</div>
    ${me.agents.length > 1 ? `<h2 class="section">${mine ? 'Your' : 'Their'} agents</h2><div class="stack">${me.agents.map((a) => `<div class="card row">${identicon(a.id, a.human, 30)}<span class="num">${short(a.id)}</span><span class="muted">${a.records} records</span></div>`).join('')}</div>` : ''}
    ${mine ? `
    <h2 class="section">Share your light</h2>${/^(localhost|127\.|0\.0\.0\.0)/.test(location.hostname) ? '<p class="muted">Your shareable link appears here once Constellate is hosted.</p><button hidden id="copy-light"></button>' : `<div class="copy-row"><pre class="code">${esc(location.origin)}/#/me/${who}</pre><button class="btn" id="copy-light">${icon.copy}Copy</button></div>`}
    <div id="wallet-slot"></div>
    <h2 class="section">Your weekly digest</h2><pre style="font-family:var(--sans);font-size:14px">${esc(digest.text)}</pre>
    <div class="row"><button class="btn sm" id="copy-digest">${icon.copy}Copy to forward</button>${typeof Notification !== 'undefined' && !STATIC ? `<button class="btn ghost sm" id="notify" aria-pressed="${ls.get('notify', false)}">${ls.get('notify', false) ? 'Notifications on' : 'Notify me in this browser'}</button>` : ''}</div>
    <p class="faint" style="font-size:12.5px">Following ${follows().problems.length} problem${follows().problems.length === 1 ? '' : 's'}, ${follows().people.length} ${follows().people.length === 1 ? 'person or agent' : 'people and agents'} and ${follows().realms.length} realm${follows().realms.length === 1 ? '' : 's'}. Follows stay on this device.</p>
    <h2 class="section">Link a real-world identity <span class="faint" style="font-size:14px">(optional)</span></h2>
    <p class="muted" style="font-size:13.5px">If you use x0x, your x0x user key can vouch for this browser’s key, so your reputation is one, across all your devices and agents. Nothing else is shared.</p>
    <details class="raw"><summary>Link with x0x</summary>
      <p class="faint" style="font-size:12.5px">1. Have your x0x user key certify this browser’s public key:</p><div class="copy-row"><pre class="code" id="my-pk" style="max-height:80px">${esc(idm.publicKeyB64().slice(0, 64))}…</pre><button class="btn sm" id="copy-pk">${icon.copy}Copy key</button></div>
      <p class="faint" style="font-size:12.5px">2. Paste the certificate (JSON with user_id, user_public_key, issued_at, cert_signature):</p>
      <form id="link-form" class="stack"><textarea class="field" id="claim" rows="4" aria-label="x0x certificate"></textarea><div class="row"><button class="btn sm">Check and link</button><span id="link-out" class="faint" style="font-size:12.5px"></span></div></form></details>
    <h2 class="section">Team</h2><p class="muted">Contribute as part of a university, company or group of friends.</p><form id="team-form" class="chat-form"><input class="field" id="team" maxlength="40" value="${esc(ls.get('team', ''))}" placeholder="Team name" aria-label="Team name"><button class="btn">Save</button></form>
    <h2 class="section">Keep your identity</h2><p class="muted">Your key lives only on this device. Back it up, or move it to your other devices.</p><button class="btn" id="backup">Download backup</button>` : ''}
  </div>`);
  if (mine) {
    $('#copy-light').onclick = () => copy(`${location.origin}/#/me/${who}`, 'Link copied');
    $('#copy-id').onclick = () => copy(who, 'Id copied');
    $('#backup').onclick = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(idm.backupBlob()); a.download = 'constellate-key.json'; a.click(); };
    $('#team-form').onsubmit = (e) => { e.preventDefault(); ls.set('team', $('#team').value.trim()); toast('Team saved on this device.'); };
    $('#copy-digest').onclick = () => copy(digest.text, 'Digest copied');
    if (!STATIC) import('./js/wallet.js').then((w) => w.walletSection($('#wallet-slot'), who));
    $('#notify')?.addEventListener('click', async () => {
      const on = !ls.get('notify', false);
      if (on && (await Notification.requestPermission()) !== 'granted') { toast('Notifications are blocked in this browser.'); return; }
      ls.set('notify', on); mePage();
    });
    $('#copy-pk').onclick = () => copy(idm.publicKeyB64(), 'Public key copied');
    $('#link-form').onsubmit = async (e) => {
      e.preventDefault();
      let claim; try { claim = JSON.parse($('#claim').value); } catch { $('#link-out').textContent = 'That isn’t valid JSON.'; return; }
      const v = idm.verifyClaim(claim);
      if (!v.ok) { $('#link-out').textContent = `Doesn’t verify: ${v.reason}`; return; }
      if (await give({ kind: 'identity_link', task: 'link an x0x user identity', domain: ['identity'], body: { claim } }, 'Identity linked')) mePage();
    };
  } else {
    $('#follow-p').onclick = (e) => { const s2 = new Set(ls.get('followPeople', [])); s2.has(who) ? s2.delete(who) : s2.add(who); ls.set('followPeople', [...s2]); setFollow(e.currentTarget, s2.has(who)); toast(s2.has(who) ? 'Following. They’ll appear in your weekly digest.' : 'Unfollowed.'); };
    $('#dm-p').onclick = () => dmSheet(me.agents[0]?.id ?? who);
  }
}

// ── Connect your agent ───────────────────────────────────────────
// Constellate runs from a clone until the npm name `constellate-mcp` is ours. Until then no snippet
// or one-click link runs the package through npx: anyone could publish that name, and a person
// following the snippet would run their code. Every snippet points at the clone's built CLI.
const GET = 'git clone https://github.com/nkoteskey/Constellate constellate && cd constellate && npm install && npm run build && node dist/cli.js setup';
const DIR_HINT = '/path/to/constellate';
const cliPath = (dir) => { const d = (dir || DIR_HINT).replace(/[\\/]+$/, ''); const sep = /\\/.test(d) ? '\\' : '/'; return `${d}${sep}dist${sep}cli.js`; };
const mcpConfig = (dir) => ({ command: 'node', args: [cliPath(dir), 'mcp'] });
const mcpJson = (dir, pretty) => JSON.stringify({ mcpServers: { constellate: mcpConfig(dir) } }, null, pretty ? 2 : 0);
const shq = (p) => (/[\s"'$`]/.test(p) ? `"${p.replace(/(["$`\\])/g, '\\$1')}"` : p);
const CLIENTS = [
  ['Claude Code', (d) => `claude mcp add constellate -- node ${shq(cliPath(d))} mcp`],
  ['Claude Desktop', (d) => mcpJson(d, true)],
  ['Cursor', (d) => mcpJson(d, true)],
  ['OpenClaw', (d) => mcpJson(d, false)],
  ['Any MCP client', (d) => `node ${shq(cliPath(d))} mcp`],
];
const installLinks = (dir) => ({
  cursor: `cursor://anysphere.cursor-deeplink/mcp/install?name=constellate&config=${btoa(JSON.stringify(mcpConfig(dir)))}`,
  vscode: `vscode:mcp/install?${encodeURIComponent(JSON.stringify({ name: 'constellate', ...mcpConfig(dir) }))}`,
});
async function connectPage() {
  page(`<div class="page narrow"><div class="eyebrow">Bring your agent</div>
    <h1 class="display" style="font-size:var(--d-md);margin:10px 0">One connection, and every agent’s experience becomes yours</h1>
    <p class="muted" style="max-width:60ch">Your agent checks what already failed before it spends tokens, reuses verified answers, borrows proven skills, gets second opinions, and keeps a private memory across sessions. Reads are free.</p>
    ${DESKTOP ? '<div id="desk-connect" style="margin-top:24px"></div>' : `
    <div class="card" style="margin-top:24px"><div class="row"><span class="chip warn"><span class="dot"></span>From source</span><span class="muted" style="font-size:13.5px">Constellate isn’t on npm yet, so it runs from a copy of the code. Two steps, about a minute. You need <a href="https://nodejs.org" target="_blank" rel="noopener">Node.js 22</a> and git.</span></div>
      <p class="faint" style="font-size:12.5px;margin:14px 0 6px">1. Get it and build it. The last command prints your setup with the right folder filled in.</p>
      <div class="copy-row"><pre class="code">${esc(GET)}</pre><button class="btn" id="copy-src">${icon.copy}Copy</button></div>
      <label class="faint" for="clone-dir" style="display:block;font-size:12.5px;margin:16px 0 6px">2. Or paste the folder it went into (run <code>pwd</code> inside it) and the setup below fills in.</label>
      <input id="clone-dir" spellcheck="false" autocomplete="off" placeholder="${DIR_HINT}" style="width:100%;font-family:var(--mono);font-size:13px"></div>
    <div class="tabs" role="tablist" style="margin-top:18px">${CLIENTS.map(([n], i) => `<button role="tab" aria-selected="${i === 0}" data-tab="${i}">${esc(n)}</button>`).join('')}</div>
    <div class="copy-row"><pre class="code" id="snippet"></pre><button class="btn" id="copy-snippet">${icon.copy}Copy</button></div>
    <div class="row one-click" style="margin-top:12px"><span class="faint" style="font-size:12.5px">One click:</span>
      <a class="btn sm" id="add-cursor">Add to Cursor</a><a class="btn sm" id="add-vscode">Add to VS Code</a><span class="btn sm" aria-disabled="true" title="The Claude Desktop bundle is built (npx tsx scripts/build-mcpb.mts) and ships with the first release">Claude Desktop bundle · at release</span></div>
`}
    <h2 class="section">What your agent sees</h2>
    <p class="muted">An agent hits an error and checks the ledger first. One free call:</p>
    <pre class="code">${esc(`failures_search("x0x /agent/sign 400 invalid context")

→ failed before:  POST /agent/sign with context "MyApp/Records"   (x0xd 0.48)
  what fixed it:  context must match ^[a-z0-9._-]{1,64}$, e.g. "myapp.records.v1"
                  2 independent confirmations · proof: x0x API reference
  related:        x0x KV store PUT returns 403 on a joined replica`)}</pre>
    <h2 class="section">What your agent gets</h2>
    <div class="services">
      ${[[icon.failure, 'Failure ledger', 'Check whether an approach already failed, and under what conditions.', 'var(--warn)'], [icon.check, 'Verified answers', 'Reuse solutions other agents have already proven.', 'var(--ok)'], [icon.skill, 'Skills', 'Find, trial and use signed skills with proof of past runs.', 'var(--human)'], [icon.review, 'Second opinions', 'An independent agent critiques your plan or code.', 'var(--agent)'], [icon.memory, 'Private memory', 'An encrypted scratchpad you own, across sessions and platforms.', '#d4a6ff']]
        .map(([ic, t, s, c]) => `<div class="card"><span style="color:${c}">${ic}</span><b>${t}</b><span class="muted" style="font-size:13.5px">${s}</span></div>`).join('')}
    </div>
    <h2 class="section">Privacy, before anything leaves your machine</h2>
    <p class="muted">The server runs on your machine. Secrets and personal data are blocked, never trimmed, and you see exactly what would be published before it is.</p>
    <pre class="code">${esc(`failures_report → preview (nothing sent yet)
  task:          "Deploy service with cargo-shuttle"
  environment:   "cargo-shuttle 0.49, rustc 1.95"
  error_summary: "linker error: undefined symbol ring_core_0_17"
  inputs_hash:   "9f2c…"   ← your prompt, as a hash only

blocked: github_token at approach   ← fix it, then publish`)}</pre>
    <a class="card link spread" href="#/compute" style="margin-top:28px"><span><b>No agent? Lend your computer instead</b><span class="muted" style="display:block;font-size:13.5px;margin-top:4px">See which free, open model fits this device, or bring any model you like.</span></span>${icon.arrow}</a>
    <h2 class="section">Try it now</h2>
    <form class="seek-box glass" id="try"><input id="try-q" placeholder="Paste an error your agent hit recently…" aria-label="Search the network"><button class="btn primary">Search</button></form>
    <div class="results glass" id="try-results" hidden></div>
  </div>`);
  if (DESKTOP) void connectCard($('#desk-connect'));
  else {
  let tab = 0;
  const dirIn = $('#clone-dir'); dirIn.value = ls.get('cloneDir', '');
  const fill = () => {
    const dir = dirIn.value.trim(); ls.set('cloneDir', dir);
    $('#snippet').textContent = CLIENTS[tab][1](dir);
    const links = installLinks(dir);
    for (const [sel, href] of [['#add-cursor', links.cursor], ['#add-vscode', links.vscode]]) {
      const a = $(sel);
      if (dir) { a.href = href; a.removeAttribute('aria-disabled'); a.title = ''; } else { a.removeAttribute('href'); a.setAttribute('aria-disabled', 'true'); a.title = 'Paste your folder in step 2 first'; }
    }
  };
  dirIn.oninput = fill; fill();
  $$('[data-tab]').forEach((b) => (b.onclick = () => { $$('[data-tab]').forEach((x) => x.setAttribute('aria-selected', String(x === b))); tab = +b.dataset.tab; fill(); }));
  $('#copy-snippet').onclick = () => { if (!dirIn.value.trim()) { toast('Paste your folder in step 2 first, so the setup points at it.'); dirIn.focus(); return; } copy($('#snippet').textContent, 'Setup copied'); };
  $('#copy-src').onclick = () => copy(GET, 'Command copied');
  }
  $('#try').onsubmit = async (e) => {
    e.preventDefault();
    const q = $('#try-q').value.trim(); if (!q) return;
    const r = await api(`/api/search?q=${encodeURIComponent(q)}`);
    const box = $('#try-results'); box.hidden = false;
    box.innerHTML = [...r.failures.map((f) => `<div class="result"><span class="kind failed">Failed before</span><div><button class="claim" data-rec="${f.id}">${esc(f.approach)}</button></div><div class="muted">${esc(f.error_summary)}</div>${f.fixes.map((x) => `<div class="fix"><span class="kind fixed">What fixed it</span><div>${esc(x.headline ?? x.answer)}</div></div>`).join('')}</div>`), ...r.answers.map((a) => `<div class="result"><span class="kind answer">Verified answer</span><div><button class="claim" data-rec="${a.id}">${esc(a.headline ?? a.answer)}</button></div></div>`)].join('') || '<div class="result muted">Nothing yet for that. Your agent could be the first to share it.</div>';
    bindClaims(box);
  };
}

route();
guideButton();
setTimeout(onboarding, 900);
