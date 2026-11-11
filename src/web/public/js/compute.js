// "Lend your computer": what this device can run, for free, and any model you'd rather bring.
// The browser can only estimate the hardware, so the person can correct it; the
// command line (`constellate models`) then checks precisely on the machine itself.
import { $, $$, esc, icon, copy, api, toast, STATIC } from './ui.js';
import { suggest, commands, RUN, PROVIDERS, FREE_HOSTED, CATALOG_UPDATED } from './models.js';
import { DESKTOP, desk, lendCard } from './desktop.js';

const VRAM = [[/rtx\s*(5090)/i, 32], [/rtx\s*(4090|3090)/i, 24], [/rtx\s*(5080|4080|4070\s*ti\s*super|4060\s*ti.*16)/i, 16], [/rtx\s*(5070|4070|3080\s*ti|3060)\b/i, 12], [/rtx\s*(3080)/i, 10], [/rtx\s*(4060|3070|3060\s*ti|2080|2070)/i, 8], [/rx\s*7900\s*xtx/i, 24], [/rx\s*7900/i, 20], [/rx\s*(7800|6800|6900)/i, 16], [/a100/i, 40], [/h100/i, 80]];

/** What the browser can tell about this device. Rough by nature, so it's shown as an estimate. */
export async function detectDevice() {
  const nav = navigator;
  const ua = nav.userAgent || '';
  const mobile = nav.userAgentData?.mobile ?? /Mobi|Android|iPhone|iPad/i.test(ua);
  let renderer = '';
  try { const gl = document.createElement('canvas').getContext('webgl'); const ext = gl?.getExtension('WEBGL_debug_renderer_info'); renderer = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : ''; } catch { /* private */ }
  let webgpu = false;
  try { webgpu = !!(await nav.gpu?.requestAdapter()); } catch { /* none */ }
  const mac = /Mac/i.test(nav.platform || ua) && !mobile;
  const chip = renderer.match(/Apple (M\d+(?: (?:Pro|Max|Ultra))?)/i)?.[1] ?? null;
  const appleSilicon = mac && (!!chip || /Apple/i.test(renderer));
  const gpuName = /nvidia|geforce|rtx|radeon|rx\s*\d/i.test(renderer) ? renderer.replace(/^ANGLE \(|\)$/g, '').split(',').find((x) => /nvidia|geforce|rtx|radeon/i.test(x))?.trim() ?? renderer : null;
  const gpuGB = gpuName ? (VRAM.find(([re]) => re.test(gpuName))?.[1] ?? 0) : 0;
  // deviceMemory is capped at 8 and missing in Safari and Firefox: start from a sensible guess the person can change.
  const memGuess = mobile ? 6 : chip && /Max|Ultra/i.test(chip) ? 64 : chip && /Pro/i.test(chip) ? 32 : (nav.deviceMemory ?? 8) >= 8 ? 16 : nav.deviceMemory ?? 8;
  return { mobile, appleSilicon, chip, gpuName, gpuGB, memGB: memGuess, cores: nav.hardwareConcurrency ?? null, webgpu };
}

// ── Lend this browser: a small open model runs right here with WebGPU, no install ──
// WebLLM is pinned to an exact release and loaded only when someone presses Start.
const WEBLLM = 'https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.84/+esm';
export const BROWSER_MODELS = [
  { id: 'Qwen3-0.6B-q4f16_1-MLC', name: 'Qwen3 0.6B', family: 'qwen', gb: 0.5, fits: 'phones and small laptops' },
  { id: 'Llama-3.2-1B-Instruct-q4f16_1-MLC', name: 'Llama 3.2 1B', family: 'llama', gb: 0.9, fits: 'most laptops' },
  { id: 'Qwen3-1.7B-q4f16_1-MLC', name: 'Qwen3 1.7B', family: 'qwen', gb: 1.2, fits: 'laptops with 8 GB or more' },
  { id: 'gemma-2-2b-it-q4f16_1-MLC', name: 'Gemma 2 2B', family: 'gemma', gb: 1.6, fits: 'laptops with 8 GB or more' },
  { id: 'Qwen3-4B-q4f16_1-MLC', name: 'Qwen3 4B', family: 'qwen', gb: 2.4, fits: 'Apple Silicon or a GPU, 16 GB or more' },
];
export function browserPick(d) {
  if (d.mobile) return BROWSER_MODELS[0];
  if (d.appleSilicon && d.memGB >= 16) return BROWSER_MODELS[4];
  if (d.memGB >= 8 || d.gpuGB >= 6) return BROWSER_MODELS[2];
  return BROWSER_MODELS[1];
}

/** The engine: WebLLM by default. Tests (and other runtimes) can supply their own with the same chat shape. */
async function makeEngine(modelId, onProgress) {
  if (window.__constellateEngine) return window.__constellateEngine(modelId, onProgress);
  const { CreateMLCEngine } = await import(WEBLLM);
  return CreateMLCEngine(modelId, { initProgressCallback: (p) => onProgress(p.progress ?? 0, p.text ?? '') });
}

/** Polite in the browser too: only while plugged in (where the browser can tell) and while this tab is open. */
async function browserConditions(requireAC) {
  try { const b = await navigator.getBattery?.(); if (b && requireAC && !b.charging) return { ok: false, message: 'Paused: plug in to keep contributing.' }; } catch { /* unknown counts as plugged in */ }
  return { ok: true, message: 'Contributing.' };
}

function browserPanel(dev) {
  const pick = browserPick(dev);
  return `<div class="card" id="bc">
    <div class="spread"><b>Contribute from this browser</b>${navigator.gpu ? '<span class="chip sm ok"><span class="dot"></span>WebGPU ready</span>' : '<span class="chip sm">No WebGPU here</span>'}</div>
    <p class="muted" style="font-size:13.5px;margin:6px 0 10px">${navigator.gpu ? 'Runs a small open model right in this tab, with no install. It works on steps a different model family then checks, and stops when you close the tab.' : 'This browser can’t run models (WebGPU is off or unsupported). Recent Chrome and Edge on desktop and Android can, and so can Safari on recent Macs and iPhones. Or use the commands below.'}</p>
    ${navigator.gpu ? `<div class="row"><label style="flex:1;display:grid;gap:6px;font-size:13px;color:var(--fg-2)">Model<select class="field" id="bc-model">${BROWSER_MODELS.map((m) => `<option value="${m.id}"${m.id === pick.id ? ' selected' : ''}>${esc(m.name)} · ${m.family} · about ${m.gb} GB, ${esc(m.fits)}</option>`).join('')}</select></label></div>
    <label class="row" style="gap:8px;font-size:13px;margin-top:10px"><input type="checkbox" id="bc-ac" checked> Only while plugged in</label>
    <div class="row" style="margin-top:12px"><button class="btn primary" id="bc-start">Start contributing</button><button class="btn ghost" id="bc-stop" hidden>Stop</button></div>
    <div class="meter" id="bc-bar" hidden style="margin-top:12px"><i style="width:0%"></i></div>
    <p class="faint" id="bc-status" role="status" style="font-size:13px;margin:10px 0 0">The model downloads once (cached by the browser), only when you press Start.</p>
    <p class="faint" id="bc-count" style="font-size:12.5px;margin:4px 0 0"></p>` : ''}
  </div>`;
}

function wireBrowser() {
  if (!$('#bc-start')) return;
  let running = false, engine = null, done = 0;
  const status = (t) => { $('#bc-status').textContent = t; };
  $('#bc-stop').onclick = () => { running = false; status('Stopped. Thanks for helping.'); $('#bc-stop').hidden = true; $('#bc-start').hidden = false; };
  $('#bc-start').onclick = async () => {
    const m = BROWSER_MODELS.find((x) => x.id === $('#bc-model').value);
    $('#bc-start').hidden = true; $('#bc-stop').hidden = false; running = true;
    try {
      if (!engine || engine.__id !== m.id) {
        $('#bc-bar').hidden = false;
        engine = await makeEngine(m.id, (p, text) => { $('#bc-bar i').style.width = `${Math.round(p * 100)}%`; status(text ? `Getting ready: ${text}` : `Getting ready… ${Math.round(p * 100)}%`); });
        engine.__id = m.id;
        $('#bc-bar').hidden = true;
      }
    } catch (e) { status(`Couldn’t start the model here: ${e.message ?? e}`); running = false; $('#bc-stop').hidden = true; $('#bc-start').hidden = false; return; }
    const { contribute } = await import('../identity.js');
    while (running) {
      const cond = await browserConditions($('#bc-ac').checked);
      if (!cond.ok) { status(cond.message); await new Promise((r) => setTimeout(r, 15000)); continue; }
      const job = await api(`/api/work/next?family=${m.family}`).catch(() => ({ problem: null }));
      if (!job.problem) { status('Waiting: no open steps for this model right now.'); await new Promise((r) => setTimeout(r, 30000)); continue; }
      status(`Working on “${job.step}” for ${job.title}…`);
      const t0 = performance.now();
      const reply = await engine.chat.completions.create({ messages: [{ role: 'user', content: job.prompt }], max_tokens: 768, temperature: 0.2 });
      if (!running) break;
      const output = String(reply.choices?.[0]?.message?.content ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
      if (!output) continue;
      try {
        const r = await contribute({ kind: 'task_result', task: `${job.title} / ${job.chunk}`, domain: [job.realm], body: { problem: job.problem, chunk: job.chunk, output: output.slice(0, 20000), model: m.id, family: m.family }, refs: [job.problem], environment: `browser (WebGPU): ${m.id}` });
        done++;
        $('#bc-count').textContent = `${done} result${done === 1 ? '' : 's'} sent from this tab${r.local ? ' (kept on this device: the preview isn’t connected)' : ''}. Each counts once a different model family checks it.`;
        status(`Sent a result for “${job.step}” in ${((performance.now() - t0) / 1000).toFixed(0)} s. ${cond.message}`);
      } catch (e) { status(`Not sent: ${e.message}`); }
      await new Promise((r) => setTimeout(r, 4000));
    }
  };
}

// ── The contributor app's dashboard, when `constellate contribute` runs on this machine ──
async function dashboardHtml() {
  const c = await api('/api/contributor').catch(() => null);
  if (!c?.status) return ''; // no contributor running on this machine
  const st = c.status;
  return `<div class="card stack" id="dash">
    <div class="spread"><b>This computer</b><span class="chip sm ${st.state === 'contributing' ? 'ok' : st.state === 'paused' ? 'warn' : ''}"><span class="dot"></span>${esc(st.state)}</span></div>
    <p style="margin:0">${esc(st.message)}</p>
    <div class="stack" style="gap:6px">${c.models.map((m) => { const spent = c.spend.by_model?.[m.id] ?? 0; const cap = c.spend.cap_cents; return `<div><div class="spread" style="font-size:13px"><span>${esc(m.id)} <span class="faint">(${esc(m.family)}${m.local ? ', local, free' : ''})</span></span><span class="num faint">${m.local ? 'free' : `${spent}¢${cap != null && Number.isFinite(cap) ? ` of ${cap}¢ cap` : ''}`}</span></div>${!m.local && cap ? `<div class="meter"><i style="width:${Math.min(100, Math.round((spent / cap) * 100))}%"></i></div>` : ''}</div>`; }).join('')}</div>
    <p class="faint" style="font-size:12.5px;margin:0">${c.conditions.tempC ? `${Math.round(c.conditions.tempC)}°C` : ''}${c.conditions.batteryPct != null ? ` · battery ${c.conditions.batteryPct}%` : ''}</p>
    <div class="device-fields">
      <label>Only when plugged in<select id="pol-ac"><option value="1"${c.policy.requireAC ? ' selected' : ''}>Yes</option><option value="0"${c.policy.requireAC ? '' : ' selected'}>No</option></select></label>
      <label>Lowest battery<select id="pol-batt">${[20, 30, 50, 70, 90].map((b) => `<option${b === c.policy.minBattery ? ' selected' : ''}>${b}</option>`).join('')}</select></label>
      <label>Pause above<select id="pol-temp"><option value="">No heat limit</option>${[70, 75, 80, 85, 90, 95].map((t) => `<option value="${t}"${t === c.policy.maxTempC ? ' selected' : ''}>${t}°C</option>`).join('')}</select></label>
      <label>Hours<select id="pol-hours"><option value="">Any time</option>${[[22, 7], [0, 6], [9, 17], [18, 23]].map(([a, b]) => `<option value="${a}-${b}"${c.policy.hours && c.policy.hours[0] === a && c.policy.hours[1] === b ? ' selected' : ''}>${a}:00 to ${b}:00</option>`).join('')}</select></label>
    </div>
    <div class="row"><button class="btn${c.policy.paused ? ' primary' : ''}" id="pol-pause">${c.policy.paused ? 'Resume' : 'Pause'}</button></div>
  </div>`;
}
function wireDashboard(refresh) {
  if (!$('#dash')) return;
  const send = async (patch) => { await api('/api/contributor/policy', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) }).catch((e) => toast(e.message)); refresh(); };
  $('#pol-ac').onchange = (e) => send({ requireAC: e.target.value === '1' });
  $('#pol-batt').onchange = (e) => send({ minBattery: Number(e.target.value) });
  $('#pol-temp').onchange = (e) => send({ maxTempC: e.target.value ? Number(e.target.value) : null });
  $('#pol-hours').onchange = (e) => send({ hours: e.target.value ? e.target.value.split('-').map(Number) : null });
  $('#pol-pause').onclick = () => send({ paused: $('#pol-pause').textContent === 'Pause' });
}

const MEM = [4, 6, 8, 12, 16, 18, 24, 32, 36, 48, 64, 96, 128];
const GPU = [0, 8, 10, 12, 16, 20, 24, 32, 48, 80];
const fam = (f) => `<span class="chip sm fam" data-f="${esc(f)}"><span class="dot"></span>${esc(f)}</span>`;

function suggestionHtml(s) {
  if (!s.primary) {
    return `<div class="card"><p style="margin:0">${esc(s.notes[0])}</p>
      <h3 class="eyebrow" style="margin-top:16px">Free hosted models instead</h3>
      <div class="stack" style="margin-top:8px">${FREE_HOSTED.map((h) => `<div class="hosted-row"><b>${esc(PROVIDERS.find((p) => p.id === h.provider)?.name ?? h.provider)}</b> <code class="faint">${esc(h.model)}</code><div class="muted" style="font-size:13px">${esc(h.why)}</div></div>`).join('')}</div>
      <p class="muted" style="font-size:13.5px;margin:14px 0 0">Or help without any model: <a href="#/deliberations">rate arguments in a debate</a> or check a result on a problem.</p></div>`;
  }
  const row = (label, m, sub) => `<div class="model-row"><div class="eyebrow">${label}</div><div class="spread" style="margin-top:6px"><b class="serif" style="font-size:20px">${esc(m.name)}</b><span class="row" style="gap:6px">${fam(m.family)}<span class="chip sm">~${m.needGB} GB</span><span class="chip sm ok"><span class="dot"></span>free · open weights</span></span></div><p class="muted" style="margin:4px 0 0;font-size:13.5px">${sub}</p></div>`;
  return `<div class="card stack">
    ${row('Main model', s.primary, `Good at ${esc(s.primary.good)}. Licence: ${esc(s.primary.licence)}.`)}
    ${s.verifier ? row('Checker', s.verifier, `A different family, so it can check other contributors’ work. The network never trusts one family alone.`) : ''}
    ${s.alternatives.length ? `<p class="faint" style="font-size:13px;margin:0">Also fits: ${s.alternatives.map((a) => `${esc(a.name)} (~${a.needGB} GB)`).join(' · ')}</p>` : ''}
    ${s.notes.map((n) => `<p class="faint" style="font-size:13px;margin:0">${esc(n)}</p>`).join('')}
  </div>`;
}

/**
 * "Start helping": one button that picks the best way this computer can help right now.
 *  - The desktop app with Ollama and its model ready: the app's own worker (keeps going when the window is closed).
 *  - Anywhere with WebGPU: a small free model right in this window, nothing to install.
 *  - The public website: honest that it's a preview, and where to help for real.
 */
async function startCard(slot) {
  if (!slot) return;
  const RELEASES = 'https://github.com/nkoteskey/Constellate/releases';
  const big = (label, id, cls = 'primary') => `<button class="btn ${cls}" id="${id}" style="font-size:16px;padding:14px 26px">${label}</button>`;
  const shell = (body) => { slot.innerHTML = `<div class="card start-card" style="padding:22px">${body}</div>`; };
  if (STATIC) {
    shell(`<b style="font-size:17px">This website is a preview</b>
      <p class="muted" style="margin:6px 0 14px">Work done here stays on this device, so it doesn’t help yet. To help for real, use the free Constellate app: install it, press one button, and your computer helps while you’re not using it.</p>
      <a class="btn primary" href="${RELEASES}" target="_blank" rel="noopener" style="font-size:16px;padding:14px 26px">Get the Constellate app</a>
      <p class="faint" style="font-size:12.5px;margin:10px 0 0">For Mac, Windows and Linux. The first release is coming soon.</p>`);
    return;
  }
  const status = DESKTOP ? await desk.status().catch(() => null) : null;
  const sg = status?.suggestion;
  const local = [sg?.primary, sg?.verifier].filter((m) => m && m.run?.provider === 'ollama');
  const ollamaReady = !!status?.ollama?.running && local.every((m) => status.ollama.models.some((x) => x === m.run.model || x === `${m.run.model}:latest`));
  const browserOk = !!navigator.gpu && !!$('#bc-start');

  // In the desktop app, once it can lend (or is lending), the card below is the one switch, with its limits and
  // what ran (js/desktop.js lendCard). This card stays for what comes first: Ollama, or a model in this window.
  if (DESKTOP && (status?.settings?.contribute || ollamaReady)) { slot.innerHTML = ''; return; }
  if (browserOk) {
    shell(`<b style="font-size:17px">Start helping in one click</b>
      <p class="muted" style="margin:6px 0 14px">A small free model runs right here${DESKTOP ? ' in the app' : ' in this tab'}. Nothing to install and no account. The first start downloads it once (about 1 GB).</p>
      <div class="row">${big('Start helping', 'st-go')}<button class="btn ghost" id="st-stop" hidden>Stop</button></div>
      <p class="faint" id="st-status" role="status" style="font-size:13.5px;margin:12px 0 0"></p>
      ${DESKTOP ? '<p class="faint" style="font-size:12.5px;margin:10px 0 0">Want it faster, and running even when the window is closed? <button class="claim" id="st-ollama">Install Ollama</button> (free), then come back here.</p>' : ''}`);
    const mirror = () => { const t = $('#bc-status')?.textContent ?? ''; const c = $('#bc-count')?.textContent ?? ''; $('#st-status', slot).textContent = [t, c].filter(Boolean).join(' '); };
    const obs = new MutationObserver(mirror);
    for (const id of ['#bc-status', '#bc-count']) if ($(id)) obs.observe($(id), { childList: true, characterData: true, subtree: true });
    $('#st-go', slot).onclick = () => { $('#st-go', slot).hidden = true; $('#st-stop', slot).hidden = false; $('#bc-start').click(); mirror(); };
    $('#st-stop', slot).onclick = () => { $('#bc-stop').click(); $('#st-stop', slot).hidden = true; $('#st-go', slot).hidden = false; };
    $('#st-ollama', slot)?.addEventListener('click', () => desk.getOllama());
    return;
  }
  // No WebGPU here: the app's own worker needs Ollama.
  shell(`<b style="font-size:17px">One free download, then one click</b>
    <p class="muted" style="margin:6px 0 14px">${DESKTOP ? 'This computer’s graphics can’t run a model inside the app, so it uses Ollama, a small free app that runs AI models. Install it, open it, and come back here.' : 'This browser can’t run a model itself. The free Constellate app can: install it, press one button, and your computer helps while you’re not using it.'}</p>
    ${DESKTOP ? `${big('Install Ollama (free)', 'st-ollama')} <button class="btn ghost" id="st-recheck">I’ve installed it</button>` : `<a class="btn primary" href="${RELEASES}" target="_blank" rel="noopener" style="font-size:16px;padding:14px 26px">Get the Constellate app</a>`}`);
  $('#st-ollama', slot)?.addEventListener('click', () => desk.getOllama());
  $('#st-recheck', slot)?.addEventListener('click', () => startCard(slot));
}

export function computePage(page) {
  page(`<div class="page narrow"><div class="eyebrow">Help for free</div>
    <h1 class="display" style="font-size:var(--d-md);margin:10px 0">Your computer, helping while you sleep</h1>
    <p class="muted" style="max-width:60ch">Your computer runs a free AI model and works on open problems while you’re not using it. You don’t need an AI account, and you don’t pay anything.</p>
    <div id="start-slot" style="margin:18px 0 14px"></div>
    ${DESKTOP ? '<div id="desk-slot" style="margin:0 0 14px"></div>' : ''}
    <div id="dash-slot"></div>
    <div class="card" style="margin:14px 0 18px"><ul class="plain-list" style="margin:0;padding-left:18px;display:grid;gap:6px;font-size:13.5px">
      <li><b>What runs:</b> a free, open model on this computer (or right in this browser tab). It fits your machine, so it won’t slow you down.</li>
      <li><b>When:</b> only while you’re not using it, it’s plugged in, and it isn’t too hot. You can pause it any time.</li>
      <li><b>What it does:</b> small steps of open problems, and checking other computers’ work. You’ll see each step below as it happens.</li>
      <li><b>Not your agents:</b> Claude Code, Claude Desktop and other connected agents don’t do this work, and nothing is charged to your AI accounts. They use what the network has learned. Lending is separate.</li>
      <li><b>Private:</b> nothing you type or store on this computer is shared.</li>
    </ul></div>
    ${STATIC ? '' : '<div id="fund-slot"></div>'}

    <details class="more-options"><summary><span>More options<span class="mo-sub">Choose a different model, see what fits this computer, bring any model, check storage, or use the command line</span></span></summary>
    <div id="bc-slot" style="margin-top:12px"></div>
    <h2 class="section">What this device can run</h2>
    <div class="card" id="dev"><span class="faint">Looking at this device…</span></div>
    <div id="sugg" style="margin-top:12px"></div>
    <h3 class="eyebrow" style="margin-top:18px">To start</h3>
    <div class="copy-row"><pre class="code" id="cmds"></pre><button class="btn" id="copy-cmds">${icon.copy}Copy</button></div>
    <p class="faint" style="font-size:12.5px;margin:6px 0 0">Your browser can only estimate the hardware. Run these from your Constellate folder (<a href="#/connect">get it on Connect</a>, about a minute). <code>${RUN} models</code> checks it precisely on the machine. Once running, <code>${RUN} contribute</code> opens its status and controls (pause, plugged-in only, battery, hours, heat) on this page at 127.0.0.1:4748. A packaged installer comes with the first release.</p>

    <h2 class="section">Or bring any model</h2>
    <p class="muted" style="max-width:62ch">Local or hosted, open or closed: pass <code>--model provider/model</code>. Keys stay on your machine, read from the provider’s usual variable, and are never put in a record.</p>
    <div class="provider-grid">${PROVIDERS.map((p) => `<button class="card provider" data-spec="${esc(`${p.id}/${p.example}`)}" data-key="${esc(p.keyEnv ?? '')}" data-custom="${p.id === 'custom' ? 1 : ''}">
      <div class="provider-head"><b>${esc(p.name)}</b><span class="chip sm ${/free/.test(p.cost) ? 'ok' : ''}">${/free/.test(p.cost) ? '<span class="dot"></span>' : ''}${esc(p.cost)}</span></div>
      <div class="faint" style="font-size:12.5px;margin-top:6px">${p.cluster ? 'Your computers, pooled' : p.kind === 'local' ? 'Runs on your machine' : p.kind === 'custom' ? 'Your own server' : 'Hosted'}${p.openWeight === true ? ' · open weights' : p.openWeight === 'mixed' ? ' · open and closed' : ''}</div>
      ${p.note ? `<div class="muted" style="font-size:13px;margin-top:6px">${esc(p.note)}</div>` : ''}</button>`).join('')}</div>
    <div class="copy-row" style="margin-top:12px"><pre class="code" id="any-cmd">${RUN} contribute --model groq/llama-3.3-70b-versatile</pre><button class="btn" id="copy-any">${icon.copy}Copy</button></div>
    <p class="faint" style="font-size:12.5px;margin:6px 0 0">Model list reviewed ${esc(CATALOG_UPDATED)}. Paid models stop at the spending cap you set (<code>--cap-cents</code>).</p>
    ${STATIC ? '' : '<h2 class="section">Storage on this computer</h2><div class="card" id="storage-slot"><span class="faint">Checking…</span></div>'}
    </details>
  </div>`);

  let dev;
  const render = () => {
    const s = suggest(dev);
    $('#sugg').innerHTML = suggestionHtml(s);
    $('#cmds').textContent = commands(s).join('\n');
  };
  detectDevice().then((d) => {
    dev = d;
    const seen = [d.chip ? `Apple ${d.chip}` : d.appleSilicon ? 'Apple Silicon' : null, d.gpuName, d.cores ? `${d.cores} cores` : null, d.webgpu ? 'WebGPU' : null].filter(Boolean);
    $('#dev').innerHTML = `<div class="row" style="gap:6px">${seen.map((x) => `<span class="chip sm">${esc(x)}</span>`).join('') || '<span class="faint">Your browser shares little about this device.</span>'}<span class="faint" style="font-size:12.5px">browser estimate, adjust if needed</span></div>
      <div class="device-fields">
        <label>Type<select id="d-type"><option value="computer"${d.mobile ? '' : ' selected'}>Computer</option><option value="mac"${d.appleSilicon ? ' selected' : ''}>Mac with Apple Silicon</option><option value="mobile"${d.mobile ? ' selected' : ''}>Phone or tablet</option></select></label>
        <label>Memory<select id="d-mem">${MEM.map((m) => `<option value="${m}"${m === d.memGB ? ' selected' : ''}>${m} GB</option>`).join('')}</select></label>
        <label>Graphics memory<select id="d-gpu">${GPU.map((g) => `<option value="${g}"${g === d.gpuGB ? ' selected' : ''}>${g ? `${g} GB` : 'None / not sure'}</option>`).join('')}</select></label>
      </div>`;
    const sync = () => {
      const t = $('#d-type').value;
      dev = { ...dev, mobile: t === 'mobile', appleSilicon: t === 'mac', memGB: Number($('#d-mem').value), gpuGB: t === 'mac' ? 0 : Number($('#d-gpu').value) };
      $('#d-gpu').disabled = t !== 'computer';
      render();
    };
    $$('#dev select').forEach((x) => (x.onchange = sync));
    sync();
    $('#bc-slot').innerHTML = browserPanel(d);
    wireBrowser();
    void startCard($('#start-slot'));
  });
  if (!STATIC) {
    if (DESKTOP) void lendCard($('#desk-slot'));
    void import('./fund.js').then((m) => m.fundCard($('#fund-slot')));
    api('/api/storage').then((st) => {
      if (!$('#storage-slot')) return; // left the page while it loaded
      const mb = (n) => `${(n / 1e6).toFixed(n < 1e6 ? 2 : 1)} MB`;
      $('#storage-slot').innerHTML = `<div style="font-size:13.5px;display:grid;gap:6px">
        <div><b>${st.records.public.toLocaleString()}</b> shared lessons from ${st.records.authors} ${st.records.authors === 1 ? 'computer' : 'computers'}, <b>${mb(st.disk.total)}</b> on disk.</div>
        <div class="muted">Packed history takes about ${st.bytes_per_record.packed.toLocaleString()} bytes a lesson, against ${st.bytes_per_record.as_sent.toLocaleString()} as sent. Connected agents see ${esc(st.mcp.note)}.</div>
        <div class="faint" style="font-size:12.5px">Free up space with <code>${RUN} storage prune --keep-days 90</code> (shows what would go first; your own work is always kept).</div></div>`;
    }).catch(() => { $('#storage-slot')?.remove(); });
    const refresh = async () => { if (!$('#dash-slot')) return; $('#dash-slot').innerHTML = await dashboardHtml(); wireDashboard(refresh); };
    refresh();
    const timer = setInterval(() => (document.body.contains($('#dash-slot')) ? refresh() : clearInterval(timer)), 10000);
  }
  $('#copy-cmds').onclick = () => copy($('#cmds').textContent, 'Commands copied');
  $$('.provider').forEach((b) => (b.onclick = () => {
    $$('.provider').forEach((x) => x.classList.toggle('on', x === b));
    $('#any-cmd').textContent = `${b.dataset.key ? `export ${b.dataset.key}=…   # your key, kept on this machine\n` : ''}constellate contribute --model ${b.dataset.spec}${b.dataset.custom ? ' --endpoint http://your-server/v1' : ''}`;
  }));
  $('#copy-any').onclick = () => copy($('#any-cmd').textContent, 'Command copied');
}
