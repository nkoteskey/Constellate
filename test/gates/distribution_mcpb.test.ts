import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/**
 * One-click install for Claude Desktop: the .mcpb bundle is self-contained
 * (no npm package needed), its manifest has what Claude Desktop requires,
 * and the bundled server answers a real MCP handshake with the full tool set.
 */
describe('distribution: one-click Claude Desktop bundle', () => {
  it('builds, declares a valid manifest, and serves every tool from a single file', async () => {
    execFileSync('npx', ['tsx', 'scripts/build-mcpb.mts'], { stdio: 'pipe' });
    const dir = 'distribution/mcpb/build';
    const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    for (const k of ['name', 'version', 'description', 'author', 'server']) expect(m[k], k).toBeTruthy();
    expect(m.manifest_version).toBe('0.2');
    expect(m.server).toMatchObject({ type: 'node', entry_point: 'server/index.mjs', mcp_config: { command: 'node' } });
    const home = mkdtempSync(join(tmpdir(), 'constellate-mcpb-'));
    const transport = new StdioClientTransport({ command: process.execPath, args: [join(dir, 'server/index.mjs'), 'mcp'], env: { ...process.env, CONSTELLATE_HOME: home, X0X_API: 'http://127.0.0.1:1' } as Record<string, string> });
    const client = new Client({ name: 'gate', version: '1' });
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(['failures_search', 'answers_lookup', 'skills_find', 'review_request', 'memory_put']));
    expect(tools.length).toBeGreaterThan(40);
    await client.close();
  }, 120_000);
});
