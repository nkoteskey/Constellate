// Inside the Constellate desktop app, the page can do what a website can't: lend this computer
// with one switch, download a free model, and connect agents with one click. On the web these
// cards never render (window.constellateDesktop only exists in the desktop app).
import { $, esc, icon, copy, toast } from './ui.js';

export const desk = typeof window !== 'undefined' ? window.constellateDesktop : undefined;
export const DESKTOP = !!desk;

const netLine = (x) => (x.state === 'online'
  ? `<span class="chip ok"><span class="dot"></span>On the x0x network${x.peers != null ? ` · ${x.peers} peer${x.peers === 1 ? '' : 's'}` : ''}</span>`
  : x.state === 'starting' || x.state === 'restarting' ? '<span class="chip"><span class="dot"></span>Joining the x0x network…</span>'
    : `<span class="chip warn" title="${esc(x.error ?? '')}"><span class="dot"></span>Working on this computer only</span>`);

/** "Lend this computer": one switch, with whatever it needs first (Ollama, a model) shown in plain steps. */
export async function lendCard(slot) {
  if (!desk || !slot) return;
  const draw = async () => {
    const s = await desk.status();
    const sg = s.suggestion;
    const pool = s.pool; // computers pooled with this one, with a model ready: nothing to install first (docs/CLUSTERS.md)
    const local = pool ? [] : [sg?.primary, sg?.verifier].filter((m) => m && m.run?.provider === 'ollama');
    const missing = s.ollama.running ? local.filter((m) => !s.ollama.models.some((x) => x === m.run.model || x === `${m.run.model}:latest`)) : [];
    const on = s.settings.contribute;
    let body;
    if (!sg?.primary && !s.settings.model && !pool) body = `<p class="muted" style="margin:0">${esc(sg?.notes?.[0] ?? 'No free open model fits this computer.')} You can still lend it with a hosted model: choose one below.</p>`;
    else if (local.length && !s.ollama.running) body = `<p class="muted" style="margin:0">The free models run in <b>Ollama</b>, a small free app. Install it, open it, then come back here.</p>
      <div class="row" style="margin-top:12px"><button class="btn primary" id="dk-ollama">Get Ollama</button><button class="btn ghost" id="dk-recheck">I’ve installed it</button></div>`;
    else if (missing.length) body = `<p class="muted" style="margin:0">One download and you’re ready: ${missing.map((m) => `<b>${esc(m.name)}</b> (~${m.needGB} GB)`).join(' and ')}. Free, open weights, and it stays on this computer.</p>
      <div class="row" style="margin-top:12px"><button class="btn primary" id="dk-pull">Download ${missing.length > 1 ? 'both' : 'it'}</button></div><div id="dk-progress" class="faint" style="font-size:13px;margin-top:8px"></div>`;
    else body = `<p class="muted" style="margin:0">${on ? 'Lending this computer within the limits below. It stops when you need it.' : `Ready: ${pool ? `${esc(pool.model)} on ${esc(pool.what)}` : `${esc(sg?.primary?.name ?? s.settings.model)}${sg?.verifier ? ` with ${esc(sg.verifier.name)} as the checker` : ''}`}. It helps only within the limits below, and only while this computer is idle. Off until you start it.`}</p>
      <div class="row" style="margin-top:12px"><button class="btn ${on ? '' : 'primary'}" id="dk-toggle" aria-pressed="${on}">${on ? 'Stop lending' : 'Start lending'}</button>
      <label class="row faint" style="gap:6px;font-size:13px"><input type="checkbox" id="dk-login" ${s.settings.openAtLogin ? 'checked' : ''}> Open at login</label></div>
      ${s.contribute?.state === 'failed' ? `<p class="faint" style="font-size:13px;color:var(--warn);margin:8px 0 0">${esc(s.contribute.error)}</p>` : ''}`;
    // The limits it lends within, set once, and a log of every step that ran (src/contributor/lend.ts).
    const lg = desk.lendLog ? await desk.lendLog().catch(() => null) : null;
    slot.innerHTML = `<div class="card"><div class="spread"><b>This computer</b>${netLine(s.x0x)}</div><div style="margin-top:10px">${body}</div>${lg ? limitsHtml(lg, on) : ''}</div>`;
    wireLimits(slot, draw);
    $('#dk-ollama', slot)?.addEventListener('click', () => desk.getOllama());
    $('#dk-recheck', slot)?.addEventListener('click', draw);
    $('#dk-login', slot)?.addEventListener('change', (e) => desk.openAtLogin(e.target.checked));
    $('#dk-pull', slot)?.addEventListener('click', async (e) => {
      e.target.disabled = true;
      const prog = $('#dk-progress', slot);
      const off = desk.onPullProgress((p) => { prog.textContent = `${p.model}: ${Math.round(p.progress * 100)}%`; });
      try { for (const m of missing) await desk.pull(m.run.model); toast('Downloaded. Ready to lend this computer.'); } catch (err) { toast(`Download stopped: ${err.message}`); }
      off(); draw();
    });
    $('#dk-toggle', slot)?.addEventListener('click', async (e) => {
      e.target.disabled = true;
      const r = await desk.contribute(!on);
      if (!r.ok) toast(r.error); else toast(on ? 'Stopped. Thanks for helping.' : 'Lending this computer. Thank you.');
      draw();
    });
  };
  await draw();
}

const hh = (h) => `${String(h).padStart(2, '0')}:00`;
const ago = (iso) => { const m = Math.round((Date.now() - Date.parse(iso)) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : new Date(iso).toLocaleDateString(); };
function limitsHtml(lg, on) {
  const l = lg.limits;
  const used = Math.round((lg.used_tonight_seconds / 3600) * 10) / 10;
  const opt = (v, cur, label) => `<option value="${v}"${v === cur ? ' selected' : ''}>${label}</option>`;
  return `<div class="device-fields" id="dk-limits" style="margin-top:14px">
      <label>Starts at<select id="lim-start">${Array.from({ length: 24 }, (_, h) => opt(h, l.nightStart, hh(h))).join('')}</select></label>
      <label>Hours per night<select id="lim-hours">${[1, 2, 3, 4, 6, 8, 10, 12].map((h) => opt(h, l.hoursPerNight, `${h} h`)).join('')}</select></label>
      <label>CPU cap<select id="lim-cpu">${[25, 50, 75, 100].map((c) => opt(c, l.cpuCapPct, c === 100 ? 'No cap' : `${c}%`)).join('')}</select></label>
      <label style="display:flex;flex-direction:row;align-items:center;gap:8px;align-self:end"><input type="checkbox" id="lim-batt" ${l.neverOnBattery ? 'checked' : ''}> Never on battery</label>
    </div>
    <p class="faint" style="font-size:12.5px;margin:8px 0 0">From ${hh(l.nightStart)} to ${hh((l.nightStart + l.hoursPerNight) % 24)}, only while idle${l.neverOnBattery ? ' and plugged in' : ''}, using at most ${l.cpuCapPct}% of the time.${on ? ` Tonight: ${used} of ${l.hoursPerNight} h used.` : ''} Pledged to the network as ${l.hoursPerNight * 7} hours a week while it’s on; your votes count once that time is delivered as checked work.</p>
    <h3 class="eyebrow" style="margin-top:14px">What ran</h3>
    ${lg.log.length ? `<ul class="lend-log" style="list-style:none;padding:0;margin:6px 0 0;font-size:13px">${lg.log.slice(0, 12).map((e) => `<li class="spread" style="padding:6px 0;border-top:1px solid var(--line);gap:10px"><span>${e.did === 'checked' ? 'Checked' : 'Worked on'} <a href="#/p/${esc(e.problem)}">${esc(e.title)}</a> · ${esc(e.step)} <span class="faint">(${esc(e.model)}, ${e.seconds} s)</span></span><span class="faint" style="white-space:nowrap">${esc(e.outcome)} · ${ago(e.at)}</span></li>`).join('')}</ul>` : `<p class="faint" style="font-size:13px;margin:6px 0 0">Nothing yet. ${on ? 'Each step it takes will show here.' : 'Off: nothing runs until you start lending.'}</p>`}`;
}
function wireLimits(slot, redraw) {
  const set = async (patch) => { await desk.lendLimits(patch); redraw(); };
  $('#lim-start', slot)?.addEventListener('change', (e) => set({ nightStart: Number(e.target.value) }));
  $('#lim-hours', slot)?.addEventListener('change', (e) => set({ hoursPerNight: Number(e.target.value) }));
  $('#lim-cpu', slot)?.addEventListener('change', (e) => set({ cpuCapPct: Number(e.target.value) }));
  $('#lim-batt', slot)?.addEventListener('change', (e) => set({ neverOnBattery: e.target.checked }));
}

/** One-click agent connections, plus the Claude Code command to copy. */
export async function connectCard(slot) {
  if (!desk || !slot) return;
  const draw = async () => {
    const s = await desk.status();
    const row = (id, a) => `<div class="spread" style="padding:10px 0;border-top:1px solid var(--line)"><span><b>${esc(a.name)}</b><span class="faint" style="display:block;font-size:12.5px">${a.connection === 'connected' ? 'Connected. Restart it if it was open.' : a.connection === 'other' ? 'Set up with a different copy of Constellate.' : a.connection === 'unreadable' ? 'Its settings file couldn’t be read, so it was left alone.' : a.present ? 'Installed on this computer.' : 'Not found on this computer.'}</span></span>
      ${a.connection === 'connected' ? `<button class="btn sm ghost" data-off="${id}">Disconnect</button>` : `<button class="btn sm ${a.present ? 'agent' : ''}" data-on="${id}" ${a.connection === 'unreadable' ? 'disabled' : ''}>Connect</button>`}</div>`;
    slot.innerHTML = `<div class="card"><div class="spread"><b>Connect with one click</b>${netLine(s.x0x)}</div>
      <p class="muted" style="font-size:13.5px;margin:6px 0 4px">Uses the Constellate inside this app, so there’s nothing else to install.</p>
      ${Object.entries(s.agents).map(([id, a]) => row(id, a)).join('')}
      <details class="more-options" style="margin-top:10px"><summary><span>Claude Code from a terminal instead</span></summary>
      <div class="copy-row" style="margin-top:8px"><pre class="code">${esc(s.claudeCode)}</pre><button class="btn" id="dk-cc">${icon.copy}Copy</button></div></details></div>`;
    $('#dk-cc', slot).onclick = () => copy(s.claudeCode, 'Command copied');
    slot.querySelectorAll('[data-on]').forEach((b) => (b.onclick = async () => { const r = await desk.connectAgent(b.dataset.on); if (r.ok) toast(b.dataset.on === 'claude-code' ? 'Connected. Start a new Claude Code session to use it.' : `Connected. Restart ${s.agents[b.dataset.on].name} to start using it.`); else if (r.error) toast(r.error); draw(); }));
    slot.querySelectorAll('[data-off]').forEach((b) => (b.onclick = async () => { const r = await desk.disconnectAgent(b.dataset.off); if (!r.ok && r.error) toast(r.error); draw(); }));
  };
  await draw();
}
