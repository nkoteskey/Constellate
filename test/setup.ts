import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Tests must never touch the real ~/.constellate of whoever runs them: several start Constellate servers and
 * agents (with client names like "test"), and anything that falls back to the home folder (the agents'
 * activity log, plans, ledgers) would otherwise land in the person's own data and show up in their app.
 * Each test file gets a throwaway home, so even a test that clears CONSTELLATE_HOME stays inside it.
 */
const home = mkdtempSync(join(tmpdir(), 'constellate-test-home-'));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.CONSTELLATE_HOME ??= join(home, '.constellate');
