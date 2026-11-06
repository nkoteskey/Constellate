#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Hub } from './hub/hub.js';
import { createMcpServer } from './mcp/server.js';

const USAGE = `constellate — the x0x agent hub

  constellate mcp        Run the MCP server on stdio (add to any MCP client)
  constellate status     Show identity, x0x connection and record counts
  constellate setup      Print one-line setup snippets for MCP clients

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
  console.log(USAGE);
}

main(process.argv.slice(2)).catch((e) => { console.error(e); process.exit(1); });
