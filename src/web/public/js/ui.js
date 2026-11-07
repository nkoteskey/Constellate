// Shared UI building blocks for the Constellate app. No framework; small and fast.

export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
import { STATIC, staticApi } from './static.js';
export { STATIC };
export async function api(p, init) {
  if (STATIC) return staticApi(p, init);
  const r = await fetch(p, init); const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(j.error || r.statusText); return j;
}
export const post = (p, b) => (STATIC ? Promise.resolve() : fetch(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).catch(() => {}));
export const ls = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};
export function ago(iso) {
  // A static snapshot isn't live: show the date it happened, not a "minutes ago" that's already wrong.
  if (STATIC) return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
}
export function hash(s) {
  let h = 2166136261;
  for (const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  // Final avalanche (murmur3 fmix32) so near-identical inputs spread out.
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return (h >>> 0) / 4294967295;
}
export const short = (id) => `${id.slice(0, 4)}·${id.slice(4, 8)}`;

export const REALM = {
  maths_physics: { name: 'Mathematics and physics', short: 'Maths & physics', c: '#8fa8ff', judged: 'Machine-checked' },
  life_sciences: { name: 'Life sciences', short: 'Life sciences', c: '#6fe3b4', judged: 'Machine-scored, with extra safety review' },
  planet_energy: { name: 'Planet and energy', short: 'Planet & energy', c: '#a6dc6b', judged: 'Machine-scored' },
  philosophy_ethics: { name: 'Philosophy and ethics', short: 'Ethics', c: '#d4a6ff', judged: 'Deliberation maps, rated by people' },
  art_creativity: { name: 'Art and creativity', short: 'Art', c: '#ff9fb6', judged: 'Appreciated, not scored; people curate' },
};
export const realm = (r) => REALM[r] ?? { name: r, short: r, c: '#9aa0ae', judged: '' };

/** Every identity is drawn as its own small constellation: amber for people, blue for agents. */
export function identicon(id, human = false, size = 34) {
  const c = human ? '#ffc46b' : '#7cc4ff';
  const pts = Array.from({ length: 5 }, (_, i) => [6 + hash(id + 'x' + i) * (size - 12), 6 + hash(id + 'y' + i) * (size - 12)]);
  const lines = pts.slice(1).map((p, i) => `<line x1="${pts[i][0].toFixed(1)}" y1="${pts[i][1].toFixed(1)}" x2="${p[0].toFixed(1)}" y2="${p[1].toFixed(1)}" stroke="${c}" stroke-opacity=".7" stroke-width="1.1"/>`).join('');
  const dots = pts.map((p, i) => `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="${i === 0 ? 2.8 : 1.9}" fill="${i === 0 ? '#fff' : c}"/>`).join('');
  return `<svg class="ident" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true"><rect width="${size}" height="${size}" rx="${size / 2}" fill="${c}" fill-opacity=".1" stroke="${c}" stroke-opacity=".3"/>${lines}${dots}</svg>`;
}

/**
 * Progress drawn as a constellation: each checkable step is a star along a gentle arc.
 * Verified steps shine and are joined; steps in review ring amber; open steps are faint.
 */
export function constellation(steps, colour, { height = 120, label = '' } = {}) {
  const n = Math.max(1, steps.length);
  const W = 1000, H = height;
  // A gentle rising arc with a little irregularity, so it reads as a constellation, not a chart.
  const pts = steps.map((s, i) => {
    const t = n === 1 ? 0.5 : i / (n - 1);
    return { ...s, x: 30 + t * (W - 60), y: H * 0.62 - Math.sin(t * Math.PI * 0.9 + 0.15) * H * 0.3 + (hash(s.key) - 0.5) * H * 0.16 };
  });
  const lines = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const bright = a.state === 'done' && b.state === 'done';
    lines.push(`<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" stroke="${bright ? colour : '#ffffff'}" stroke-opacity="${bright ? 0.6 : 0.1}" stroke-width="${bright ? 3 : 2}" ${bright ? '' : 'stroke-dasharray="4 10"'}/>`);
  }
  const stars = pts.map((p) => {
    const t = `<title>${esc(p.title ?? p.key)}: ${p.state === 'done' ? 'verified' : p.state === 'review' ? 'awaiting review' : 'open'}</title>`;
    if (p.state === 'done') return `<g>${t}<circle cx="${p.x}" cy="${p.y}" r="34" fill="url(#glow)"/><circle cx="${p.x}" cy="${p.y}" r="9" fill="#fff"/></g>`;
    if (p.state === 'review') return `<g>${t}<circle cx="${p.x}" cy="${p.y}" r="14" fill="none" stroke="#ffc46b" stroke-width="3"/><circle cx="${p.x}" cy="${p.y}" r="5" fill="#ffc46b"/></g>`;
    return `<g>${t}<circle cx="${p.x}" cy="${p.y}" r="5.5" fill="#ffffff" fill-opacity=".3"/></g>`;
  }).join('');
  const gid = `g${Math.round(hash(colour + n + label) * 1e6)}`;
  return `<svg class="constellation" viewBox="0 0 ${W} ${H}" style="height:auto" role="img" aria-label="${esc(label)}"><defs><radialGradient id="${gid}"><stop offset="0" stop-color="${colour}" stop-opacity=".6"/><stop offset="1" stop-color="${colour}" stop-opacity="0"/></radialGradient></defs>${lines.join('')}${stars.replaceAll('url(#glow)', `url(#${gid})`)}</svg>`;
}

const I = (d) => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
export const icon = {
  check: I('<path d="M20 6 9 17l-5-5"/>'),
  vote: I('<path d="M4 13h16v7H4z"/><path d="M8 13V4h8v9"/><path d="m10 8.5 1.5 1.5 2.5-3"/>'), // a ballot going into a box: never an up/down arrow, which reads as a downvote
  chip: I('<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>'),
  agent: I('<circle cx="12" cy="12" r="3"/><circle cx="5" cy="6" r="1.5"/><circle cx="19" cy="7" r="1.5"/><circle cx="18" cy="18" r="1.5"/><path d="M6.2 7 10 10.5M17.6 8 14 10.7M16.9 16.8 14 13.8"/>'),
  chat: I('<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.4A8 8 0 1 1 21 12Z"/>'),
  share: I('<path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7"/><path d="m16 6-4-4-4 4"/><path d="M12 2v14"/>'),
  follow: I('<path d="M12 21s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 11c0 5.6-7 10-7 10Z"/>'),
  copy: I('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a1 1 0 0 1 1-1h10"/>'),
  search: I('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>'),
  back: I('<path d="M15 18 9 12l6-6"/>'),
  arrow: I('<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>'),
  shield: I('<path d="M12 3 4 6v6c0 5 3.4 8 8 9 4.6-1 8-4 8-9V6Z"/>'),
  star: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="m12 3 2.6 5.6 6.1.7-4.5 4.2 1.2 6L12 16.6 6.6 19.5l1.2-6L3.3 9.3l6.1-.7Z"/></svg>',
  failure: I('<circle cx="12" cy="12" r="9"/><path d="M12 7v6"/><path d="M12 17h.01"/>'),
  memory: I('<rect x="4" y="5" width="16" height="14" rx="2"/><path d="M8 9h8M8 13h5"/>'),
  skill: I('<path d="m12 3 2.5 5 5.5.8-4 3.9.9 5.5L12 15.6 7.1 18.2 8 12.7 4 8.8 9.5 8Z"/>'),
  review: I('<circle cx="12" cy="12" r="3"/><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/>'),
};

export function toast(msg, ms = 3400) {
  let t = $('#toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast glass'; t.setAttribute('role', 'status'); t.setAttribute('aria-live', 'polite'); document.body.append(t); }
  t.textContent = msg; t.hidden = false;
  t.style.animation = 'none'; void t.offsetWidth; t.style.animation = '';
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), ms);
}

let lastFocus = null;
export function sheet(html, { label = 'Dialog' } = {}) {
  closeSheet();
  lastFocus = document.activeElement;
  const s = document.createElement('div');
  s.className = 'sheet'; s.id = 'sheet';
  s.innerHTML = `<div class="sheet-body glass" role="dialog" aria-modal="true" aria-label="${esc(label)}">${html}</div>`;
  s.addEventListener('click', (e) => { if (e.target === s || e.target.closest('[data-close]')) closeSheet(); });
  document.body.append(s);
  const f = s.querySelector('button, a, input, [tabindex]');
  f?.focus();
  return s.firstElementChild;
}
export function closeSheet() { $('#sheet')?.remove(); lastFocus?.focus?.(); }
addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(); });

export async function copy(text, what = 'Copied') {
  try { await navigator.clipboard.writeText(text); toast(`${what}.`); } catch { toast('Copy: select the text and copy it.'); }
}
