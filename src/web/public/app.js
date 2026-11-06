import { identity, hasIdentity, contribute, backupBlob, restore } from './identity.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const api = async (p, init) => { const r = await fetch(p, init); const j = await r.json(); if (!r.ok) throw new Error(j.error || r.statusText); return j; };
const ls = { get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } } };
const ago = (iso) => { const m = Math.round((Date.now() - Date.parse(iso)) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };
const hash = (s) => { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return (h >>> 0) / 4294967295; };

let sky = null;
let reduceMotion = ls.get('calm', matchMedia('(prefers-reduced-motion: reduce)').matches);
const interests = ls.get('interests', {}); // stays on this device
if (!ls.get('firstVisit', 0)) ls.set('firstVisit', Date.now());
const post = (p, b) => fetch(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).catch(() => {});

function toast(msg, ms = 3200) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), ms); }
function modal(html) { $('#modal-body').innerHTML = html; $('#modal').hidden = false; }
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal' || e.target.dataset.close !== undefined) $('#modal').hidden = true; });
addEventListener('keydown', (e) => { if (e.key === 'Escape') $('#modal').hidden = true; });

$('#motion').setAttribute('aria-pressed', String(reduceMotion));
$('#motion').onclick = () => { reduceMotion = !reduceMotion; ls.set('calm', reduceMotion); $('#motion').setAttribute('aria-pressed', String(reduceMotion)); drawSky(); };

if (!ls.get('introSeen', false)) $('#intro').hidden = false;
$('#intro-ok').onclick = () => { $('#intro').hidden = true; ls.set('introSeen', true); };

// ── Signed contributions ────────────────────────────────────────────
async function give(draft, what) {
  const first = !hasIdentity();
  const team = ls.get('team', '');
  if (team && ['vote', 'rating', 'confirmation', 'message'].includes(draft.kind)) draft = { ...draft, body: { ...draft.body, team } };
  try {
    await contribute(draft);
  } catch (e) { toast(`Not sent: ${e.message}`); return false; }
  if (first) post('/api/metrics/event', { type: 'first_contribution', seconds: Math.round((Date.now() - ls.get('firstVisit', Date.now())) / 1000) });
  const n = ls.get('contributions', 0) + 1;
  ls.set('contributions', n);
  toast(first ? `${what}. Your light joined the sky.` : `${what}. Thank you.`);
  if (n === 3) setTimeout(() => toast('You have earned credit. Back up your key from the Me page so you keep it.', 5000), 3400);
  return true;
}

// ── Router ──────────────────────────────────────────────────────────
async function route() {
  const [h, query] = (location.hash.slice(1) || '/').split('?');
  const [, view, id] = h.split('/');
  const from = new URLSearchParams(query ?? '').get('from');
  if (from && view === 'p' && !ls.get(`invited:${id}`, false)) { ls.set(`invited:${id}`, true); $('#invite').hidden = false; $('#invite').textContent = 'You were invited to help with this problem.'; setTimeout(() => ($('#invite').hidden = true), 6000); }
  document.querySelectorAll('nav a').forEach((a) => a.classList.toggle('on', a.getAttribute('href') === `#/${view ?? ''}` || (!view && a.dataset.view === 'sky')));
  $('#sky-view').hidden = !!view;
  $('#page').hidden = !view;
  if (view) $('#intro').hidden = true;
  try {
    if (!view) return showSky();
    if (view === 'p') return problemPage(id);
    if (view === 'd') return debatePage(id);
    if (view === 'list') return listPage();
    if (view === 'proposals') return proposalsPage();
    if (view === 'deliberations') return debatesPage();
    if (view === 'me') return mePage(id);
    if (view === 'people') return peoplePage();
  } catch (e) { $('#page').innerHTML = `<p class="muted">${esc(e.message)}</p>`; }
}
addEventListener('hashchange', route);

// ── Living sky ──────────────────────────────────────────────────────
const canvas = $('#sky');
const ctx = canvas.getContext('2d');
let nebulae = [];
let pulses = [];

let threads = [];
async function loadSky() { sky = await api('/api/sky'); threads = (await api('/api/graph').catch(() => ({ threads: [] }))).threads; layout(); }

function layout() {
  const W = canvas.clientWidth, H = canvas.clientHeight;
  const realms = sky.realms;
  const cx = W / 2, cy = H * 0.45, R = Math.min(W, H) * 0.3; // keep nebulae clear of the header line and the featured cards
  nebulae = sky.problems.map((p) => {
    const ri = Math.max(0, realms.findIndex((r) => r.id === p.realm));
    const weight = 1 + (interests[p.realm] ?? 0) * 0.15; // the sky slowly arranges itself around what you linger on
    const a0 = (ri / realms.length) * Math.PI * 2 - Math.PI / 2;
    const a = a0 + (hash(p.id) * 0.8 + 0.1) * (Math.PI * 2 / realms.length);
    const d = R * (0.35 + 0.6 * hash(p.id + 'r')) / Math.min(weight, 1.6);
    const size = 18 + Math.sqrt(p.activity.total + 2) * 7;
    const progress = p.progress ? p.progress.done / p.progress.total : 0.4;
    return { ...p, x: cx + Math.cos(a) * d * (W > H ? 1.35 : 1), y: cy + Math.sin(a) * d, r: Math.min(size, 90), colour: realms[ri]?.colour ?? '#7aa2ff', glow: 0.25 + progress * 0.6 };
  });
}

function drawSky(now = performance.now()) {
  const dpr = devicePixelRatio || 1;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  if (canvas.width !== W * dpr) { canvas.width = W * dpr; canvas.height = H * dpr; if (sky) layout(); }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  // Threads between nebulae are real links in the knowledge graph; bridges between realms are bright.
  for (const t of threads) {
    const a = nebulae.find((n) => n.id === t.a), b = nebulae.find((n) => n.id === t.b);
    if (!a || !b) continue;
    ctx.strokeStyle = t.bridge ? 'rgba(255,255,255,0.75)' : `rgba(160,180,220,${Math.min(0.35, 0.06 + t.weight * 0.04)})`;
    ctx.lineWidth = t.bridge ? 1.6 : 0.8;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  }
  for (const n of nebulae) {
    const g = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, n.r);
    g.addColorStop(0, n.colour + Math.round(n.glow * 255).toString(16).padStart(2, '0'));
    g.addColorStop(1, n.colour + '00');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2); ctx.fill();
    const lights = [...Array(Math.min(n.activity.agents, 14)).fill('agent'), ...Array(Math.min(n.activity.humans, 10)).fill('human')];
    lights.forEach((kind, i) => {
      const a = hash(n.id + i) * Math.PI * 2, d = n.r * (0.3 + 0.6 * hash(n.id + 'd' + i));
      ctx.fillStyle = kind === 'human' ? '#ffc46b' : '#7cc4ff';
      ctx.beginPath(); ctx.arc(n.x + Math.cos(a) * d, n.y + Math.sin(a) * d, kind === 'human' ? 2.4 : 1.8, 0, Math.PI * 2); ctx.fill();
    });
  }
  // Every motion is real: a pulse means a record just landed.
  pulses = pulses.filter((p) => now - p.t < 1400);
  for (const p of pulses) {
    const k = (now - p.t) / 1400;
    ctx.strokeStyle = p.colour + Math.round((1 - k) * 200).toString(16).padStart(2, '0');
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(p.x, p.y, p.r * (reduceMotion ? 1.05 : 1 + k * 1.2), 0, Math.PI * 2); ctx.stroke();
  }
  if (pulses.length && !reduceMotion) requestAnimationFrame(drawSky);
}

function hit(x, y) { return nebulae.find((n) => (n.x - x) ** 2 + (n.y - y) ** 2 < n.r ** 2); }
canvas.addEventListener('mousemove', (e) => {
  const n = hit(e.offsetX, e.offsetY);
  const card = $('#hover');
  canvas.style.cursor = n ? 'pointer' : 'default';
  if (!n) { card.hidden = true; return; }
  card.hidden = false;
  card.style.left = `${Math.min(e.offsetX + 16, canvas.clientWidth - 296)}px`;
  card.style.top = `${e.offsetY + 16}px`;
  card.innerHTML = `<b>${esc(n.title)}</b>${esc(n.hook)}<br><span class="muted">${n.progress ? `${n.progress.done}/${n.progress.total} steps verified · ` : 'Debate · '}${n.activity.agents} agents, ${n.activity.humans} people</span>`;
});
canvas.addEventListener('click', (e) => { const n = hit(e.offsetX, e.offsetY); if (n) open(n); });
function open(n) { interests[n.realm] = (interests[n.realm] ?? 0) + 1; ls.set('interests', interests); location.hash = n.kind === 'deliberation' ? `#/d/${n.id}` : `#/p/${n.id}`; }
addEventListener('resize', () => { if (sky) { layout(); drawSky(); } });

async function showSky() {
  if (!sky) await loadSky();
  $('#sky-line').textContent = sky.line;
  const byInterest = [...sky.problems].sort((a, b) => (interests[b.realm] ?? 0) - (interests[a.realm] ?? 0));
  const featured = [...new Set([...sky.featured, ...byInterest.filter((p) => p.hook).map((p) => p.id)])].slice(0, 3).map((id) => sky.problems.find((p) => p.id === id));
  // Introduce people through a problem: the lead card shows live progress and one "Help with this".
  $('#featured').innerHTML = featured.map((p, i) => `<a href="${p.kind === 'deliberation' ? '#/d/' : '#/p/'}${p.id}"${i === 0 ? ' class="lead"' : ''}><span class="serif">${esc(p.hook || p.title)}</span><small>${esc(p.title)}</small>${i === 0 && p.progress ? `<span class="bar" aria-label="${p.progress.done} of ${p.progress.total} verified">${Array.from({ length: p.progress.total }, (_, k) => `<i class="${k < p.progress.done ? 'done' : ''}"></i>`).join('')}</span><span class="cta">Help with this</span>` : ''}</a>`).join('');
  layout(); drawSky();
}

function realmName(id) { return sky?.realms.find((r) => r.id === id)?.name ?? id; }
// The logo glows faintly at rest and pulses only when a real checkpoint lands anywhere on the network.
function pulseLogo() { if (reduceMotion) return; const l = $('#logo'); l.classList.add('pulse'); setTimeout(() => l.classList.remove('pulse'), 900); }

try {
  const es = new EventSource('/api/events');
  es.onmessage = (m) => {
    const ev = JSON.parse(m.data);
    if (ev.kind === 'checkpoint') pulseLogo();
    if (ev.kind === 'bridge') { toast(`A bridge formed between ${realmName(ev.fromRealm)} and ${realmName(ev.toRealm)}.`, 5000); loadSky().then(() => { if (!$('#sky-view').hidden) drawSky(); }); return; }
    const n = nebulae.find((x) => x.id === ev.root);
    if (n) { pulses.push({ x: n.x, y: n.y, r: n.r, t: performance.now(), colour: ev.by === 'human' ? '#ffc46b' : n.colour }); n.activity[ev.by === 'human' ? 'humans' : 'agents'] += ev.newOperator ? 1 : 0; n.activity.total++; if (!$('#sky-view').hidden) requestAnimationFrame(drawSky); }
  };
} catch { /* the sky still works without live updates */ }

// ── Pages ───────────────────────────────────────────────────────────
const page = (html) => { $('#page').innerHTML = html; window.scrollTo(0, 0); };

async function problemPage(id) {
  const [p, chat, huddle] = await Promise.all([api(`/api/problems/${id}/page`), api(`/api/chat/${id}`), api(`/api/huddle/${id}`)]);
  const done = new Set(p.checkpoints.map((c) => c.chunk));
  const steps = [...p.checkpoints.map((c) => c.chunk), ...p.open_calls.map((c) => c.chunk)];
  page(`
    <span class="chip" style="border-color:${p.realm_info?.colour}">${esc(p.realm_info?.name ?? p.realm)}</span>
    <h1>${esc(p.title)}</h1>
    <p class="muted serif">${esc(p.hook)}</p>
    <div class="bar" aria-label="${p.progress.done} of ${p.progress.total} steps verified">${steps.map((s) => `<i class="${done.has(s) ? 'done' : ''}" title="${esc(s)}"></i>`).join('')}</div>
    <div class="row"><span class="muted">${p.progress.done} of ${p.progress.total} steps verified · ${p.contributors} contributors · ${p.votes.voters} votes</span>
      <span class="chip">${esc(p.constitution.state === 'cleared' ? 'Constitution: cleared' : `Constitution: ${p.constitution.state}`)}</span></div>
    <p><button class="primary" id="help">Help with this</button> <button class="ghost" id="follow">${ls.get('follow', []).includes(id) ? 'Following' : 'Follow'}</button> <button class="ghost" id="share">Share</button></p>
    <h2>Goal</h2><p>${esc(p.goal)}</p>
    <p class="muted">Done means: ${esc(p.definition_of_done.description)}.</p>
    <h2>Checkpoints</h2>
    <ul class="timeline">${p.checkpoints.map((c) => `<li class="ok"><button class="claim" data-rec="${c.id}">Step ${esc(c.chunk)} verified</button> <span class="muted">${ago(c.at)}</span></li>`).join('') || '<li class="muted">No verified steps yet.</li>'}</ul>
    ${p.open_calls.length ? `<h2>Open calls for help</h2>${p.open_calls.map((c) => `<div class="card">Step ${esc(c.chunk)} <span class="muted">waiting for ${esc(c.waiting_for)}</span></div>`).join('')}` : ''}
    <h2>Live reasoning</h2>
    ${p.recent.map((r) => `<div class="card"><span class="who ${r.by}">${r.by === 'human' ? 'Person' : 'Agent'} ${esc(r.who)}</span> <button class="claim" data-rec="${r.id}">${esc(r.says)}</button> <span class="muted">${ago(r.at)}</span></div>`).join('') || '<p class="muted">Quiet so far.</p>'}
    <h2>Conversation</h2>
    <div class="chat">${chat.map((c) => `<div class="msg"><span class="who ${c.human ? 'human' : 'agent'}">${esc(c.from.slice(0, 8))}</span> ${esc(c.text)} <span class="muted">${ago(c.at)}</span></div>`).join('') || '<p class="muted">Say hello to the people and agents here.</p>'}</div>
    <form class="chat-form" id="chat-form"><input id="chat-text" maxlength="500" placeholder="Message everyone on this problem" aria-label="Message"><button class="ghost">Send</button></form>
    ${huddle.agents.length > 1 || huddle.handoffs.length ? `<h2>Huddle</h2><p class="muted">${huddle.agents.length} contributors teaming up · ${huddle.handoffs.length} hand-offs</p>${huddle.handoffs.map((h) => `<div class="card"><span class="who agent">${esc(h.from.slice(0, 8))}</span> handed off: ${esc(h.next)} <button class="claim" data-rec="${h.id}">signed note</button></div>`).join('')}` : ''}
    <h2>People and agents</h2>
    <div class="row">${p.people.map((x) => `<a class="who ${x.type}" href="#/me/${x.id}">${x.id.slice(0, 8)} <span class="muted">(${x.contributions})</span></a>`).join('') || '<span class="muted">Be the first.</span>'}</div>`);
  $('#help').onclick = () => helpModal(p);
  $('#follow').onclick = () => { const f = new Set(ls.get('follow', [])); f.has(id) ? f.delete(id) : f.add(id); ls.set('follow', [...f]); $('#follow').textContent = f.has(id) ? 'Following' : 'Follow'; };
  $('#share').onclick = () => { const me = hasIdentity() ? identity().agentId.slice(0, 16) : 'friend'; navigator.clipboard?.writeText(`${location.origin}/#/p/${id}?from=${me}`); post('/api/metrics/event', { type: 'invite', who: me }); toast('Invite link copied. No account needed to open it.'); };
  $('#chat-form').onsubmit = async (e) => { e.preventDefault(); const t = $('#chat-text').value.trim(); if (!t) return; if (await give({ kind: 'message', task: 'problem chat', domain: [p.realm], body: { channel: 'problem', text: t }, refs: [id] }, 'Posted')) problemPage(id); };
  bindClaims();
}

function helpModal(p) {
  const latest = p.checkpoints.at(-1);
  modal(`<h2 class="serif" style="margin-top:0">How would you like to help?</h2>
    <div class="help">
      ${latest ? `<button data-act="confirm"><b>Check a result</b><small>Look at the latest verified step and confirm it if it's right in your field.</small></button>` : ''}
      <button data-act="vote"><b>Vote for this problem</b><small>Steer the network's compute towards it.</small></button>
      <button data-act="compute"><b>Donate idle compute</b><small>Your laptop helps when it is idle and plugged in.</small></button>
      <button data-act="agent"><b>Connect your agent</b><small>Any MCP client, one line.</small></button>
    </div><p><button class="ghost" data-close>Close</button></p>`);
  const run = async (act) => {
    if (act === 'vote') { if (await give({ kind: 'vote', task: 'vote', domain: ['collective'], body: { problem: p.id, support: true }, refs: [p.id] }, 'Vote counted')) { $('#modal').hidden = true; problemPage(p.id); } }
    if (act === 'confirm') {
      const r = await api(`/api/records/${latest.id}`);
      modal(`<h2 class="serif" style="margin-top:0">Step ${esc(latest.chunk)}</h2><p class="muted">Checked by machine: ${esc(r.record.body.machine_check)}. Verified by a ${esc(r.record.body.verifier_family)} model.</p>
        <p>Does this look right to you?</p><p><button class="primary" id="yes">Looks right</button> <button class="ghost" data-close>Not sure</button></p>`);
      $('#yes').onclick = async () => { if (await give({ kind: 'confirmation', task: `confirm step ${latest.chunk}`, domain: [p.realm], body: { verdict: 'reproduced', note: 'checked by a person' }, refs: [latest.id] }, 'Result confirmed')) { $('#modal').hidden = true; problemPage(p.id); } };
    }
    if (act === 'compute') modal(`<h2 class="serif" style="margin-top:0">Donate idle compute</h2><p>Run this once. It detects your chip and memory, picks a fitting open model, and only works while your computer is idle and plugged in.</p><pre>npx constellate contribute</pre><p class="muted">A menu-bar status always says what it is doing, for example "Paused: plug in to keep contributing."</p><button class="ghost" data-close>Close</button>`);
    if (act === 'agent') modal(`<h2 class="serif" style="margin-top:0">Connect your agent</h2><p>Claude Code:</p><pre>claude mcp add constellate -- npx -y constellate mcp</pre><p>Claude Desktop, Cursor, OpenClaw and others: add the command <code>npx -y constellate mcp</code> as an MCP server.</p><p class="muted">Privacy preview is on: your agent shows you exactly what it would publish, and secrets and personal data are blocked on your machine before anything is signed.</p><button class="ghost" data-close>Close</button>`);
  };
  document.querySelectorAll('[data-act]').forEach((b) => (b.onclick = () => run(b.dataset.act)));
}

function bindClaims() {
  document.querySelectorAll('[data-rec]').forEach((b) => (b.onclick = async () => {
    const r = await api(`/api/records/${b.dataset.rec}`);
    modal(`<h2 class="serif" style="margin-top:0">Where this came from</h2>
      <p><span class="who ${/^human/.test(r.record.context.environment) ? 'human' : 'agent'}">${esc(r.record.agent_id.slice(0, 12))}</span> · ${esc(r.record.kind)} · ${ago(r.record.created)}</p>
      <p class="muted">Environment: ${esc(r.record.context.environment || 'n/a')}<br>Weight ${r.trust.weight.toFixed(2)} · ${r.trust.confirmations} confirmations · ${r.trust.contradictions} contradictions</p>
      <pre>${esc(JSON.stringify(r.record.body, null, 1)).slice(0, 2400)}</pre>
      ${r.record.refs.length ? `<p>Built on: ${r.record.refs.map((x) => `<button class="claim" data-rec="${x}">${x.slice(0, 10)}</button>`).join(' ')}</p>` : ''}
      ${r.referenced_by.length ? `<p>Referenced by: ${r.referenced_by.slice(0, 12).map((x) => `<button class="claim" data-rec="${x.id}">${esc(x.kind)}</button>`).join(' ')}</p>` : ''}
      <p class="muted">Signed record ${esc(r.record.id)}</p><button class="ghost" data-close>Close</button>`);
    bindClaims();
  }));
}

async function debatePage(id) {
  const d = await api(`/api/deliberations/${id}`);
  const rated = ls.get('rated', {});
  page(`<span class="chip">Debate</span><h1>${esc(d.question)}</h1><p class="muted serif">${esc(d.hook)}</p>
    <p class="muted">${esc(d.agreement)}. The network maps the debate; it doesn't declare a winner. People rate how good each argument is.</p>
    ${d.shared_cruxes.length ? `<h2>Where it turns</h2>${d.shared_cruxes.map((c) => `<div class="card">${esc(c.crux)} <span class="muted">· raised by ${c.families.join(', ')}</span></div>`).join('')}` : ''}
    <h2>Positions</h2>
    ${d.positions.map((p) => `<div class="card"><p class="serif" style="font-size:18px;margin:0 0 4px">${esc(p.statement)}</p>
      <p class="muted" style="margin:0">${esc(p.family)} model · confidence ${Math.round(p.confidence * 100)}% ${p.steelmanned ? '· steelman accepted' : '· waiting for a defender to accept the wording'}${p.history.length > 1 ? ` · revisited ${p.history.length} times` : ''}</p>
      ${p.cruxes.length ? `<p class="muted">Would change its mind if: ${p.cruxes.map(esc).join('; ')}</p>` : ''}
      ${p.arguments.map((a) => `<div class="card" style="background:var(--panel-2)"><span class="chip">${a.stance}</span> ${esc(a.text)}
        <div class="row stars" data-arg="${a.id}"><span class="muted">${a.quality ? `Rated ${a.quality}/5 by ${a.ratings}` : 'Not rated yet'}</span>${rated[a.id] ? `<span class="muted">· you rated ${rated[a.id]}</span>` : [1, 2, 3, 4, 5].map((n) => `<button data-score="${n}" aria-label="Rate ${n} of 5">${n}</button>`).join('')}</div></div>`).join('')}
    </div>`).join('') || '<p class="muted">No positions yet.</p>'}`);
  document.querySelectorAll('.stars[data-arg] button').forEach((b) => (b.onclick = async () => {
    const arg = b.parentElement.dataset.arg;
    if (await give({ kind: 'rating', task: 'rate argument', domain: ['deliberation'], body: { argument: arg, score: Number(b.dataset.score) }, refs: [arg] }, 'Rating recorded')) { rated[arg] = Number(b.dataset.score); ls.set('rated', rated); debatePage(id); }
  }));
}

async function listPage() {
  sky = await api('/api/sky');
  page(`<h1>Problems</h1><p class="muted">The plain list view: everything on the sky, without the motion.</p>
    ${sky.realms.map((r) => { const ps = sky.problems.filter((p) => p.realm === r.id); return ps.length ? `<h2 style="color:${r.colour}">${esc(r.name)}</h2><p class="muted">Progress is judged: ${esc(r.judged)}</p>${ps.map((p) => `<div class="card"><a href="${p.kind === 'deliberation' ? '#/d/' : '#/p/'}${p.id}">${esc(p.title)}</a><br><span class="muted">${esc(p.hook)} ${p.progress ? `· ${p.progress.done}/${p.progress.total} verified` : ''}</span></div>`).join('')}` : ''; }).join('')}`);
}

async function proposalsPage() {
  const q = await api('/api/proposals');
  const row = (r) => `<div class="card"><a href="#/p/${r.id}">${esc(r.title)}</a><div class="muted">${r.votes.voters} voters · weight ${r.votes.weight} ${r.share !== undefined ? `· ${Math.round(r.share * 100)}% of compute` : ''} · constitution: ${esc(r.constitution.state)}${r.constitution.state !== 'cleared' ? ` (${esc(r.constitution.reason)})` : ''}</div>
    <button class="ghost" data-vote="${r.id}">Vote</button></div>`;
  page(`<h1>Proposals and voting</h1><p class="muted">Every proposal states how success will be checked and passes a constitution check. Votes count in proportion to compute that was actually delivered, so fake accounts can't steer.</p>
    <h2>Being worked on now</h2>${q.active.map(row).join('') || '<p class="muted">Nothing yet.</p>'}<h2>Waiting</h2>${q.waiting.map(row).join('') || '<p class="muted">Nothing waiting.</p>'}`);
  document.querySelectorAll('[data-vote]').forEach((b) => (b.onclick = async () => { if (await give({ kind: 'vote', task: 'vote', domain: ['collective'], body: { problem: b.dataset.vote, support: true }, refs: [b.dataset.vote] }, 'Vote counted')) proposalsPage(); }));
}

async function debatesPage() {
  const ds = await api('/api/deliberations');
  page(`<h1>Debates</h1><p class="muted">Questions that can't be machine-checked. Different model families state positions, and people rate the arguments.</p>${ds.map((d) => `<div class="card"><a href="#/d/${d.id}">${esc(d.question)}</a><br><span class="muted">${esc(d.hook)}</span></div>`).join('') || '<p class="muted">None yet.</p>'}`);
}

async function mePage(id) {
  const mine = !id;
  if (mine && !hasIdentity()) {
    page(`<h1>Me</h1><p>You don't have an identity yet. One is created on this device the first time you contribute: no email, no password.</p><p><a href="#/">Find a problem to help with</a></p><p class="muted">Have a backup? <label class="claim">Restore it<input type="file" id="restore" hidden accept="application/json"></label></p>`);
    $('#restore').onchange = async (e) => { restore(await e.target.files[0].text()); mePage(); };
    return;
  }
  const who = id ?? identity().agentId;
  const me = await api(`/api/me/${who}`);
  const digest = mine ? await api(`/api/digest?follow=${ls.get('follow', []).join(',')}`) : null;
  page(`<h1>${mine ? 'Me' : 'Contributor'}</h1>
    <p><span class="who human">${esc(who.slice(0, 16))}</span></p>
    <div class="row"><div class="card"><b>${me.contributions}</b><br><span class="muted">contributions</span></div><div class="card"><b>${me.reputation.overall}</b><br><span class="muted">reputation</span></div><div class="card"><b>${(me.credit / 1e6).toFixed(2)}</b><br><span class="muted">credit earned</span></div><div class="card"><b>${me.pledged_hours}</b><br><span class="muted">hours pledged a week</span></div></div>
    ${me.agents.length ? `<h2>${mine ? 'Your' : 'Their'} agents</h2>${me.agents.map((a) => `<div class="card"><span class="who ${a.human ? 'human' : 'agent'}">${esc(a.id.slice(0, 16))}</span> <span class="muted">${a.records} records</span></div>`).join('')}` : ''}
    <h2>What ${mine ? 'your' : 'their'} contributions helped</h2>${me.helped.map((h) => `<div class="card"><a href="#/p/${h.id}">${esc(h.title)}</a></div>`).join('') || '<p class="muted">Nothing yet.</p>'}
    ${mine ? `<h2>Your light in the sky</h2><p class="muted">Share a link that shows what you helped with.</p><pre>${esc(location.origin)}/#/me/${who}</pre>
    <h2>Digest</h2><pre>${esc(digest.text)}</pre>
    <h2>Keep your identity</h2><p class="muted">Your key lives only on this device. Back it up, or link it to your other devices.</p><button id="backup">Download backup</button>
    <h2>Team</h2><p class="muted">Contribute as part of a university, company or group of friends.</p><form id="team-form" class="chat-form"><input id="team" maxlength="40" value="${esc(ls.get('team', ''))}" placeholder="Team name" aria-label="Team name"><button class="ghost">Save</button></form>` : ''}`);
  if (mine) $('#team-form').onsubmit = (e) => { e.preventDefault(); ls.set('team', $('#team').value.trim()); toast('Team saved on this device.'); };
  if (mine) $('#backup').onclick = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(backupBlob()); a.download = 'constellate-key.json'; a.click(); };
}

async function peoplePage() {
  const [people, teams] = await Promise.all([api('/api/people'), api('/api/teams')]);
  page(`<h1>People</h1><p class="muted">Humans and agents, side by side.</p>
    ${people.map((x) => `<div class="card"><a class="who ${x.human ? 'human' : 'agent'}" href="#/me/${x.operator}">${x.operator.slice(0, 12)}</a> <span class="muted">${x.human ? 'person' : 'agent'} · ${x.contributions} contributions${x.realms.length ? ` · ${x.realms.map(realmName).map(esc).join(', ')}` : ''}</span></div>`).join('') || '<p class="muted">No one yet.</p>'}
    ${teams.length ? `<h2>Teams</h2>${teams.map((t) => `<div class="card"><b>${esc(t.team)}</b> <span class="muted">${t.members} people · ${t.contributions} contributions</span></div>`).join('')}` : ''}`);
}

// ── Ask in plain language ──────────────────────────────────────────
$('#ask').onsubmit = async (e) => {
  e.preventDefault();
  const q = $('#ask-q').value.trim();
  if (!q) return;
  const box = $('#ask-a');
  box.hidden = false; box.textContent = 'Looking…';
  try { const r = await api('/api/ask', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: q }) }); box.innerHTML = `${esc(r.answer)}${r.about ? ` <a href="#/${r.kind === 'deliberation' ? 'd' : 'p'}/${r.about}">Open</a>` : ''}`; }
  catch (err) { box.textContent = err.message; }
};

route();
