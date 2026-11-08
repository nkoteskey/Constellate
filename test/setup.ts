import { existsSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';

/**
 * Tests must never touch the real ~/.constellate of whoever runs them: several start Constellate servers and
 * agents (with client names like "test"), and anything that falls back to the home folder (the agents'
 * activity log, plans, ledgers) would otherwise land in the person's own data and show up in their app.
 * Each test file gets a throwaway home, so even a test that clears CONSTELLATE_HOME stays inside it.
 *
 * Tools that find their own installs through the home folder keep finding them: Playwright's browsers are
 * pinned to where they really are before the home folder moves.
 */
const realHome = homedir();
if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
  const browsers = process.platform === 'darwin' ? join(realHome, 'Library', 'Caches', 'ms-playwright')
    : process.platform === 'win32' ? join(process.env.LOCALAPPDATA ?? join(realHome, 'AppData', 'Local'), 'ms-playwright')
    : join(process.env.XDG_CACHE_HOME ?? join(realHome, '.cache'), 'ms-playwright');
  if (existsSync(browsers)) process.env.PLAYWRIGHT_BROWSERS_PATH = browsers;
}
const home = mkdtempSync(join(tmpdir(), 'constellate-test-home-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.CONSTELLATE_HOME ??= join(home, '.constellate');
