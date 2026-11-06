// "Lend your computer": what this device can run, for free, and any model you'd rather bring.
// The browser can only estimate the hardware, so the person can correct it; the
// command line (`constellate models`) then checks precisely on the machine itself.
import { $, $$, esc, icon, copy } from './ui.js';
import { suggest, commands, PROVIDERS, FREE_HOSTED, CATALOG_UPDATED } from './models.js';

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

export function computePage(page) {
  page(`<div class="page narrow"><div class="eyebrow">Lend your computer</div>
    <h1 class="display" style="font-size:var(--d-md);margin:10px 0">Your computer, helping while you sleep</h1>
    <p class="muted" style="max-width:60ch">It runs a free, open model that fits your machine, only while the machine is idle and plugged in, and it always says what it’s doing. Nothing you type or store is shared. Prefer another model? Any model works.</p>

    <h2 class="section">What this device can run</h2>
    <div class="card" id="dev"><span class="faint">Looking at this device…</span></div>
    <div id="sugg" style="margin-top:12px"></div>
    <h3 class="eyebrow" style="margin-top:18px">To start</h3>
    <div class="copy-row"><pre class="code" id="cmds"></pre><button class="btn" id="copy-cmds">${icon.copy}Copy</button></div>
    <p class="faint" style="font-size:12.5px;margin:6px 0 0">Your browser can only estimate the hardware. <code>constellate models</code> checks it precisely on the machine. The one-click app is coming; these commands are the preview.</p>

    <h2 class="section">Or bring any model</h2>
    <p class="muted" style="max-width:62ch">Local or hosted, open or closed: pass <code>--model provider/model</code>. Keys stay on your machine, read from the provider’s usual variable, and are never put in a record.</p>
    <div class="provider-grid">${PROVIDERS.map((p) => `<button class="card provider" data-spec="${esc(`${p.id}/${p.example}`)}" data-key="${esc(p.keyEnv ?? '')}" data-custom="${p.id === 'custom' ? 1 : ''}">
      <div class="provider-head"><b>${esc(p.name)}</b><span class="chip sm ${/free/.test(p.cost) ? 'ok' : ''}">${/free/.test(p.cost) ? '<span class="dot"></span>' : ''}${esc(p.cost)}</span></div>
      <div class="faint" style="font-size:12.5px;margin-top:6px">${p.kind === 'local' ? 'Runs on your machine' : p.kind === 'custom' ? 'Your own server' : 'Hosted'}${p.openWeight === true ? ' · open weights' : p.openWeight === 'mixed' ? ' · open and closed' : ''}</div>
      ${p.note ? `<div class="muted" style="font-size:13px;margin-top:6px">${esc(p.note)}</div>` : ''}</button>`).join('')}</div>
    <div class="copy-row" style="margin-top:12px"><pre class="code" id="any-cmd">constellate contribute --model groq/llama-3.3-70b-versatile</pre><button class="btn" id="copy-any">${icon.copy}Copy</button></div>
    <p class="faint" style="font-size:12.5px;margin:6px 0 0">Model list reviewed ${esc(CATALOG_UPDATED)}. Paid models stop at the spending cap you set (<code>--cap-cents</code>).</p>
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
  });
  $('#copy-cmds').onclick = () => copy($('#cmds').textContent, 'Commands copied');
  $$('.provider').forEach((b) => (b.onclick = () => {
    $$('.provider').forEach((x) => x.classList.toggle('on', x === b));
    $('#any-cmd').textContent = `${b.dataset.key ? `export ${b.dataset.key}=…   # your key, kept on this machine\n` : ''}constellate contribute --model ${b.dataset.spec}${b.dataset.custom ? ' --endpoint http://your-server/v1' : ''}`;
  }));
  $('#copy-any').onclick = () => copy($('#any-cmd').textContent, 'Command copied');
}
