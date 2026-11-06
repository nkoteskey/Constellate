#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Hub } from './hub/hub.js';
import { createMcpServer } from './mcp/server.js';
import { Consolidator } from './graph/consolidate.js';
import { WebServer } from './web/server.js';
import { registerAppRoutes } from './web/app.js';
import { registerEconomyRoutes } from './economy/routes.js';
import { TestnetLedger } from './economy/rail.js';
import { detectDevice, pickLocalModel, readPower, POLITE } from './contributor/device.js';
import { OpenAICompatibleRunner, AnthropicRunner, Budget, ModelRunner } from './contributor/models.js';
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
  constellate contribute Donate idle compute: detect hardware, pick a model, work politely
      [--claude] [--cap-cents N] [--endpoint URL --model NAME --family F]

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

async function contribute(args: string[]) {
  const hub = await Hub.fromEnv();
  const device = detectDevice();
  const choice = pickLocalModel(device);
  let runner: ModelRunner;
  if (args.includes('--claude')) runner = new AnthropicRunner();
  else if (flag(args, '--endpoint')) runner = new OpenAICompatibleRunner(`custom:${flag(args, '--model')}`, flag(args, '--family') ?? 'unknown', 'small', flag(args, '--endpoint')!, flag(args, '--model') ?? '', process.env.MODEL_API_KEY);
  else if (choice.runtime === 'none') { console.log(choice.reason); return; }
  else runner = new OpenAICompatibleRunner(`${choice.runtime}:${choice.model}`, choice.family, choice.size, choice.runtime === 'mlx' ? 'http://127.0.0.1:8080/v1' : 'http://127.0.0.1:11434/v1', choice.model);
  console.log(`Device: ${device.cpu}, ${device.memGB} GB. Model: ${runner.id} (${choice.reason}).`);
  const board = hub.x0x ? new X0xBoard(hub.x0x, 'constellate/v1/board') : new MemoryBoard();
  const worker = new Worker(hub, runner, hub.problems, board, { policy: POLITE, power: readPower, budget: new Budget(Number(flag(args, '--cap-cents') ?? 0) || (runner.costPerCall ? 100 : Infinity)) });
  let last = '';
  for (;;) {
    let didWork = false;
    for (const p of hub.problems.list()) {
      const o = await worker.step(p.rec.id).catch((e) => { console.error(String(e)); return 'idle' as const; });
      if (o !== 'idle' && o !== 'paused') didWork = true;
    }
    if (worker.status.message !== last) { console.log(`● ${worker.status.message}`); last = worker.status.message; }
    if (!didWork) await new Promise((r) => setTimeout(r, 30_000));
  }
}

main(process.argv.slice(2)).catch((e) => { console.error(e); process.exit(1); });
