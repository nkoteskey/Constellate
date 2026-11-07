// Constellate for the desktop: one install that runs the app, joins the x0x network, and
// (only when the person turns it on) lends this computer's spare time to open problems.
import { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeImage, shell } from 'electron';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { X0xSidecar, bundledX0xd } from './lib/x0x.mjs';
import { Service, isConstellate, isListening } from './lib/services.mjs';
import { agentConfigs, mcpEntry, connection, connect, disconnect, claudeCodeCommand } from './lib/agents.mjs';
import { ollamaStatus, hasModel, pullModel, OLLAMA_DOWNLOAD } from './lib/ollama.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = app.isPackaged ? app.getAppPath() : resolve(HERE, '..');
const CLI = join(ROOT, 'dist', 'cli.js');
const PORT = Number(process.env.CONSTELLATE_PORT ?? 4747);
const APP_URL = `http://127.0.0.1:${PORT}`;
const DASH_URL = 'http://127.0.0.1:4748';
// The starter library bundled with the app (stage/starter in a packaged build; desktop/stage/starter when run from source).
const STARTER = [join(HERE, 'starter', 'saorsa-labs.cbor'), join(HERE, 'stage', 'starter', 'saorsa-labs.cbor')].find((f) => existsSync(f));
const ICON = join(HERE, 'build', process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png');

if (!app.requestSingleInstanceLock()) app.quit();

// ── Settings and logs (in the app's data folder) ─────────────────────────
if (process.env.CONSTELLATE_APP_DATA) app.setPath('userData', process.env.CONSTELLATE_APP_DATA); // tests and portable use
const DATA = app.getPath('userData');
mkdirSync(join(DATA, 'logs'), { recursive: true });
const LOG = join(DATA, 'logs', 'constellate.log');
const log = (l) => { try { appendFileSync(LOG, `${new Date().toISOString()} ${l}\n`); } catch { /* the log is best-effort */ } };
const SETTINGS = join(DATA, 'settings.json');
const DEFAULTS = { contribute: false, model: null, verifier: null, openAtLogin: false, offline: false, closeNoticeShown: false };
let settings = { ...DEFAULTS };
try { settings = { ...DEFAULTS, ...JSON.parse(readFileSync(SETTINGS, 'utf8')) }; } catch { /* first run */ }
const save = (patch) => { settings = { ...settings, ...patch }; writeFileSync(SETTINGS, JSON.stringify(settings, null, 2)); };

// ── The three programs: x0x, the app server, the contributor ─────────────
const x0x = new X0xSidecar({
  binary: process.env.CONSTELLATE_X0XD ?? (app.isPackaged ? bundledX0xd(process.resourcesPath) : bundledX0xd(join(HERE, 'resources'))),
  base: DATA,
  offline: settings.offline || process.env.CONSTELLATE_OFFLINE === '1',
  log: (l) => log(`[x0x] ${l}`),
});
const common = { execPath: process.execPath, cliPath: CLI, log };
const server = new Service({ ...common, name: 'server', args: ['serve'], env: { ...x0x.env(), PORT: String(PORT), ...(STARTER ? { CONSTELLATE_STARTER: STARTER } : {}) }, ready: () => isConstellate(APP_URL) });
let contributor = null;
let externalServer = false; // a Constellate the person already runs on this port (e.g. from the command line)

async function suggestion() {
  const device = await import(pathToFileURL(join(ROOT, 'dist', 'contributor', 'device.js')).href);
  const d = device.detectDevice();
  return { device: d, ...device.suggestFor(d) };
}
const spec = (m) => (m ? `${m.run.provider}/${m.run.model}` : null);

async function startContributor() {
  const s = await suggestion();
  const model = settings.model ?? spec(s.primary);
  if (!model) throw new Error(s.notes?.[0] ?? 'No open model fits this computer. Add a hosted model from the Compute page.');
  const verifier = settings.verifier ?? (settings.model ? null : spec(s.verifier));
  const local = [model, verifier].filter((m) => m?.startsWith('ollama/')).map((m) => m.slice(7));
  if (local.length) {
    const o = await ollamaStatus();
    if (!o.running) throw Object.assign(new Error('Ollama runs the free models. Install it, open it, then try again.'), { code: 'ollama-missing' });
    const missing = local.filter((m) => !hasModel(o.models, m));
    if (missing.length) throw Object.assign(new Error(`Download ${missing.join(' and ')} first.`), { code: 'model-missing', missing });
  }
  await contributor?.stop();
  contributor = new Service({ ...common, name: 'contributor', args: ['contribute', '--model', model, ...(verifier ? ['--verifier', verifier] : [])], env: x0x.env(), ready: () => isListening(DASH_URL) });
  return contributor.start();
}

// ── Window and tray ──────────────────────────────────────────────────────
let win = null, tray = null, quitting = false, ready = false, step = { step: 'network' };
const HIDDEN = process.argv.includes('--hidden'); // opened at login: stay in the tray until clicked
const pushStep = () => win?.webContents.executeJavaScript(`window.setStep && window.setStep(${JSON.stringify(step)})`).catch(() => {});

function showWindow() {
  if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); return; }
  win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 380, minHeight: 560, backgroundColor: '#070a12', title: 'Constellate', show: false,
    icon: join(HERE, 'build', 'icon.png'),
    webPreferences: { preload: join(HERE, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  win.once('ready-to-show', () => win.show());
  // Only the local app opens inside the window; every other link opens in the person's browser.
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//.test(url)) void shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(APP_URL) && !url.startsWith('file:')) { e.preventDefault(); void shell.openExternal(url); } });
  win.on('close', (e) => {
    if (quitting || !settings.contribute) return;
    e.preventDefault(); win.hide(); // still lending this computer: keep running in the tray
    if (!settings.closeNoticeShown) { save({ closeNoticeShown: true }); tray?.displayBalloon?.({ title: 'Constellate is still lending this computer', content: 'It keeps helping in the background. Quit or pause it from this icon.' }); }
  });
  win.on('closed', () => { win = null; });
  win.webContents.on('did-finish-load', () => { if (!ready) void pushStep(); });
  if (ready) void win.loadURL(APP_URL + '/'); else void win.loadFile(join(HERE, 'ui', 'starting.html'));
}

function trayMenu() {
  const st = status();
  const line = (s) => ({ label: s, enabled: false });
  return Menu.buildFromTemplate([
    { label: 'Open Constellate', click: showWindow },
    { type: 'separator' },
    line(st.x0x.state === 'online' ? `x0x network: connected${st.x0x.peers != null ? ` · ${st.x0x.peers} peers` : ''}` : st.x0x.state === 'missing' ? 'x0x network: not in this build' : `x0x network: ${st.x0x.state}`),
    line(settings.contribute ? `Lending this computer: ${st.contribute?.state ?? 'starting'}` : 'Not lending this computer'),
    { label: settings.contribute ? 'Stop lending this computer' : 'Lend this computer…', click: () => { if (settings.contribute) void setContribute(false); else { showWindow(); void openInApp('#/compute'); } } },
    { type: 'separator' },
    { label: 'Open at login', type: 'checkbox', checked: settings.openAtLogin, click: (i) => setOpenAtLogin(i.checked) },
    { label: 'Show logs', click: () => void shell.showItemInFolder(LOG) },
    { type: 'separator' },
    { label: 'Quit Constellate', click: () => { quitting = true; app.quit(); } },
  ]);
}

function refreshTray() {
  if (!tray) return;
  tray.setContextMenu(trayMenu());
  tray.setToolTip(`Constellate${settings.contribute ? ' · lending this computer' : ''}`);
}

async function openInApp(hash = '') { if (win && ready) await win.loadURL(APP_URL + '/' + hash); }

function setOpenAtLogin(on) { save({ openAtLogin: on }); app.setLoginItemSettings({ openAtLogin: on, openAsHidden: true, args: ['--hidden'] }); refreshTray(); }

async function setContribute(on) {
  if (!on) { save({ contribute: false }); await contributor?.stop(); refreshTray(); return { ok: true, status: status() }; }
  try { await startContributor(); save({ contribute: true }); refreshTray(); return { ok: true, status: status() }; }
  catch (e) { refreshTray(); return { ok: false, error: e.message, code: e.code, missing: e.missing }; }
}

// ── What the app can see and do (only from the local app, never from other sites) ──
function status() {
  const entry = mcpEntry({ execPath: process.execPath, cliPath: CLI, x0xDataDir: x0x.dataDir, starter: STARTER });
  const agents = Object.fromEntries(Object.entries(agentConfigs()).map(([id, a]) => [id, { name: a.name, present: a.present, connection: connection(a.file, entry) }]));
  return {
    version: app.getVersion(), platform: process.platform,
    x0x: x0x.status(), server: externalServer ? { state: 'external' } : server.status(),
    contribute: settings.contribute ? (contributor?.status() ?? { state: 'starting' }) : null,
    settings: { contribute: settings.contribute, model: settings.model, verifier: settings.verifier, openAtLogin: settings.openAtLogin },
    agents, claudeCode: claudeCodeCommand(entry),
  };
}

const fromApp = (e) => { try { return new URL(e.senderFrame.url).origin === new URL(APP_URL).origin; } catch { return false; } };
function handle(channel, fn) { ipcMain.handle(channel, async (e, ...a) => { if (!fromApp(e)) throw new Error('Not allowed'); return fn(e, ...a); }); }

handle('desktop:status', async () => ({ ...status(), ollama: await ollamaStatus(), suggestion: await suggestion().catch(() => null) }));
handle('desktop:contribute', (_e, on) => setContribute(Boolean(on)));
handle('desktop:setModel', (_e, model, verifier) => { save({ model: model || null, verifier: verifier || null }); return status().settings; });
handle('desktop:openAtLogin', (_e, on) => { setOpenAtLogin(Boolean(on)); return settings.openAtLogin; });
handle('desktop:getOllama', () => shell.openExternal(OLLAMA_DOWNLOAD));
handle('desktop:pull', async (e, model) => {
  if (typeof model !== 'string' || !/^[\w.:\/-]{1,80}$/.test(model)) throw new Error('Unknown model');
  await pullModel(model, (p, s) => e.sender.send('desktop:pull-progress', { model, progress: p, status: s }));
  return { ok: true };
});
handle('desktop:connectAgent', async (_e, id) => {
  const a = agentConfigs()[id];
  if (!a) throw new Error('Unknown agent');
  const { response } = await dialog.showMessageBox(win, {
    type: 'question', buttons: ['Connect', 'Cancel'], defaultId: 0, cancelId: 1,
    message: `Connect ${a.name} to Constellate?`,
    detail: `This adds Constellate to ${a.name}'s settings file:\n${a.file}\n\nA copy of the file as it is now is kept next to it. Restart ${a.name} afterwards.`,
  });
  if (response !== 0) return { ok: false, cancelled: true };
  try { const backup = connect(a.file, mcpEntry({ execPath: process.execPath, cliPath: CLI, x0xDataDir: x0x.dataDir, starter: STARTER })); return { ok: true, backup }; }
  catch (err) { return { ok: false, error: err.message }; }
});
// One-click x0x link: this computer's x0x agent vouches for the person's browser key. The daemon signs the
// browser's Constellate id under its own context; the app server re-checks the signature before accepting it.
export const LINK_CONTEXT = 'constellate.identity-link.v1';
handle('desktop:linkX0x', async (_e, browserId) => {
  if (typeof browserId !== 'string' || !/^[0-9a-f]{64}$/.test(browserId)) throw new Error('Not a Constellate id');
  const ep = x0x.endpoint();
  if (!ep || x0x.state !== 'online') return { ok: false, error: 'x0x isn’t running on this computer right now.' };
  const r = await fetch(`${ep.url}/agent/sign`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${ep.token}` }, body: JSON.stringify({ context: LINK_CONTEXT, payload_b64: Buffer.from(browserId, 'utf8').toString('base64') }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.signature_b64) return { ok: false, error: `x0x couldn’t sign (${j.error ?? r.status}).` };
  return { ok: true, x0x_agent_id: j.agent_id, x0x_public_key: j.public_key_b64, signature: j.signature_b64, context: LINK_CONTEXT };
});
handle('desktop:disconnectAgent', (_e, id) => { const a = agentConfigs()[id]; if (!a) throw new Error('Unknown agent'); try { return { ok: disconnect(a.file) }; } catch (err) { return { ok: false, error: err.message }; } });

// ── Lifecycle ────────────────────────────────────────────────────────────
async function boot() {
  if (!HIDDEN) showWindow();
  const say = (msg) => { step = msg; return pushStep(); };
  if (!existsSync(CLI)) { await say({ error: `Constellate isn't built. Run "npm run build" in ${ROOT}.` }); return; }
  if (await isConstellate(APP_URL)) { externalServer = true; log('Using the Constellate already running on this computer'); }
  else if (await isListening(APP_URL)) { await say({ error: `Another program is using port ${PORT}. Close it and reopen Constellate.` }); return; }
  if (!externalServer) {
    await say({ step: 'network' });
    const s = await x0x.start();
    log(`x0x: ${s.state}${s.error ? ` (${s.error})` : ''}`);
    await say({ step: 'app', x0x: s.state });
    const st = await server.start();
    if (st.state !== 'running') { await say({ error: st.error }); return; }
  }
  ready = true;
  await openInApp();
  if (settings.contribute) { const r = await setContribute(true); if (!r.ok) log(`Lending paused: ${r.error}`); }
  refreshTray();
}

app.on('second-instance', showWindow);
app.on('activate', showWindow);
app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => { if (!settings.contribute) app.quit(); });
app.on('will-quit', (e) => {
  if (app.stoppedCleanly) return;
  e.preventDefault();
  void Promise.allSettled([contributor?.stop(), server.stop()]).then(() => x0x.stop()).finally(() => { app.stoppedCleanly = true; app.quit(); });
});

app.whenReady().then(() => {
  if (process.platform === 'darwin') app.dock?.setIcon(join(HERE, 'build', 'icon.png'));
  tray = new Tray(nativeImage.createFromPath(ICON));
  tray.on('click', showWindow);
  refreshTray();
  setInterval(refreshTray, 10_000).unref();
  void boot().catch((e) => { log(`boot failed: ${e.stack ?? e}`); step = { error: String(e.message ?? e) }; void pushStep(); });
});
