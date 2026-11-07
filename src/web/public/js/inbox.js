// Messages: every conversation this computer has had over x0x (introductions, replies, people who wrote
// first), one per person or agent, with an unread count on the Me tab. Read state stays in this browser.
import { $, $$, esc, api, ago, short, ls, identicon, STATIC } from './ui.js';

const seen = () => ls.get('dmSeen', {});
export const markSeen = (peer) => { ls.set('dmSeen', { ...seen(), [peer]: new Date().toISOString() }); void refreshBadge(); };
const unreadOf = (t) => t.incoming.filter((at) => at > (seen()[t.peer] ?? '')).length;
/** Names we know for a peer: a profile handle, or the group whose owner we introduced ourselves to. */
export const nameFor = (peer, profiles = []) => { const p = profiles.find((x) => x.id === peer || x.host === peer); return p?.handle ? `@${p.handle}` : ls.get('peerNames', {})[peer] ?? `Agent ${short(peer)}`; };
export const rememberName = (peer, name) => ls.set('peerNames', { ...ls.get('peerNames', {}), [peer]: name });

let last = '';
/** The unread count on the Me tab, and a notification for anything new (if the person turned them on). */
export async function refreshBadge() {
  if (STATIC) return;
  const r = await api('/api/inbox').catch(() => null);
  const badge = $('#me-badge');
  if (!r || !badge) return;
  const unread = r.threads.reduce((n, t) => n + unreadOf(t), 0);
  badge.hidden = !unread; badge.textContent = unread > 9 ? '9+' : String(unread);
  badge.setAttribute('aria-label', `${unread} unread message${unread === 1 ? '' : 's'}`);
  const newest = r.threads.find((t) => !t.last.from_me)?.last.at ?? '';
  if (last && newest > last && ls.get('notify', false) && typeof Notification !== 'undefined' && Notification.permission === 'granted' && document.visibilityState !== 'visible') {
    const t = r.threads.find((x) => x.last.at === newest);
    new Notification(`New message from ${nameFor(t.peer)}`, { body: t.last.text, tag: `dm-${t.peer}` });
  }
  if (newest > last) last = newest;
}
export function watchInbox(everyMs = 20_000) { if (STATIC) return; void refreshBadge(); setInterval(() => void refreshBadge(), everyMs); }

/** The Messages section on Me: open a conversation to read and reply. */
export async function inboxSection(slot, { open, profiles = [] }) {
  if (STATIC || !slot) return;
  const [r, groups] = await Promise.all([api('/api/inbox').catch(() => null), api('/api/x0x/groups').catch(() => ({ groups: [] }))]);
  if (!r) { slot.remove(); return; }
  // Someone who owns a public group is named after it, even if they wrote first.
  for (const g of groups.groups ?? []) if (g.owner && !ls.get('peerNames', {})[g.owner]) rememberName(g.owner, `Owner of ${g.name.slice(0, 40)}`);
  slot.innerHTML = `<h2 class="section" id="messages">Messages</h2>
    ${r.threads.length ? `<div class="stack">${r.threads.map((t) => { const u = unreadOf(t); return `<button class="card link inbox-row" data-peer="${t.peer}" style="text-align:left">
      <div class="row" style="gap:10px">${identicon(t.peer, false, 34)}<div style="min-width:0;flex:1">
        <div class="spread" style="gap:10px"><b style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(nameFor(t.peer, profiles))}</b><span class="faint" style="font-size:12px;flex:none;white-space:nowrap">${ago(t.last.at)}${u ? ` <span class="chip sm ok"><span class="dot"></span>${u} new</span>` : ''}</span></div>
        <div class="muted" style="font-size:13.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${t.last.from_me ? 'You: ' : ''}${esc(t.last.text)}</div>
      </div></div></button>`; }).join('')}</div>`
      : `<p class="muted" style="font-size:13.5px">No messages yet. When someone writes to you, or answers your introduction, it shows up here and on the Me tab. ${r.via === 'x0x' ? '' : 'Messages travel over x0x, so they need the desktop app (or a running x0x daemon).'}</p>`}`;
  $$('[data-peer]', slot).forEach((b) => (b.onclick = () => { markSeen(b.dataset.peer); open(b.dataset.peer, nameFor(b.dataset.peer, profiles)); }));
}
