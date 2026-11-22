// Top up storage (src/economy/topup.ts): the person's USDC on Base becomes ANT (and a little gas) in this
// computer's Autonomi wallet. Every step is signed in the person's own wallet; the app never holds their money.
import { esc, api, toast, sheet, closeSheet, $ } from './ui.js';
import { walletChoices, walletProvider } from './evm-wallet.js';

const BASE_HEX = '0x2105';
const pad = (hex) => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const token = (atto, dec = 18) => { const n = Number(BigInt(atto)) / 10 ** dec; return n >= 100 ? n.toFixed(0) : n >= 1 ? n.toFixed(2) : n.toPrecision(3); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function receipt(eth, hash) {
  for (let i = 0; i < 120; i++) { const r = await eth.request({ method: 'eth_getTransactionReceipt', params: [hash] }); if (r) return r; await wait(2000); }
  throw new Error('the transaction is taking too long; check it in your wallet');
}

/** Exact-amount approval for each contract the quote names, only where the allowance is short. */
async function approveExact(eth, from, approvals) {
  for (const a of approvals) {
    const have = BigInt(await eth.request({ method: 'eth_call', params: [{ to: a.token, data: `0xdd62ed3e${pad(from)}${pad(a.spender)}` }, 'latest'] }));
    if (have >= BigInt(a.amount)) continue;
    const hash = await eth.request({ method: 'eth_sendTransaction', params: [{ from, to: a.token, data: `0x095ea7b3${pad(a.spender)}${pad(BigInt(a.amount).toString(16))}` }] });
    await receipt(eth, hash);
  }
}

export function topUpSheet(onDone) {
  const choices = walletChoices();
  let eth = null;
  const el = sheet(`<div class="spread"><div class="eyebrow">Top up storage</div><button class="btn ghost sm" data-close>Close</button></div>
    <p class="muted" style="font-size:13.5px">Turns USDC on Base into ANT (and a little ETH for fees) in this computer’s Autonomi wallet, which pays for storing what you share. You sign each step in your own wallet; nobody else holds your money.</p>
    <form class="stack" id="tu-form">
      <div class="stack" style="gap:6px">${choices.map((c, i) => `<label class="row" style="gap:8px;cursor:pointer;align-items:flex-start"><input type="radio" name="tu-wallet" value="${c.id}"${i === 0 ? ' checked' : ''} style="margin-top:4px"><span><b>${esc(c.name)}</b><span class="faint" style="display:block;font-size:12.5px">${esc(c.note)}</span></span></label>`).join('')}</div>
      <label>Amount (USD)<input class="field" id="tu-usd" type="number" min="1" max="50" step="1" value="5"></label>
      <div class="row"><button class="btn primary">Connect and get a quote</button><button class="btn ghost" type="button" id="tu-buy">No USDC yet? Buy some by card</button></div></form>
    <div id="tu-out" style="margin-top:10px"></div>
    <p class="faint" style="font-size:12px;margin-top:10px">Quotes come from LI.FI, a public swap service, which sees your wallet address and this computer’s storage wallet address.</p>`, { label: 'Top up storage' });
  // No USDC yet: Coinbase Onramp sells it by card, delivered to the wallet chosen above (src/economy/onramp.ts).
  $('#tu-buy', el).onclick = async () => {
    const out = $('#tu-out', el);
    try {
      eth = await walletProvider($('input[name="tu-wallet"]:checked', el)?.value);
      const [address] = await eth.request({ method: 'eth_requestAccounts' });
      const { url } = await api('/api/onramp', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ address, usd: Math.max(2, Number($('#tu-usd', el).value) || 5) }) });
      window.open(url, '_blank', 'noopener');
      out.innerHTML = '<p class="faint" style="font-size:13px">Coinbase opened in a new tab. Once the USDC arrives in your wallet, get a quote here.</p>';
    } catch (err) { out.innerHTML = `<p class="faint" style="font-size:13px">${esc(err.message)}</p>`; }
  };
  $('#tu-form', el).onsubmit = async (e) => {
    e.preventDefault();
    const out = $('#tu-out', el);
    try {
      eth = await walletProvider($('input[name="tu-wallet"]:checked', el)?.value);
      const [from] = await eth.request({ method: 'eth_requestAccounts' });
      await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: BASE_HEX }] }).catch(() => {});
      out.innerHTML = '<span class="faint">Getting a quote…</span>';
      const q = await api('/api/storage-wallet/quote', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from, usd: Number($('#tu-usd', el).value) }) });
      out.innerHTML = `<div class="card stack" style="font-size:13.5px">
        ${q.legs.map((l) => `<div class="spread"><span>${esc(l.what)}: $${l.from_usd.toFixed(2)}</span><span class="num">≈ ${token(l.to_amount)} ${l.what.startsWith('ANT') ? 'ANT' : 'ETH'} <span class="faint">(at least ${token(l.to_amount_min)})</span></span></div>`).join('')}
        <div class="faint" style="font-size:12.5px">Fees about $${q.legs.reduce((n, l) => n + l.fee_usd, 0).toFixed(2)} · via ${esc([...new Set(q.legs.map((l) => l.tool))].join(', '))} · about ${Math.max(...q.legs.map((l) => l.seconds))} s · to ${esc(q.storage_wallet.slice(0, 10))}…</div>
        <p class="faint" style="font-size:12.5px;margin:0">${esc(q.note)}</p>
        <button class="btn primary" id="tu-go" ${q.can_send ? '' : 'disabled'}>Approve and top up</button></div>`;
      const go = $('#tu-go', el);
      if (go) go.onclick = async () => {
        go.disabled = true;
        try {
          out.insertAdjacentHTML('beforeend', '<p class="faint" id="tu-step" style="font-size:12.5px">Approving the exact amount in your wallet…</p>');
          await approveExact(eth, from, q.approve);
          for (const l of q.legs) {
            $('#tu-step', el).textContent = `Sending: ${l.what}…`;
            const hash = await eth.request({ method: 'eth_sendTransaction', params: [{ from, to: l.tx.to, data: l.tx.data, value: l.tx.value, ...(l.tx.gasLimit ? { gas: l.tx.gasLimit } : {}) }] });
            for (let i = 0; i < 90; i++) { const s = await api(`/api/storage-wallet/status?tx=${hash}`).catch(() => ({ status: 'PENDING' })); if (s.status === 'DONE') break; if (s.status === 'FAILED') throw new Error(`${l.what} didn’t go through: ${s.substatus ?? 'failed'}`); $('#tu-step', el).textContent = `${l.what}: on its way to Arbitrum…`; await wait(4000); }
          }
          toast('Topped up. Storing what you share is ready.');
          closeSheet(); onDone?.();
        } catch (err) { toast(`Not completed: ${err.message}`, 6000); go.disabled = false; }
      };
    } catch (err) { out.innerHTML = `<p class="faint" style="font-size:13px">${esc(err.message)}</p>`; }
  };
}
