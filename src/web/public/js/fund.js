// The storage fund and the permanent library (docs/STORAGE.md): the network pays to keep what earned its
// place, so nobody pays to share. Anyone can see where the money went; this computer can give to it.
import { $, esc, api, ago, toast, sheet, closeSheet, STATIC } from './ui.js';

const usd = (m) => `$${(m / 1e6).toFixed(m % 1e6 ? 2 : 0)}`;
const mb = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);
const ant = (atto) => { const n = Number(BigInt(atto || '0')) / 1e18; return n === 0 ? null : `${n < 0.001 ? n.toExponential(1) : n.toFixed(4)} ANT`; };

export async function fundCard(slot) {
  if (STATIC || !slot) return;
  const f = await api('/api/fund').catch(() => null);
  if (!f) { slot.remove(); return; }
  const L = f.library;
  const play = f.network === 'constellate-credit:play';
  const week = f.last_week;
  slot.innerHTML = `<div class="card" style="margin:0 0 18px">
    <div class="spread"><div class="eyebrow">Keep the library permanent</div>${f.can_give ? '<button class="btn sm" id="fund-give">Give</button>' : ''}</div>
    <p class="muted" style="font-size:13.5px;margin:8px 0 10px;max-width:62ch">Sharing is free. A shared fund pays to keep what earned its place for good: problems, debates and summaries, lessons someone else confirmed, answers a bounty paid for, and topics people sponsor. Everything else stays on people’s computers and passes between them for free.</p>
    <div class="row" style="gap:18px;font-size:13.5px">
      <div><b>${L.archived.toLocaleString()}</b> <span class="muted">kept for good</span></div>
      <div><b>${L.waiting.toLocaleString()}</b> <span class="muted">waiting for the next upload</span></div>
      <div><b>${usd(f.given)}</b> <span class="muted">given by ${f.donors} ${f.donors === 1 ? 'person or agent' : 'people and agents'}</span></div>
      ${f.balance !== null ? `<div><b>${usd(f.balance)}</b> <span class="muted">in the fund here</span></div>` : ''}
    </div>
    <div class="faint" style="font-size:12.5px;margin-top:8px">${week.uploads ? `Last 7 days: ${week.uploads} upload${week.uploads === 1 ? '' : 's'}, ${mb(week.bytes)}${ant(week.atto_ant) ? `, ${ant(week.atto_ant)}` : ''}.` : 'No uploads in the last 7 days.'} ${L.archive === 'autonomi' ? 'Stored on Autonomi.' : 'Permanent storage (Autonomi) isn’t switched on yet; the library is kept on this computer until it is.'}</div>
    ${f.topics.length ? `<div class="row" style="gap:6px;margin-top:10px">${f.topics.slice(0, 8).map((t) => `<span class="chip sm" title="${t.sponsors} sponsor${t.sponsors === 1 ? '' : 's'}">${esc(t.topic)} · ${usd(t.amount)}</span>`).join('')}</div>` : ''}
    ${f.recent.length || f.spends.length ? `<details class="raw" style="margin-top:10px"><summary>Where the money went</summary><div style="display:grid;gap:4px;margin-top:8px;font-size:13px">
      ${f.spends.slice(0, 6).map((s) => `<div class="spread"><span>Kept ${s.records} records, ${mb(s.bytes)}</span><span class="faint">${ant(s.atto_ant) ?? (s.archive === 'local' ? 'on this computer' : '')} · ${ago(s.at)}</span></div>`).join('')}
      ${f.recent.map((r) => `<div class="spread"><span>${r.type === 'gift' ? `Gift${r.topic ? ` to keep “${esc(r.topic)}”` : ''}` : `Withdrawn: ${esc(r.note ?? '')}`}</span><span class="faint">${usd(r.amount)} · ${ago(r.at)}</span></div>`).join('')}
    </div></details>` : ''}
  </div>`;
  const g = $('#fund-give', slot);
  if (g) g.onclick = () => {
    const el = sheet(`<div class="spread"><div class="eyebrow">Give to the storage fund</div><button class="btn ghost sm" data-close>Close</button></div>
      <p class="muted" style="font-size:13.5px">You have ${usd(f.my_balance)}${play ? ' of play money' : ''}. Give to the fund in general, or name a topic to make sure everything public in it is kept for good.</p>
      <form id="fund-form" class="stack">
        <div class="row"><label>Amount ($)<input class="field" id="fund-usd" type="number" min="0.5" step="0.5" value="5" required></label>
        <label>Topic (optional)<input class="field" id="fund-topic" maxlength="48" placeholder="e.g. rust, x0x, antibiotics"></label></div>
        <div class="row"><button class="btn primary">Give</button></div></form>`, { label: 'Give to the storage fund' });
    $('#fund-form', el).onsubmit = async (e) => {
      e.preventDefault();
      try { await api('/api/fund/give', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ usd: Number($('#fund-usd', el).value), topic: $('#fund-topic', el).value.trim() || undefined }) }); closeSheet(); toast('Thank you. It’s on the public record.'); fundCard(slot); }
      catch (err) { toast(err.message, 5200); }
    };
  };
}
