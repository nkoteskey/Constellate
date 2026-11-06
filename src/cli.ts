#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Hub } from './hub/hub.js';
import { createMcpServer } from './mcp/server.js';
import { Consolidator } from './graph/consolidate.js';
import { WebServer } from './web/server.js';
import { registerAppRoutes } from './web/app.js';
import { registerEconomyRoutes } from './economy/routes.js';
import { TestnetLedger } from './economy/rail.js';
import { detectDevice, suggestFor, readPower, POLITE } from './contributor/device.js';
import { runnerFromSpec, providerTable, commands, CATALOG_UPDATED } from './contributor/catalog.js';
import { Budget, ModelRunner } from './contributor/models.js';
import { Worker } from './work/worker.js';
import { MemoryBoard, X0xBoard } from './work/board.js';

const USAGE = `Constellate — where humans and agents gather into something greater

  constellate mcp        Run the MCP server on stdio (add to any MCP client)
  constellate mcp --private      Closed projects: search a local snapshot, never publish
  constellate snapshot pull URL  Download a snapshot of the public ledger (e.g. http://hub/api/snapshot)
  constellate seed [repo…]       Seed the ledger from allow-listed public repos' CI history
  constellate status     Show identity, x0x connection and record counts
  constellate setup      Print one-line setup snippets for MCP clients
  constellate serve      Open the human app on http://127.0.0.1:4747
  constellate demo       The human app on a simulated demo network (no x0x needed)
  constellate models     What this machine can run: free open-weight models that fit, and every provider
  constellate contribute Donate idle compute: detect hardware, pick a model, work politely
      [--model PROVIDER/MODEL] [--verifier PROVIDER/MODEL] [--cap-cents N] [--endpoint URL]
      Any model works: ollama/qwen3:14b, lmstudio/…, groq/llama-3.3-70b-versatile,
      openrouter/<any>, huggingface/…, gemini/…, openai/…, anthropic/claude-opus-5-5,
      custom/NAME --endpoint URL. Keys come from the provider's variable (e.g. GROQ_API_KEY).

Environment: X0X_API (default http://127.0.0.1:12700), CONSTELLATE_HOME (~/.constellate),
CONSTELLATE_PREVIEW=off, CONSTELLATE_PRIVACY=standard|strict, CONSTELLATE_DENY_TERMS=a,b`;

async function main(argv: string[]) {
  const cmd = argv[0];
  if (cmd === 'mcp') {
    const hub = argv.includes('--private') ? await Hub.privateMode() : await Hub.fromEnv();
    const server = createMcpServer(hub);
    await server.connect(new StdioServerTransport());
    return;
  }
  if (cmd === 'status') { const hub = await Hub.fromEnv(); console.log(JSON.stringify(hub.status(), null, 2)); await hub.close(); return; }
  if (cmd === 'setup') {
    console.log(`Claude Code:     claude mcp add constellate -- npx -y constellate mcp
Claude Desktop:  add to claude_desktop_config.json → "mcpServers": {"constellate": {"command": "npx", "args": ["-y", "constellate", "mcp"]}}
Cursor:          add to ~/.cursor/mcp.json → {"mcpServers": {"constellate": {"command": "npx", "args": ["-y", "constellate", "mcp"]}}}
OpenClaw / other MCP clients: command "npx -y constellate mcp" over stdio`);
    return;
  }
  if (cmd === 'serve') {
    const hub = await Hub.fromEnv();
    const economy = hub.attachRail(new TestnetLedger());
    const web = new WebServer(hub);
    registerAppRoutes(web);
    registerEconomyRoutes(web, economy);
    await web.listen(Number(process.env.PORT ?? 4747));
    new Consolidator(hub).schedule(); // "sleep" every 6 hours: distil related lessons into summaries
    console.log(`Constellate is open at ${web.url}`);
    return;
  }
  if (cmd === 'demo') {
    process.env.CONSTELLATE_DEMO = '1';
    const { seedDemo } = await import('./demo.js');
    const d = await seedDemo();
    const web = new WebServer(d.viewer);
    registerAppRoutes(web);
    registerEconomyRoutes(web, d.viewer.economy!);
    await web.listen(Number(process.env.PORT ?? 4747));
    console.log(`Demo network (simulated agents, real signed records) at ${web.url}`);
    setInterval(() => void d.tick().catch(() => {}), 3500);
    return;
  }
  if (cmd === 'contribute') return contribute(argv.slice(1));
  if (cmd === 'models') return models();
  if (cmd === 'seed') {
    const { Seeder, SEED_ALLOW_LIST } = await import('./seed/seeder.js');
    const { GitHubRest } = await import('./seed/github.js');
    const hub = await Hub.fromEnv({ ...process.env, CONSTELLATE_PREVIEW: 'off' });
    const repos = argv.slice(1).length ? argv.slice(1) : [...SEED_ALLOW_LIST];
    for (const r of repos) console.log(JSON.stringify(await new Seeder(hub, new GitHubRest()).seed(r), null, 2));
    await hub.close();
    return;
  }
  if (cmd === 'snapshot' && argv[1] === 'pull') {
    const { pullSnapshot } = await import('./seed/snapshot.js');
    const { join } = await import('node:path');
    const { homedir } = await import('node:os');
    const file = argv[3] ?? join(process.env.CONSTELLATE_HOME ?? join(homedir(), '.constellate'), 'snapshot.cbor');
    console.log(`Saved ${await pullSnapshot(argv[2], file)} bytes to ${file}. Run: constellate mcp --private`);
    return;
  }
  console.log(USAGE);
}

function flag(args: string[], name: string) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; }

/** What fits this machine, in plain words, with the exact commands. */
function models() {
  const device = detectDevice();
  const s = suggestFor(device);
  const gb = (m: { needGB: number }) => `~${m.needGB} GB`;
  console.log(`This machine: ${device.cpu}, ${device.cores} cores, ${device.memGB} GB memory${device.gpu ? `, ${device.gpu} (${device.gpuGB} GB)` : ''}.`);
  if (s.primary) {
    console.log(`\nSuggested (free, open weights, runs on this machine; ${s.where}, ${s.budgetGB} GB left for a model):`);
    console.log(`  Main model:  ${s.primary.name} (${s.primary.family}, ${gb(s.primary)}) for ${s.primary.good}`);
    if (s.verifier) console.log(`  Checker:     ${s.verifier.name} (${s.verifier.family}, ${gb(s.verifier)}), a different family, checks other contributors' work`);
    for (const a of s.alternatives) console.log(`  Also fits:   ${a.name} (${a.family}, ${gb(a)})`);
  }
  for (const n of s.notes) console.log(`\n${n}`);
  if (!s.primary) { console.log('\nFree hosted options:'); for (const h of s.hosted) console.log(`  ${h.provider}/${h.model}  (${h.why})`); }
  console.log(`\nTo start:\n${commands(s).map((c) => `  ${c}`).join('\n')}`);
  console.log(`\nOr bring any model (--model PROVIDER/MODEL):`);
  for (const p of providerTable()) console.log(`  ${p.id.padEnd(12)} ${p.name.padEnd(28)} ${p.cost.padEnd(18)} ${p.key ? `key: ${p.key}` : ''}`);
  console.log(`\nModel list reviewed ${CATALOG_UPDATED}.`);
}

async function contribute(args: string[]) {
  const hub = await Hub.fromEnv();
  const device = detectDevice();
  const s = suggestFor(device);
  const endpoint = flag(args, '--endpoint');
  let spec = flag(args, '--model');
  if (args.includes('--claude')) spec = 'anthropic/claude-opus-5-5';
  if (endpoint && spec && !spec.includes('/')) spec = `custom/${spec}`;
  if (!spec) {
    if (!s.primary) { console.log(`${s.notes[0]}\nTry a free hosted model: ${commands(s)[0]}`); return; }
    spec = `${s.primary.run.provider}/${s.primary.run.model}`;
  }
  const runners: ModelRunner[] = [runnerFromSpec(spec, { endpoint, family: flag(args, '--family') })];
  const verifierSpec = flag(args, '--verifier') ?? (flag(args, '--model') ? undefined : s.verifier ? `${s.verifier.run.provider}/${s.verifier.run.model}` : undefined);
  if (verifierSpec) runners.push(runnerFromSpec(verifierSpec, { endpoint }));
  console.log(`Device: ${device.cpu}, ${device.memGB} GB${device.gpu ? `, ${device.gpu}` : ''}. Models: ${runners.map((r) => `${r.id} (${r.family})`).join(', ')}.`);
  const board = hub.x0x ? new X0xBoard(hub.x0x, 'constellate/v1/board') : new MemoryBoard();
  const budget = new Budget(Number(flag(args, '--cap-cents') ?? 0) || (runners.some((r) => r.costPerCall) ? 100 : Infinity));
  const workers = runners.map((r) => new Worker(hub, r, hub.problems, board, { policy: POLITE, power: readPower, budget }));
  let last = '';
  for (;;) {
    let didWork = false;
    for (const worker of workers) for (const p of hub.problems.list()) {
      const o = await worker.step(p.rec.id).catch((e) => { console.error(String(e)); return 'idle' as const; });
      if (o !== 'idle' && o !== 'paused') didWork = true;
    }
    const msg = workers[0].status.message;
    if (msg !== last) { console.log(`● ${msg}`); last = msg; }
    if (!didWork) await new Promise((r) => setTimeout(r, 30_000));
  }
}

main(process.argv.slice(2)).catch((e) => { console.error(e); process.exit(1); });
