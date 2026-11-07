// Starts an MCP server over stdio and checks it the way directory checks do: initialize, then tools/list,
// with nothing but JSON-RPC allowed on stdout. Exits non-zero on any problem.
//   node scripts/container-smoke.mjs docker run -i --rm constellate-mcp
//   node scripts/container-smoke.mjs node dist/cli.js mcp
import { spawn } from 'node:child_process';

const [cmd, ...args] = process.argv.slice(2);
if (!cmd) { console.error('usage: node scripts/container-smoke.mjs <command> [args...]'); process.exit(2); }
const t0 = Date.now();
const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'inherit'] });
const fail = (why) => { console.error(`FAIL: ${why}`); child.kill(); process.exit(1); };
const timer = setTimeout(() => fail('no tools/list answer within 120s'), 120_000);
const send = (m) => child.stdin.write(JSON.stringify(m) + '\n');
let buf = '';
child.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let m;
    try { m = JSON.parse(line); } catch { return fail(`non-JSON on stdout: ${line.slice(0, 160)}`); }
    if (m.jsonrpc !== '2.0') return fail(`not JSON-RPC: ${line.slice(0, 160)}`);
    if (m.id === 1) {
      if (!m.result?.serverInfo) return fail(`initialize failed: ${line.slice(0, 300)}`);
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    } else if (m.id === 2) {
      const tools = m.result?.tools ?? [];
      if (!tools.length) return fail(`tools/list returned no tools: ${line.slice(0, 300)}`);
      console.log(`OK in ${Date.now() - t0}ms: ${tools.length} tools (${tools.map((t) => t.name).join(', ')})`);
      clearTimeout(timer);
      // Hang up the way clients do; the server (and so its container) must end on its own.
      hungUp = true;
      setTimeout(() => fail('server still running 15s after stdin closed'), 15_000);
      child.stdin.end();
    }
  }
});
let hungUp = false;
child.on('exit', (code, sig) => {
  if (!hungUp) fail(`server exited early (code ${code}, signal ${sig})`);
  if (code !== 0) fail(`server exited with code ${code}, signal ${sig} after hang-up`);
  console.log('OK: server exited after hang-up');
  process.exit(0);
});
send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'container-smoke', version: '1' } } });
