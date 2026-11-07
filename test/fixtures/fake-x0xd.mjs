#!/usr/bin/env node
// A stand-in for x0xd in tests: reads the same --config file, listens on a random loopback port,
// and writes `api.port` and `api-token` into data_dir exactly as the real daemon does.
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';

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
// /agent/sign as x0xd does it: ML-DSA-65 over [0xF0] | "x0x.external-agent-sign.v1" | len(ctx) u32 BE | ctx | payload.
const agent = ml_dsa65.keygen(randomBytes(32));
const agentId = createHash('sha256').update(Buffer.concat([Buffer.from('AUTONOMI_PEER_ID_V2:'), Buffer.from(agent.publicKey)])).digest('hex');
const dst = (ctx, payload) => { const c = Buffer.from(ctx); const n = Buffer.alloc(4); n.writeUInt32BE(c.length); return Buffer.concat([Buffer.from([0xf0]), Buffer.from('x0x.external-agent-sign.v1'), n, c, payload]); };
const stores = new Map();
const body = (req) => new Promise((r) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => r(b ? JSON.parse(b) : {})); });
const server = createServer(async (req, res) => {
  if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401).end('{}'); return; }
  res.writeHead(200, { 'content-type': 'application/json' });
  if (req.url === '/agent/sign' && req.method === 'POST') {
    const j = await body(req);
    const sig = ml_dsa65.sign(dst(j.context, Buffer.from(j.payload_b64, 'base64')), agent.secretKey);
    res.end(JSON.stringify({ ok: true, agent_id: agentId, public_key_b64: Buffer.from(agent.publicKey).toString('base64'), signature_b64: Buffer.from(sig).toString('base64'), algorithm: 'ml-dsa-65' }));
    return;
  }
  // An open directory (self_keyed): join by topic, write only under this agent's id, read anything.
  const sm = req.url.match(/^\/stores\/([^/]+)\/(join|keys|.+)$/);
  if (sm) {
    const topic = decodeURIComponent(sm[1]);
    if (sm[2] === 'join' && req.method === 'POST') { const already = stores.has(topic); if (!already) stores.set(topic, new Map()); res.end(JSON.stringify(already ? { ok: false, error: 'already joined' } : { ok: true, id: topic })); return; }
    const st = stores.get(topic);
    if (!st) { res.statusCode = 404; res.end('{"ok":false}'); return; }
    if (sm[2] === 'keys') { res.end(JSON.stringify({ ok: true, keys: [...st.keys()].map((key) => ({ key })) })); return; }
    const key = decodeURIComponent(sm[2]);
    if (req.method === 'PUT') {
      if (key !== agentId && !key.startsWith(`${agentId}/`)) { res.statusCode = 403; res.end('{"ok":false,"error":"self_keyed"}'); return; }
      const j = await body(req); st.set(key, j.value); res.end('{"ok":true}'); return;
    }
    const v = st.get(key); if (!v) { res.statusCode = 404; res.end('{"ok":false}'); return; }
    res.end(JSON.stringify({ ok: true, value: v })); return;
  }
  if (req.url === '/presence/online') { res.end(JSON.stringify({ ok: true, agents: [{ agent_id: agentId }] })); return; }
  if (req.url === '/health') res.end(JSON.stringify({ ok: true, status: 'healthy', version: 'fake-0.48.1', peers: 3 }));
  else if (req.url === '/agent') res.end(JSON.stringify({ ok: true, agent_id: agentId, machine_id: 'cd'.repeat(32), user_id: null }));
  else res.end('{"ok":true}');
});
server.listen(0, '127.0.0.1', () => {
  writeFileSync(join(dataDir, 'api-token'), token);
  writeFileSync(join(dataDir, 'api.port'), `127.0.0.1:${server.address().port}`);
  console.log(`fake x0xd listening on ${server.address().port}`);
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));
