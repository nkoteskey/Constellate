// Store what you shared permanently on Autonomi, paid by this computer's own wallet (src/hub/self-store.ts).
// A signed, timestamped receipt proves the contribution; publish it, or keep it to yourself.
import { esc, api, toast, ago } from './ui.js';
import { walletChoices, walletProvider } from './evm-wallet.js';

const mb = (b) => (b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);
const ant = (a) => (a && a !== '0' ? `${(Number(BigInt(a)) / 1e18).toPrecision(3)} ANT` : null);

export async function selfStoreCard(slot, me) {
  if (!slot) return;
  const q = await api(`/api/self-store${me ? `?also=${me}` : ''}`).catch(() => null);
  if (!q) { slot.innerHTML = ''; return; }
  // Computers that store for others, paid in USDC on Base with x402 (src/economy/storage-market.ts).
  const offers = q.archive !== 'autonomi' && q.waiting ? await api('/api/storage-offers').catch(() => []) : [];
  const usd = (micro) => `$${(Number(micro) / 1e6).toFixed(Number(micro) < 1e4 ? 4 : 2)}`;
  slot.innerHTML = `<div class="card" id="self-store" style="margin:14px 0"><div class="eyebrow">Store what you shared, for good</div>
    <p class="muted" style="font-size:13.5px;margin:6px 0 0">Sharing is free: your contributions live on everyone’s computers. To keep them permanently on Autonomi, this computer pays for exactly what you shared, from its own wallet. You get a signed, timestamped receipt that proves you contributed.</p>
    <p style="margin:10px 0 0;font-size:13.5px">${q.waiting ? `<b>${q.waiting}</b> contribution${q.waiting === 1 ? '' : 's'} not stored yet${q.next < q.waiting ? ` (the next upload takes ${q.next})` : ''}, about ${mb(q.bytes)}${ant(q.atto_ant) ? `, about ${ant(q.atto_ant)}` : ''}.` : 'Everything you shared is stored.'}</p>
    ${q.archive !== 'autonomi' ? '<p class="faint" style="font-size:12.5px;margin:6px 0 0">Autonomi isn’t set up on this computer, so this stores to the local archive for now (docs/MAINNET.md shows how to connect a wallet).</p>' : ''}
    ${q.archive === 'autonomi' ? '<button class="btn ghost sm" id="ss-topup" style="margin-top:10px">Top up storage with USDC on Base</button>' : ''}
    ${offers.length ? `<div style="margin-top:12px" id="ss-offers"><div class="faint" style="font-size:12.5px">Or have a computer that stores for others do it, paid in USDC on Base from your wallet:</div>
      ${offers.slice(0, 3).map((o) => `<div class="spread" style="margin-top:6px;font-size:13.5px"><span>${usd(o.price_micro_usdc_per_mb)} per MB <span class="faint">(at least ${usd(o.min_micro_usdc)}) · ${o.checked_stores} checked store${o.checked_stores === 1 ? '' : 's'}</span></span><button class="btn sm" data-store-via="${esc(o.seller)}">Store through it</button></div>`).join('')}</div>` : ''}
    ${q.waiting ? `<label class="row" style="gap:8px;margin-top:10px;font-size:13.5px;cursor:pointer"><input type="checkbox" id="ss-private"> Keep my receipt private <span class="faint">(stored the same; the receipt stays on this computer until you share it)</span></label>
      <button class="btn primary" id="ss-go" style="margin-top:10px">Store them permanently</button>` : ''}
    ${q.receipts.length ? `<details style="margin-top:10px"><summary class="faint" style="font-size:12.5px">Your receipts (${q.receipts.length})</summary><div style="display:grid;gap:6px;margin-top:8px;font-size:13px">${q.receipts.map((r) => `<div class="spread"><span>${r.records} records, ${mb(r.bytes)}${ant(r.atto_ant) ? `, ${ant(r.atto_ant)}` : ''} · ${r.published ? 'published' : 'private'} · ${ago(r.at)}</span><a href="/api/self-store/proof/${esc(r.receipt)}" download="constellate-receipt-${esc(r.receipt.slice(0, 12))}.json">Download</a></div>`).join('')}</div></details>` : ''}
  </div>`;
  slot.querySelectorAll('[data-store-via]').forEach((b) => (b.onclick = async () => {
    b.disabled = true;
    try {
      const eth = await walletProvider(walletChoices()[0].id);
      const [payer] = await eth.request({ method: 'eth_requestAccounts' });
      const quote = await api(`/api/self-store/market/quote${me ? `?also=${me}` : ''}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ seller: b.dataset.storeVia, payer }) });
      if (!confirm(`Store ${quote.records} contributions (${Math.ceil(quote.bytes / 1024)} KB) for ${usd(quote.price_micro_usdc)} in USDC on Base? Your wallet will ask you to sign one payment authorization for exactly that amount.`)) return;
      const signature = await eth.request({ method: 'eth_signTypedData_v4', params: [payer, JSON.stringify(quote.typed_data)] });
      const r = await api('/api/self-store/market/pay', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: quote.id, signature, private: slot.querySelector('#ss-private')?.checked }) });
      toast(`Stored ${r.stored} contributions on Autonomi. Your receipt is ready.`);
    } catch (e) { toast(`Not stored: ${e.message}`, 6000); }
    selfStoreCard(slot, me);
  }));
  const top = slot.querySelector('#ss-topup');
  if (top) top.onclick = () => import('./topup.js').then((m) => m.topUpSheet(() => selfStoreCard(slot, me)));
  const go = slot.querySelector('#ss-go');
  if (go) go.onclick = async () => {
    go.disabled = true;
    try {
      const r = await api(`/api/self-store${me ? `?also=${me}` : ''}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ private: slot.querySelector('#ss-private').checked }) });
      toast(r.stored ? `Stored ${r.stored} contributions${r.archive === 'autonomi' ? ' on Autonomi' : ''}. Your receipt is ready.` : 'Nothing new to store.');
    } catch (e) { toast(`Not stored: ${e.message}`, 5200); }
    selfStoreCard(slot, me);
  };
}
