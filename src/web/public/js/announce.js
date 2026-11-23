// Announcements (docs/ANNOUNCE.md): the owner's outbox. What a machine checked, each item's tier and what it waits
// for, Approve and Skip, the dry run of what would go where, the X link, and Send. Nothing leaves this computer
// until Send is pressed; approval binds to the exact words.
import { esc, api, toast, STATIC } from './ui.js';

const post = (path) => api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });

export async function announcePage(page) {
  if (STATIC) { page('<div class="page narrow"><p class="muted">Announcements run on the owner’s computer.</p></div>'); return; }
  const v = await api('/api/announce').catch((e) => ({ error: e.message }));
  if (v.error) { page(`<div class="page narrow"><div class="eyebrow">Announcements</div><p class="muted">${esc(v.error)}</p></div>`); return; }
  draw(page, v);
}

function draw(page, v, sent = null) {
  const items = v.items;
  const dry = v.dry_run.filter((d) => d.ok);
  page(`<div class="page narrow" id="announce"><div class="eyebrow">Announcements</div>
    <h1 class="display" style="font-size:var(--d-md);margin:10px 0">Tell people what a machine checked</h1>
    <p class="muted" style="max-width:62ch">Only progress this computer re-checked itself, never more than “checked by machine, no person has reviewed it yet”. Nothing leaves this computer until you press Send. Sends to: ${v.sends_to.length ? esc(v.sends_to.join(', ')) : 'nowhere yet'} · automatic posting ${v.config.auto ? 'on, for the auto tier' : 'off'} · X by hand, from its link.</p>
    ${sent ? `<div class="card" id="an-sent" style="font-size:13.5px">${sent.length ? sent.map((s) => `<div>${s.ok ? 'Sent' : 'Not sent'}${s.sink ? ` to ${esc(s.sink)}` : ''}: ${esc(s.detail)}</div>`).join('') : 'Nothing was cleared to send.'}</div>` : ''}
    ${items.length ? items.map((i) => `<div class="card" data-item="${esc(i.id)}" style="margin-top:12px">
      <div class="spread"><span class="chip sm ${i.tier === 'founder' ? 'warn' : ''}"><span class="dot"></span>${i.tier === 'founder' ? 'Needs you' : 'Auto'} · ${esc(i.kind)}</span><span class="faint" style="font-size:12.5px">${esc(i.status)}</span></div>
      ${i.blocked ? `<p class="faint" style="font-size:13px">Blocked: ${esc(i.blocked)}. It can’t be approved.</p>` : `<pre style="white-space:pre-wrap;font-family:var(--sans);font-size:14px;margin:10px 0">${esc(i.text)}</pre>`}
      ${i.why?.length ? `<p class="faint" style="font-size:12.5px;margin:0">Waits for you because it ${esc(i.why.join('; '))}.</p>` : ''}
      <div class="row" style="gap:8px;margin-top:10px">${!i.blocked && !i.approved ? `<button class="btn sm primary" data-approve="${esc(i.id)}">Approve these words</button>` : ''}${i.status !== 'sent' ? `<button class="btn sm ghost" data-skip="${esc(i.id)}">Skip</button>` : ''}${i.x ? `<a class="btn sm ghost" href="${esc(i.x)}" target="_blank" rel="noopener">Post on X yourself</a>` : ''}</div>
    </div>`).join('') : '<p class="muted" style="margin-top:14px">Nothing to announce yet: progress shows up here once a step is checked by machine.</p>'}
    <div class="card" style="margin-top:16px"><div class="eyebrow">If you press Send</div>
      ${dry.length ? `<ul style="font-size:13.5px;margin:8px 0 0;padding-left:18px">${dry.map((d) => `<li>${esc(d.id)} → ${esc(d.sink ?? '')}</li>`).join('')}</ul>` : '<p class="faint" style="font-size:13px;margin:6px 0 0">Nothing is cleared to send.</p>'}
      <button class="btn primary" id="an-send" style="margin-top:10px" ${dry.length ? '' : 'disabled'}>Send</button></div>
  </div>`);
  const act = async (path, what) => { try { draw(page, await post(path)); toast(what); } catch (e) { toast(e.message, 5200); } };
  document.querySelectorAll('[data-approve]').forEach((b) => (b.onclick = () => act(`/api/announce/${b.dataset.approve}/approve`, 'Approved these exact words.')));
  document.querySelectorAll('[data-skip]').forEach((b) => (b.onclick = () => act(`/api/announce/${b.dataset.skip}/skip`, 'Skipped.')));
  const s = document.getElementById('an-send');
  if (s) s.onclick = async () => { s.disabled = true; try { const r = await post('/api/announce/send'); draw(page, r, r.sent); } catch (e) { toast(e.message, 5200); s.disabled = false; } };
}
