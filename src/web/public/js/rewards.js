// Rewards (docs/REWARDS.md): thank what worked, and the agents' spending wallet. Money moves only from the person's
// own wallet, or from the small, capped balance they put in the agent wallet.
import { esc, api, toast, ago } from './ui.js';
import { walletChoices, walletProvider } from './evm-wallet.js';

const usd = (micro) => `$${(Number(micro) / 1e6).toFixed(2)}`;
const postJson = (path, body) => api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

export async function rewardsCards(slot) {
  if (!slot) return;
  const [t, w] = await Promise.all([api('/api/thanks').catch(() => null), api('/api/agent-wallet').catch(() => null)]);
  if (!t || !w) { slot.innerHTML = ''; return; }
  const s = t.settings;
  slot.innerHTML = `<div class="card" id="thanks" style="margin:14px 0"><div class="spread"><div class="eyebrow">Thank what worked</div>
      <label class="row" style="gap:6px;font-size:13px;cursor:pointer"><input type="checkbox" id="th-on"${s.on ? ' checked' : ''}> On</label></div>
    <p class="muted" style="font-size:13.5px;margin:6px 0 0">When a fix works for your agents, ${usd(s.per_fix_micro)} goes to the people behind it: 70% to its author, 20% to whoever reported the problem, 10% to what it built on. At most ${usd(s.monthly_cap_micro)} a month. Paid from your wallet once someone is owed ${usd(s.pay_at_micro)}; thanks never expire.</p>
    ${t.owed.length ? `<div style="margin-top:10px;display:grid;gap:6px;font-size:13.5px">${t.owed.map((o) => `<div class="spread"><span>${usd(o.owed_micro)} owed to <a href="#/me/${esc(o.operator)}">${esc(o.operator.slice(0, 10))}</a> <span class="faint">for ${o.for.length} fix${o.for.length === 1 ? '' : 'es'}${o.paid_micro ? `, ${usd(o.paid_micro)} paid` : ''}${o.payout_address ? '' : ' · waiting for a payout address'}</span></span>${o.due ? `<button class="btn sm" data-thank="${esc(o.operator)}" ${t.can_send ? '' : 'disabled title="Needs real payments on and an x402 facilitator"'}>Send ${usd(o.owed_micro)}</button>` : ''}</div>`).join('')}</div>` : s.on ? '<p class="faint" style="font-size:12.5px;margin:8px 0 0">Nothing owed yet.</p>' : ''}
  </div>
  <div class="card" id="agent-wallet" style="margin:14px 0"><div class="eyebrow">Agents’ spending</div>
    <p class="muted" style="font-size:13.5px;margin:6px 0 0">A small balance your agents can pay from without asking each time: for storing through another computer, and paid skills and reviews. It holds only what you send it.</p>
    <div class="row" style="gap:14px;font-size:13.5px;margin-top:8px;flex-wrap:wrap"><span><b>${w.balance_micro === null ? '…' : usd(w.balance_micro)}</b> <span class="faint">USDC on Base</span></span><span><b>${usd(w.spent_today_micro)}</b> <span class="faint">of ${usd(w.daily_cap_micro)} today</span></span>${w.paused ? '<span class="chip sm warn"><span class="dot"></span>Paused</span>' : ''}</div>
    <div class="faint" style="font-size:12px;margin-top:4px;word-break:break-all">${esc(w.address)}</div>
    <div class="row" style="gap:8px;margin-top:10px;flex-wrap:wrap">
      <label style="font-size:13px">Add $<input class="field" id="aw-fund" type="number" min="1" max="50" step="1" value="5" style="width:70px"></label><button class="btn sm" id="aw-fund-go">Send from my wallet</button>
      <label style="font-size:13px">Daily cap $<input class="field" id="aw-cap" type="number" min="0" max="100" step="0.5" value="${(w.daily_cap_micro / 1e6).toFixed(2)}" style="width:80px"></label>
      <button class="btn sm ghost" id="aw-pause">${w.paused ? 'Resume' : 'Pause all agent spending'}</button></div>
    ${w.recent.length ? `<details style="margin-top:8px"><summary class="faint" style="font-size:12.5px">Recent spending</summary><div style="font-size:12.5px;display:grid;gap:4px;margin-top:6px">${w.recent.map((x) => `<div>${usd(x.amount_micro)} · ${esc(x.for)} · ${ago(x.at)}</div>`).join('')}</div></details>` : ''}
  </div>`;
  const redraw = () => rewardsCards(slot);
  slot.querySelector('#th-on').onchange = async (e) => { await postJson('/api/thanks', { on: e.target.checked }).catch((err) => toast(err.message)); redraw(); };
  slot.querySelectorAll('[data-thank]').forEach((b) => (b.onclick = async () => {
    b.disabled = true;
    try {
      const eth = await walletProvider(walletChoices()[0].id);
      const [payer] = await eth.request({ method: 'eth_requestAccounts' });
      const q = await postJson('/api/thanks/quote', { operator: b.dataset.thank, payer });
      const signature = await eth.request({ method: 'eth_signTypedData_v4', params: [payer, JSON.stringify(q.typed_data)] });
      await postJson('/api/thanks/pay', { id: q.id, signature });
      toast(`Sent ${usd(q.amount_micro)} in thanks.`);
    } catch (e) { toast(`Not sent: ${e.message}`, 6000); }
    redraw();
  }));
  slot.querySelector('#aw-cap').onchange = async (e) => { await postJson('/api/agent-wallet', { daily_cap_micro: Math.round(Number(e.target.value) * 1e6) }).catch((err) => toast(err.message)); redraw(); };
  slot.querySelector('#aw-pause').onclick = async () => { await postJson('/api/agent-wallet', { paused: !w.paused }).catch((err) => toast(err.message)); redraw(); };
  slot.querySelector('#aw-fund-go').onclick = async () => {
    try {
      const eth = await walletProvider(walletChoices()[0].id);
      const [from] = await eth.request({ method: 'eth_requestAccounts' });
      await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x2105' }] }).catch(() => {});
      const amount = BigInt(Math.round(Number(slot.querySelector('#aw-fund').value) * 1e6));
      if (amount <= 0n || amount > 50_000_000n) throw new Error('between $1 and $50');
      const data = `0xa9059cbb${w.address.slice(2).toLowerCase().padStart(64, '0')}${amount.toString(16).padStart(64, '0')}`; // USDC transfer(to, amount)
      await eth.request({ method: 'eth_sendTransaction', params: [{ from, to: USDC_BASE, data }] });
      toast('Sent. The balance updates once Base confirms it.');
    } catch (e) { toast(`Not sent: ${e.message}`, 6000); }
    redraw();
  };
}
