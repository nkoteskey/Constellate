#!/usr/bin/env node
// A stand-in for x0xd in tests: reads the same --config file, listens on a random loopback port,
// and writes `api.port` and `api-token` into data_dir exactly as the real daemon does.
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const args = process.argv.slice(2);
const cfgText = readFileSync(args[args.indexOf('--config') + 1], 'utf8');
const val = (k) => { const m = cfgText.match(new RegExp(`^${k} = (?:'([^']*)'|"((?:[^"\\\\]|\\\\.)*)")`, 'm')); return m ? (m[1] ?? JSON.parse(`"${m[2]}"`)) : undefined; };
const dataDir = val('data_dir');
mkdirSync(dataDir, { recursive: true });
writeFileSync(join(dataDir, 'fake-args.json'), JSON.stringify({ args, config: cfgText }));
if (process.env.FAKE_X0XD_FAIL) { console.error('fake x0xd: told to fail'); process.exit(3); }
// As x0xd 0.48 does: a named instance must say which network plane it joins.
if (val('instance_name') && !/^network_id = "/m.test(cfgText)) { console.error(`Error: named instance '${val('instance_name')}' has no network_id`); process.exit(1); }
const token = randomBytes(16).toString('hex');
const server = createServer((req, res) => {
  if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401).end('{}'); return; }
  res.writeHead(200, { 'content-type': 'application/json' });
  if (req.url === '/health') res.end(JSON.stringify({ ok: true, status: 'healthy', version: 'fake-0.48.1', peers: 3 }));
  else if (req.url === '/agent') res.end(JSON.stringify({ ok: true, agent_id: 'ab'.repeat(32), machine_id: 'cd'.repeat(32), user_id: null }));
  else res.end('{"ok":true}');
});
server.listen(0, '127.0.0.1', () => {
  writeFileSync(join(dataDir, 'api-token'), token);
  writeFileSync(join(dataDir, 'api.port'), `127.0.0.1:${server.address().port}`);
  console.log(`fake x0xd listening on ${server.address().port}`);
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));
