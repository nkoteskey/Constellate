// Bounties (docs/BOUNTIES.md): questions with money set aside. Anyone can answer; only this computer
// posts its own and picks the answer, because the money comes from this computer's balance.
import { $, $$, esc, api, ago, short, toast, sheet, closeSheet, STATIC } from './ui.js';

const usd = (m) => `$${(m / 1e6).toFixed(m % 1e6 ? 2 : 0)}`;
const left = (iso) => { const d = Math.ceil((Date.parse(iso) - Date.now()) / 86_400_000); return d > 1 ? `${d} days left` : d === 1 ? 'last day' : 'deadline passed'; };
const how = (b) => (b.accept === 'check' ? 'Paid automatically to the first answer that passes the check' : 'The asker picks the answer');
const STATE = { paid: 'Paid', refunded: 'Refunded', expired: 'Deadline passed', open: 'Open', not_held: 'Not funded' };
const post = (p, body) => api(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/** Draws the bounties section into `slot`. `give` signs and sends a person's record (from app.js). */
export async function bountiesSection(slot, give) {
  if (STATIC || !slot) return;
  const [d, mine] = await Promise.all([api('/api/bounties').catch(() => null), api('/api/bounties/mine').catch(() => null)]);
  if (!d) { slot.remove(); return; }
  const play = d.network === 'constellate-credit:play';
  const others = d.bounties.filter((b) => b.asker !== d.me); // your own are listed under "Your bounties"
  const yours = mine?.bounties ?? [];
  slot.innerHTML = `<h2 class="section">Bounties</h2>
    <p class="faint" style="margin:-8px 0 12px;font-size:13px">Questions with money set aside. Answer one; if yours is picked, or passes the check, you’re paid. Nobody can take the money back once an answer earns it.</p>
    ${d.can_post ? `<div class="card spread" style="margin-bottom:12px"><div style="font-size:13.5px">You have <b>${usd(d.balance)}</b>${play ? ' of play money, for trying bounties safely' : ''}.</div><button class="btn primary sm" id="b-new">Offer a bounty</button></div>` : ''}
    ${others.length ? others.map((b) => `<div class="card"><div class="spread"><div class="serif" style="font-size:18px">${esc(b.question)}</div><span class="chip ok" style="flex-shrink:0"><span class="dot"></span>${usd(b.amount)}</span></div>
      <div class="spread" style="margin-top:8px"><span class="faint" style="font-size:12.5px">${esc(how(b))} · ${left(b.expires)} · ${b.answers ? `${b.answers} answer${b.answers === 1 ? '' : 's'}` : 'no answers yet'}</span>
      <button class="btn ghost sm" style="flex-shrink:0" data-bounty="${b.id}">Answer</button></div></div>`).join('')
      : `<p class="muted" style="font-size:13.5px">${yours.length ? 'No open bounties from anyone else right now.' : 'No open bounties right now.'}</p>`}
    ${yours.length ? `<h3 class="eyebrow" style="margin-top:18px">Your bounties</h3>${yours.map((b) => `<div class="card"><div class="spread"><div class="serif" style="font-size:17px">${esc(b.question)}</div><span class="chip sm" style="flex-shrink:0;white-space:nowrap">${usd(b.amount)} · ${STATE[b.state] ?? b.state}</span></div>
      ${b.answer_list.length ? b.answer_list.map((a) => `<div class="result" style="margin-top:8px"><div style="font-size:13.5px;white-space:pre-wrap">${esc(a.answer)}</div><div class="spread" style="margin-top:6px"><span class="faint" style="font-size:12px">${a.human ? 'a person' : `agent ${esc(short(a.by))}`} · ${ago(a.at)}</span>
        ${b.state === 'open' && b.accept === 'asker' ? `<button class="btn sm" data-award="${b.id}" data-answer="${a.id}">Pay this answer</button>` : b.paid_to.some((p) => p.answer === a.id) ? '<span class="chip ok sm">Paid</span>' : ''}</div></div>`).join('') : '<p class="faint" style="font-size:13px;margin:8px 0 0">No answers yet.</p>'}</div>`).join('')}` : ''}
    ${d.paid.length ? `<h3 class="eyebrow" style="margin-top:18px">Recently paid</h3>${d.paid.map((b) => `<div class="faint" style="font-size:13px;margin:4px 0">${usd(b.amount)} · ${esc(b.question.slice(0, 90))}</div>`).join('')}` : ''}`;

  const redraw = () => bountiesSection(slot, give);
  $$('[data-bounty]', slot).forEach((btn) => (btn.onclick = () => {
    const b = others.find((x) => x.id === btn.dataset.bounty);
    const el = sheet(`<div class="spread"><div class="eyebrow">Answer a bounty · ${usd(b.amount)}</div><button class="btn ghost sm" data-close>Close</button></div><h2 style="margin:6px 0 10px">${esc(b.question)}</h2>
      <p class="muted" style="font-size:13.5px">${esc(how(b))}. Your answer is signed and public.</p>
      <form id="b-ans" class="stack"><textarea class="field" id="b-ans-text" rows="5" maxlength="4000" required aria-label="Your answer"></textarea><div class="row"><button class="btn primary">Send answer</button></div></form>`, { label: 'Answer a bounty' });
    $('#b-ans', el).onsubmit = async (e) => {
      e.preventDefault();
      const t = $('#b-ans-text', el).value.trim();
      if (t && await give({ kind: 'answer', task: b.question.slice(0, 200), domain: b.domain.length ? b.domain : ['general'], body: { question: b.question, answer: t, proof: { type: 'citation', detail: b.accept === 'check' ? `checked with ${b.verifier}` : 'picked by the asker' } }, refs: [b.id] }, 'Answer sent')) { closeSheet(); redraw(); }
    };
  }));
  $$('[data-award]', slot).forEach((btn) => (btn.onclick = async () => {
    btn.disabled = true;
    try { await post(`/api/bounties/${btn.dataset.award}/award`, { answer: btn.dataset.answer }); toast('Paid. The answer’s author has the money.'); redraw(); }
    catch (e) { btn.disabled = false; toast(e.message, 5200); }
  }));
  const nb = $('#b-new', slot);
  if (nb) nb.onclick = () => {
    const el = sheet(`<div class="spread"><div class="eyebrow">Offer a bounty</div><button class="btn ghost sm" data-close>Close</button></div>
      <p class="muted" style="font-size:13.5px">The money is set aside now. You pick the answer; if you don’t pick by the deadline, it goes to answers other people confirmed, or comes back to you if there are none.</p>
      <form id="b-form" class="stack">
        <label>What do you need answered?<textarea class="field" id="b-q" rows="3" maxlength="2000" required></textarea></label>
        <div class="row"><label>Amount ($)<input class="field" id="b-usd" type="number" min="0.5" step="0.5" value="5" required></label>
        <label>Deadline<select class="field" id="b-days"><option value="3">3 days</option><option value="7" selected>7 days</option><option value="30">30 days</option></select></label></div>
        <div class="row"><button class="btn primary">Set aside and post</button></div></form>`, { label: 'Offer a bounty' });
    $('#b-form', el).onsubmit = async (e) => {
      e.preventDefault();
      try { await post('/api/bounties', { question: $('#b-q', el).value.trim(), usd: Number($('#b-usd', el).value), days: Number($('#b-days', el).value), accept: 'asker' }); closeSheet(); toast('Posted. The money is set aside.'); redraw(); }
      catch (err) { toast(err.message, 5200); }
    };
  };
}
