// End-to-end check of the desktop app: launch it (with a stand-in x0xd), wait for the window to
// show the local Constellate, then exercise the desktop-only cards. Linux needs a display:
//   xvfb-run -a node desktop/test/e2e.cjs [screenshot-dir]
// Uses a throwaway home and data folder, so it never touches the real ones.
const { _electron: electron } = require('playwright');
const { mkdtempSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const assert = require('node:assert/strict');

const ROOT = resolve(__dirname, '..', '..');
const shots = process.argv[2];
const home = mkdtempSync(join(tmpdir(), 'desk-home-'));
mkdirSync(join(home, '.config', 'Claude'), { recursive: true });
writeFileSync(join(home, '.config', 'Claude', 'claude_desktop_config.json'), JSON.stringify({ mcpServers: { other: { command: 'keep-me' } } }));

(async () => {
  const app = await electron.launch({
    // DESKTOP_EXE: test a packaged build (e.g. desktop/release/linux-unpacked/constellate-desktop) instead of the source.
    executablePath: process.env.DESKTOP_EXE ?? require(join(ROOT, 'desktop', 'node_modules', 'electron')),
    args: process.env.DESKTOP_EXE ? ['--no-sandbox'] : [join(ROOT, 'desktop'), '--no-sandbox'],
    env: {
      ...process.env, HOME: home, CONSTELLATE_HOME: join(home, '.constellate'), CONSTELLATE_APP_DATA: join(home, 'app-data'),
      // E2E_REAL_X0X=1: use the x0xd bundled in the packaged app (offline: no bootstrap peers) instead of the stand-in.
      ...(process.env.E2E_REAL_X0X ? {} : { CONSTELLATE_X0XD: join(ROOT, 'test', 'fixtures', 'fake-x0xd.mjs') }), CONSTELLATE_OFFLINE: '1', CONSTELLATE_PORT: '4791', OLLAMA_HOST: '127.0.0.1:1',
    },
  });
  try {
    const win = await app.firstWindow();
    await win.waitForURL('http://127.0.0.1:4791/**', { timeout: 60_000 });
    await win.waitForSelector('nav, header', { timeout: 30_000 });
    if (shots) await win.screenshot({ path: join(shots, 'desktop-home.png') });

    // The page knows it's inside the desktop app, and the bridge works from the local app.
    const st = await win.evaluate(() => window.constellateDesktop.status());
    assert.equal(st.x0x.state, 'online', `x0x: ${JSON.stringify(st.x0x)}`);
    assert.equal(st.server.state, 'running');
    assert.equal(st.ollama.running, false);

    // A new install opens on the starter library: real, signed lessons to search on day one.
    const found = await win.evaluate(async () => (await (await fetch('/api/search?q=restart')).json()).failures.length);
    assert.ok(found > 0, 'the starter library was imported');
    const roles = await win.evaluate(async () => (await (await fetch('/api/people')).json()).map((p) => p.role).filter(Boolean));
    assert.ok(roles.includes('starter'), `the starter library is labelled in People (${roles})`);

    // Lend this computer: without Ollama it asks for Ollama instead of failing.
    await win.evaluate(() => { location.hash = '#/compute'; });
    // One button first ("Start helping", or the one free download it needs); the detailed controls sit under More options.
    await win.waitForSelector('#start-slot .card', { timeout: 15_000 });
    assert.match(await win.textContent('#start-slot'), /Start helping|Install Ollama/);
    await win.waitForFunction(() => document.querySelector('#desk-slot .card'), null, { timeout: 15_000 });
    const lend = await win.evaluate(() => document.querySelector('#desk-slot').textContent);
    assert.match(lend, /On the x0x network/);
    if (process.env.E2E_REAL_X0X) console.log(`real x0xd: ${st.x0x.version ?? 'online'}`);
    assert.match(lend, /Ollama|hosted model/);
    if (shots) await win.screenshot({ path: join(shots, 'desktop-compute.png') });

    // Connect: one-click Claude Desktop, written next to the other servers (dialog answered in main).
    await win.evaluate(() => { location.hash = '#/connect'; });
    await win.waitForSelector('#desk-connect [data-on="claude-desktop"]', { timeout: 15_000 });
    assert.equal(await win.$('#clone-dir'), null, 'the desktop Connect page has no clone steps');
    await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 0 }); });
    await win.click('#desk-connect [data-on="claude-desktop"]');
    await win.waitForSelector('#desk-connect [data-off="claude-desktop"]', { timeout: 10_000 });
    const cfg = JSON.parse(readFileSync(join(home, '.config', 'Claude', 'claude_desktop_config.json'), 'utf8'));
    assert.equal(cfg.mcpServers.other.command, 'keep-me');
    assert.equal(cfg.mcpServers.constellate.env.ELECTRON_RUN_AS_NODE, '1');
    assert.match(cfg.mcpServers.constellate.args[0], /dist[\\/]cli\.js$/);
    if (shots) await win.screenshot({ path: join(shots, 'desktop-connect.png') });

    // One click: this computer's x0x agent vouches for the person (works with the real x0xd too).
    const me = await win.evaluate(async () => (await import('/identity.js')).identity().agentId);
    await win.evaluate(() => { location.hash = '#/me'; });
    await win.waitForSelector('#x0x-link-btn', { timeout: 15_000 });
    await win.click('#x0x-link-btn');
    await win.waitForSelector('#x0x-link .chip.ok', { timeout: 20_000 });
    const linked = await win.evaluate(async (id) => (await (await fetch(`/api/me/${id}`)).json()).linked_x0x, me);
    assert.match(String(linked), /^[0-9a-f]{64}$/, 'linked to the x0x agent');
    if (shots) await win.screenshot({ path: join(shots, 'desktop-me.png') });

    // Other pages never get the bridge's powers: same preload, different origin, refused.
    const preload = join(ROOT, 'desktop', 'preload.cjs');
    const refused = await app.evaluate(async ({ BrowserWindow }, preload) => {
      const w = new BrowserWindow({ show: false, webPreferences: { preload, contextIsolation: true, sandbox: true } });
      await w.loadURL('data:text/html,<p>elsewhere</p>');
      const r = await w.webContents.executeJavaScript('window.constellateDesktop.status().then(() => "allowed", (e) => "refused: " + e.message)');
      w.destroy();
      return r;
    }, preload);
    assert.match(refused, /^refused: .*Not allowed/);
    console.log('desktop e2e: ok');
  } finally {
    await app.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
