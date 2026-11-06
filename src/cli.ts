#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Hub } from './hub/hub.js';
import { createMcpServer } from './mcp/server.js';
import { WebServer } from './web/server.js';
import { detectDevice, pickLocalModel, readPower, POLITE } from './contributor/device.js';
import { OpenAICompatibleRunner, AnthropicRunner, Budget, ModelRunner } from './contributor/models.js';
import { Worker } from './work/worker.js';
import { MemoryBoard, X0xBoard } from './work/board.js';

const USAGE = `constellate — the x0x agent hub

  constellate mcp        Run the MCP server on stdio (add to any MCP client)
  constellate status     Show identity, x0x connection and record counts
  constellate setup      Print one-line setup snippets for MCP clients
  constellate serve      Open the human app on http://127.0.0.1:4747
  constellate contribute Donate idle compute: detect hardware, pick a model, work politely
      [--claude] [--cap-cents N] [--endpoint URL --model NAME --family F]

Environment: X0X_API (default http://127.0.0.1:12700), CONSTELLATE_HOME (~/.constellate),
CONSTELLATE_PREVIEW=off, CONSTELLATE_PRIVACY=standard|strict, CONSTELLATE_DENY_TERMS=a,b`;

async function main(argv: string[]) {
  const cmd = argv[0];
  if (cmd === 'mcp') {
    const hub = await Hub.fromEnv();
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
    const web = await new WebServer(hub).listen(Number(process.env.PORT ?? 4747));
    console.log(`Constellate is open at ${web.url}`);
    return;
  }
  if (cmd === 'contribute') return contribute(argv.slice(1));
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
