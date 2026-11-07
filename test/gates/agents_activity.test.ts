import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Hub } from '../../src/hub/hub.js';
import { LocalSigner } from '../../src/core/identity.js';
import { signRecord } from '../../src/core/record.js';
import { WebServer } from '../../src/web/server.js';
import { registerAppRoutes } from '../../src/web/app.js';
import { ActivityLog, clientName } from '../../src/hub/activity.js';

/**
 * Once an agent is connected, the person can see what it did (checks, finds, shares) without
 * any setup; votes can be withdrawn; and the suggestions under search follow real activity.
 */
describe('what connected agents do, votes you can take back, and live suggestions', () => {
  it('records each agent’s checks and shares on this computer, never its query text', () => {
    const log = new ActivityLog(join(mkdtempSync(join(tmpdir(), 'act-')), 'agent-activity.jsonl'));
    log.record('claude-code', 'failures_search', { results: [{ id: 'a'.repeat(64) }, { id: 'b'.repeat(64) }] });
    log.record('claude-code', 'failures_search', { results: [] });
    log.record('claude-code', 'failures_report', { id: 'c'.repeat(64) });
    log.record('Cursor', 'answers_lookup', { results: [{ id: 'd'.repeat(64) }] });
    const s = log.summary();
    expect(s.agents.map((a) => a.client).sort()).toEqual(['Claude Code', 'Cursor']);
    const cc = s.agents.find((a) => a.client === 'Claude Code')!;
    expect(cc.today).toEqual({ lookups: 2, found: 1, shared: 1 });
    expect(readFileSync(log.file, 'utf8')).not.toMatch(/query|approach|error_summary/);
    expect(clientName('claude-ai')).toBe('Claude Desktop');
    expect(clientName('gemini-cli-mcp-client')).toBe('Gemini CLI');
  });

  it('serves that activity only to this computer, takes votes back, and suggests what people are sharing', async () => {
    const home = mkdtempSync(join(tmpdir(), 'home-'));
    process.env.CONSTELLATE_HOME = home;
    const hub = new Hub({ signer: LocalSigner.generate(), preview: false });
    const web = new WebServer(hub); registerAppRoutes(web); await web.listen(0);
    try {
      new ActivityLog().record('claude-code', 'failures_search', { results: [] });
      const act = await (await fetch(`${web.url}/api/agents/activity`)).json();
      expect(act.agents[0].client).toBe('Claude Code');
      expect(act.recent[0].label).toBe('checked what failed before (0 found)');

      // A person's latest vote counts; support:false withdraws it.
      const p = await hub.collective.propose((await import('../../src/work/launch.js')).leanLaunchProblem());
      const person = LocalSigner.generate();
      const vote = async (support: boolean) => fetch(`${web.url}/api/records`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(await signRecord({ kind: 'vote', context: { task: 'vote', domain: ['collective'], environment: 'human (browser)' }, body: { problem: p.problem!.id, support }, refs: [p.problem!.id] }, person)) });
      expect((await vote(true)).status).toBe(200);
      expect(hub.collective.supporters(p.problem!.id)).toContain(person.agentId);
      await new Promise((r) => setTimeout(r, 5));
      expect((await vote(false)).status).toBe(200);
      expect(hub.collective.supporters(p.problem!.id)).not.toContain(person.agentId);

      // Suggestions follow what's being shared.
      await hub.ledger.reportFailure({ task: 'deploy', domain: ['x'], environment: 'node 22' }, { approach: 'Webhook retries flood the queue after an outage', outcome: 'error', error_summary: 'every retry fires at once', confidence: 0.8 }, { publish: true });
      const t = await (await fetch(`${web.url}/api/trending`)).json();
      expect(t.items.map((x: { text: string }) => x.text)).toContain('Webhook retries flood the queue after an outage');
    } finally { await web.close(); delete process.env.CONSTELLATE_HOME; }
  });
});
