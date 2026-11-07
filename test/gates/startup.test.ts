import { describe, it, expect } from 'vitest';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Hub } from '../../src/hub/hub.js';
import { X0xClient } from '../../src/x0x/client.js';

/**
 * Starting while x0x is busy: a daemon that is up but doesn't answer (it's joining a busy network) must not
 * freeze Constellate's startup. Each call has a time limit, startup tries a few times and says so, and then
 * carries on without the network instead of hanging until the desktop app gives up.
 */
describe('starting while x0x is busy', () => {
  it('a daemon that answers health but nothing else doesn’t freeze startup', async () => {
    const hanging = createServer((req, res) => {
      if (req.url === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, status: 'healthy', version: 'busy', peers: 3 })); return; }
      // every other call: never answered
    });
    await new Promise<void>((r) => hanging.listen(0, '127.0.0.1', () => r()));
    const url = `http://127.0.0.1:${(hanging.address() as { port: number }).port}`;
    const started = Date.now();
    const hub = await Hub.fromEnv({ CONSTELLATE_HOME: mkdtempSync(join(tmpdir(), 'busy-')), X0X_API: url, X0X_TOKEN: 't', CONSTELLATE_X0X_START_TIMEOUT_MS: '300', CONSTELLATE_X0X_START_BACKOFF_MS: '50', CONSTELLATE_QUIET: '1' } as NodeJS.ProcessEnv);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(hub.x0x).toBeUndefined(); // carried on without the network, rather than hanging
    hanging.closeAllConnections(); hanging.close();
  });

  it('every x0x call has a time limit and says plainly what happened', async () => {
    const silent = createServer(() => { /* never answers */ });
    await new Promise<void>((r) => silent.listen(0, '127.0.0.1', () => r()));
    const c = new X0xClient(`http://127.0.0.1:${(silent.address() as { port: number }).port}`, 't');
    c.timeoutMs = 200;
    await expect(c.agent()).rejects.toThrow(/no answer from x0x after 0.2s \(GET \/agent\)/);
    silent.closeAllConnections(); silent.close();
    await expect(new X0xClient('http://127.0.0.1:9', 't').agent()).rejects.toThrow(/can’t reach x0x/);
  });
});
