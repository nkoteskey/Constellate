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
 * and the bundled server answers a real MCP handshake: the lean tool set by
 * default, every tool with CONSTELLATE_MCP_TOOLS=full.
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
    const tools = async (extra: Record<string, string>) => {
      const transport = new StdioClientTransport({ command: process.execPath, args: [join(dir, 'server/index.mjs'), 'mcp'], env: { ...process.env, CONSTELLATE_HOME: home, X0X_API: 'http://127.0.0.1:1', ...extra } as Record<string, string> });
      const client = new Client({ name: 'gate', version: '1' });
      await client.connect(transport);
      const t = (await client.listTools()).tools.map((x) => x.name);
      await client.close();
      return t;
    };
    // Lean by default (docs/STORAGE.md): the nine tools agents use, under a third of the tokens.
    expect((await tools({})).sort()).toEqual(['answers_lookup', 'answers_submit', 'bounties', 'bounty_post', 'failures_report', 'failures_search', 'plan_report', 'skills_find', 'work_step']);
    const full = await tools({ CONSTELLATE_MCP_TOOLS: 'full' });
    expect(full).toEqual(expect.arrayContaining(['failures_search', 'answers_lookup', 'skills_find', 'review_request', 'memory_put']));
    expect(full.length).toBeGreaterThan(40);
  }, 120_000);
});
