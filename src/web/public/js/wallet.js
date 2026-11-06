// Money in the browser: top up with a card (Stripe) or with USDC from MetaMask,
// set where your earnings go, and (for the hub's owner) pay contributors out.
// The page never holds a key: MetaMask signs, Stripe takes the card.
import { $, $$, esc, api, toast, ls, short } from './ui.js';

const CHAINS = {
  8453: { chainId: '0x2105', chainName: 'Base', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: ['https://mainnet.base.org'], blockExplorerUrls: ['https://basescan.org'] },
  84532: { chainId: '0x14a34', chainName: 'Base Sepolia', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: ['https://sepolia.base.org'], blockExplorerUrls: ['https://sepolia.basescan.org'] },
};
const usd = (micro) => `$${(micro / 1e6).toFixed(2)}`;
const hex = (s) => '0x' + Array.from(new TextEncoder().encode(s), (b) => b.toString(16).padStart(2, '0')).join('');
const pad = (h) => h.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const post = (p, b) => api(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });

async function metamask(chainId) {
  const eth = window.ethereum;
  if (!eth) throw new Error('No wallet found. Install MetaMask (or another browser wallet) and reload.');
  const [from] = await eth.request({ method: 'eth_requestAccounts' });
  try { await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CHAINS[chainId].chainId }] }); }
  catch (e) { if (e.code === 4902) await eth.request({ method: 'wallet_addEthereumChain', params: [CHAINS[chainId]] }); else throw e; }
  return { eth, from };
}
/** An ERC-20 transfer from the connected account. USDC has 6 decimals, the same as micro-dollars. */
async function sendUsdc(cfg, to, micro) {
  const { eth, from } = await metamask(cfg.chain_id);
  const data = `0xa9059cbb${pad(to)}${pad(BigInt(micro).toString(16))}`;
  const tx = await eth.request({ method: 'eth_sendTransaction', params: [{ from, to: cfg.token, data }] });
  return { eth, from, tx };
}
async function untilConfirmed(fn, onWait) {
  for (let i = 0; i < 120; i++) { const r = await fn(); if (!r.pending) return r; onWait?.(i); await new Promise((r2) => setTimeout(r2, 5000)); }
  throw new Error('Still waiting for confirmations. Try again in a few minutes; nothing is lost.');
}

/** The Me page's wallet section. Renders nothing when payments are off. */
export async function walletSection(el, account) {
  const cfg = await api('/api/funds/config').catch(() => ({ enabled: false }));
  if (!cfg.enabled) return;
  const a = await api(`/api/funds/account/${account}`);
  el.innerHTML = `<h2 class="section">Wallet ${cfg.mode === 'test' ? '<span class="chip sm warn"><span class="dot"></span>test mode, no real money</span>' : ''}</h2>
    <div class="card stack">
      <div class="spread"><span class="muted">Credit</span><b class="num" style="font-size:22px">${usd(a.balance)}</b></div>
      <p class="faint" style="font-size:12.5px;margin:0">Credit pays for skills and second opinions, sponsors problems, and is what you earn for confirmed work.</p>
      <div class="row">${[5, 20, 50].map((d) => `<button class="btn sm" data-topup="${d}">Add $${d}</button>`).join('')}</div>
      <div class="row">${cfg.stripe ? '<label class="row" style="gap:6px;font-size:13px"><input type="radio" name="pay" value="card" checked> Card</label>' : ''}${cfg.usdc ? `<label class="row" style="gap:6px;font-size:13px"><input type="radio" name="pay" value="usdc"${cfg.stripe ? '' : ' checked'}> USDC with MetaMask (${esc(cfg.usdc.network)})</label>` : ''}</div>
      <p id="w-status" class="faint" role="status" style="font-size:13px;margin:0"></p>
      ${cfg.usdc ? `<div class="spread" style="border-top:1px solid var(--line);padding-top:12px"><span class="muted" style="font-size:13.5px">Earnings are paid to ${a.payout_address ? `<code>${esc(short(a.payout_address))}</code>` : 'an address you choose'} in USDC on ${esc(cfg.usdc.network)}</span><button class="btn ghost sm" id="w-payout">${a.payout_address ? 'Change' : 'Use my MetaMask address'}</button></div>` : ''}
      ${a.history.length ? `<details class="raw"><summary>History</summary>${a.history.slice(-10).reverse().map((h) => `<div class="spread" style="font-size:13px"><span>${esc(h.type)} · ${esc(h.source)}</span><span class="num">${h.account === account && h.type !== 'deposit' ? '−' : '+'}${usd(h.amount)}</span></div>`).join('')}</details>` : ''}
    </div>`;
  const status = (t) => { $('#w-status', el).textContent = t; };
  $$('[data-topup]', el).forEach((b) => (b.onclick = async () => {
    const dollars = Number(b.dataset.topup);
    const how = $('input[name=pay]:checked', el)?.value;
    try {
      if (how === 'card') { status('Opening a secure Stripe checkout…'); const r = await post('/api/funds/stripe/checkout', { account, amount_cents: dollars * 100 }); location.href = r.url; return; }
      status('Confirm the transfer in MetaMask…');
      const { eth, from, tx } = await sendUsdc(cfg.usdc, cfg.usdc.deposit_address, dollars * 1e6);
      status('Sign once more to prove this transfer is yours (free, no gas)…');
      const signature = await eth.request({ method: 'personal_sign', params: [hex(`Constellate: credit ${account} with ${tx.toLowerCase()}`), from] });
      ls.set('pendingClaim', { account, tx, signature });
      const r = await untilConfirmed(() => post('/api/funds/usdc/claim', { account, tx, signature }), (i) => status(`Waiting for ${cfg.usdc.network} to confirm… (${(i + 1) * 5} s)`));
      ls.set('pendingClaim', null);
      toast(`${usd(r.amount)} added.`); walletSection(el, account);
    } catch (e) { status(e.message ?? String(e)); }
  }));
  $('#w-payout', el)?.addEventListener('click', async () => {
    try {
      const { from } = await metamask(cfg.usdc.chain_id);
      const { contribute } = await import('../identity.js');
      await contribute({ kind: 'payout_address', task: 'payout address', domain: ['payments'], body: { address: from, chain: cfg.usdc.chain_id === 8453 ? 'base' : 'base-sepolia' } });
      toast('Payout address saved, signed by you.'); walletSection(el, account);
    } catch (e) { status(e.message ?? String(e)); }
  });
  // A claim interrupted by closing the tab resumes here.
  const pending = ls.get('pendingClaim', null);
  if (pending?.account === account) { status('Finishing a USDC top-up you started…'); untilConfirmed(() => post('/api/funds/usdc/claim', pending)).then((r) => { ls.set('pendingClaim', null); toast(`${usd(r.amount)} added.`); walletSection(el, account); }).catch((e) => status(e.message)); }
}

/** The owner's treasury: who is owed, pay them from MetaMask; the Autonomi wallet. Local machine only. */
export async function treasuryPage(page) {
  const cfg = await api('/api/funds/config').catch(() => ({ enabled: false }));
  const owed = cfg.enabled && cfg.usdc ? await api('/api/funds/owed').catch((e) => ({ error: e.message })) : [];
  const got = await api('/api/funds/autonomi').catch(() => null);
  const auto = got && (got.health || got.error) ? got : null; // not in use unless the hub runs with CONSTELLATE_ARCHIVE=autonomi
  page(`<div class="page narrow"><div class="eyebrow">Treasury · only on this machine</div><h1 class="display" style="font-size:var(--d-md);margin:10px 0">Money in, money out</h1>
    ${cfg.enabled ? `<p class="muted">Payments are <b>${cfg.mode === 'live' ? 'live: real money' : 'in test mode'}</b>. Deposits arrive at <code>${esc(cfg.usdc?.deposit_address ?? '(no USDC address set)')}</code>${cfg.stripe ? ' and through Stripe' : ''}.</p>` : '<p class="muted">Payments are off. See docs/MAINNET.md to turn them on, in test mode first.</p>'}
    ${owed.error ? `<p class="muted">${esc(owed.error)}</p>` : owed.length ? `<h2 class="section">Owed to contributors</h2><div class="stack">${owed.map((o) => `<div class="card spread"><span><b class="num">${usd(o.amount)}</b> <span class="faint">to ${short(o.account)}</span></span>${o.payout_address ? `<button class="btn sm" data-pay="${o.account}" data-to="${o.payout_address}" data-amount="${o.amount}">Pay with MetaMask</button>` : '<span class="faint" style="font-size:12.5px">no payout address yet</span>'}</div>`).join('')}</div>` : cfg.enabled ? '<p class="muted">Nobody is owed a payout yet.</p>' : ''}
    <p id="t-status" class="faint" role="status"></p>
    <h2 class="section">Autonomi storage</h2>
    ${auto && !auto.error ? `<div class="card stack"><div class="spread"><span>Wallet</span><code>${esc(auto.wallet ?? 'unknown')}</code></div><div class="spread"><span>ANT</span><span class="num">${esc(auto.ant_atto ?? '?')} atto</span></div><div class="spread"><span>ETH for gas</span><span class="num">${esc(auto.eth_wei ?? '?')} wei</span></div><div class="spread"><span>Today</span><span class="num">${esc(auto.spent_today_atto)} of ${esc(auto.daily_cap_atto)} atto cap</span></div><div class="spread"><span>Holds the index pointer key</span><span>${auto.holds_index_pointer_key ? 'yes' : 'no: check antd --pointer-keys'}</span></div><button class="btn sm" id="t-approve">Approve token spending (one time)</button><p class="faint" style="font-size:12.5px;margin:0">Fund this wallet with ANT and a little ETH on Arbitrum One, from MetaMask.</p></div>` : `<p class="muted">${auto?.error ? esc(auto.error) : 'Not in use. Records are archived on this machine until Autonomi is turned on.'}</p>`}
  </div>`);
  const st = (t) => { $('#t-status').textContent = t; };
  $$('[data-pay]').forEach((b) => (b.onclick = async () => {
    try {
      st('Confirm the payout in MetaMask…');
      const { tx } = await sendUsdc(cfg.usdc, b.dataset.to, Number(b.dataset.amount));
      await untilConfirmed(() => post('/api/funds/payout', { account: b.dataset.pay, tx, amount: Number(b.dataset.amount) }), (i) => st(`Waiting for confirmations… (${(i + 1) * 5} s)`));
      toast('Paid and recorded.'); treasuryPage(page);
    } catch (e) { st(e.message ?? String(e)); }
  }));
  $('#t-approve')?.addEventListener('click', async () => { st('Approving…'); const r = await post('/api/funds/autonomi/approve', {}).catch((e) => ({ error: e.message })); st(r.error ? r.error : 'Approved.'); });
}
