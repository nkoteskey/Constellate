// Renders the desktop icons from the Constellate mark (src/web/public/logo.svg) with Chromium.
// Run: node desktop/scripts/icons.cjs   (needs Playwright; outputs to desktop/build/)
const { chromium } = require('playwright');
const { join } = require('node:path');

const OUT = join(__dirname, '..', 'build');
const HI = '@' + '2x'; // Electron's high-density suffix (built up so it never reads like an address)
const mark = (opts) => `
  <line x1="12" y1="46" x2="32" y2="20" stroke="${opts.amber}" stroke-opacity="${opts.lineOpacity}" stroke-width="${opts.line}" stroke-linecap="round"/>
  <line x1="52" y1="44" x2="32" y2="20" stroke="${opts.blue}" stroke-opacity="${opts.lineOpacity}" stroke-width="${opts.line}" stroke-linecap="round"/>
  <circle cx="12" cy="46" r="${opts.dot}" fill="${opts.amber}"/>
  <circle cx="52" cy="44" r="${opts.dot}" fill="${opts.blue}"/>
  ${opts.glow ? '<circle cx="32" cy="20" r="11" fill="url(#g)"/>' : ''}
  <circle cx="32" cy="20" r="${opts.dot + 0.8}" fill="${opts.white}"/>`;

const APP = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#121a33"/><stop offset="1" stop-color="#05070e"/></linearGradient>
    <radialGradient id="g" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#fff" stop-opacity=".9"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
  </defs>
  <rect x="3" y="3" width="58" height="58" rx="13" fill="url(#bg)"/>
  <rect x="3.5" y="3.5" width="57" height="57" rx="12.5" fill="none" stroke="#fff" stroke-opacity=".08"/>
  <g transform="translate(6 7) scale(.81)">${mark({ amber: '#ffc46b', blue: '#7cc4ff', white: '#fff', line: 2, lineOpacity: 0.7, dot: 3.6, glow: true })}</g>
</svg>`;
const TRAY = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="4 6 56 48">${mark({ amber: '#ffc46b', blue: '#7cc4ff', white: '#fff', line: 4, lineOpacity: 0.9, dot: 6, glow: false })}</svg>`;
const TEMPLATE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="4 6 56 48">${mark({ amber: '#000', blue: '#000', white: '#000', line: 4, lineOpacity: 1, dot: 6, glow: false })}</svg>`;

(async () => {
  const b = await chromium.launch();
  const p = await b.newPage();
  const render = async (svg, size, file) => {
    await p.setViewportSize({ width: size, height: size });
    await p.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
    await p.screenshot({ path: join(OUT, file), omitBackground: true });
  };
  await render(APP, 1024, 'icon.png');
  await render(TRAY, 16, 'tray.png'); await render(TRAY, 32, `tray${HI}.png`);
  await render(TEMPLATE, 16, 'trayTemplate.png'); await render(TEMPLATE, 32, `trayTemplate${HI}.png`);
  await b.close();
})();
