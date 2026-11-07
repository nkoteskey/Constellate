import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KeyVault } from '../../src/contributor/keyvault.js';
import { runnerFromSpec } from '../../src/contributor/catalog.js';
import { seedDemo } from '../../src/demo.js';
import { WebServer } from '../../src/web/server.js';
import { registerAppRoutes } from '../../src/web/app.js';
import { LocalSigner } from '../../src/core/identity.js';
import { signRecord } from '../../src/core/record.js';
import { MockRunner } from '../../src/contributor/models.js';
import { Deliberation } from '../../src/collective/deliberation.js';

/** The gaps found by re-reading DESIGN.md and Amendment 1 against the code. */
describe('audit gaps, closed', () => {
  it('API keys come from the encrypted on-device vault first (Amendment 1 §5)', () => {
    const v = new KeyVault(join(mkdtempSync(join(tmpdir(), 'vault-')), 'keys.json'));
    v.set('groq', 'gsk_from_vault');
    const r = runnerFromSpec('groq/llama-3.3-70b-versatile', { vault: v, env: {} }) as unknown as { apiKey: string };
    expect(r.apiKey).toBe('gsk_from_vault');
    expect(() => runnerFromSpec('openai/gpt-5', { vault: v, env: {} })).toThrow(/constellate keys set openai/);
    v.remove('groq');
    expect(v.names()).toEqual([]);
  });

  it('people see the disagreement court, and rule on the cases it hands them', async () => {
    process.env.CONSTELLATE_DEMO = '1';
    const d = await seedDemo({ knowledge: 0 });
    const web = new WebServer(d.viewer); registerAppRoutes(web); await web.listen(0);
    try {
      const court = await (await fetch(`${web.url}/api/court`)).json();
      const open = court.find((c: { needs_human: boolean }) => c.needs_human);
      expect(open.reasoning).toMatch(/person/);
      const person = LocalSigner.generate();
      const rule = async (decision: string, refs: string[]) => fetch(`${web.url}/api/records`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(await signRecord({ kind: 'ruling', context: { task: 'disagreement court', domain: ['deliberation'], environment: 'human (browser)' }, body: { case: [open.first.id, open.second.id], decision, reasoning: 'ran it on 0.49', confidence: 1, needs_human: false, judge_family: 'human' }, refs }, person)) });
      expect((await rule('both_conditional', [open.second.id, open.first.id])).status).toBe(400); // must name the case in order
      expect((await rule('both_conditional', [open.first.id, open.second.id])).status).toBe(200);
      const after = (await (await fetch(`${web.url}/api/court`)).json()).find((c: { id: string }) => c.id === open.id);
      expect(after.people.both_conditional).toBe(1);
    } finally { await web.close(); }
  });

  it('debates are revisited: a model re-runs its family’s position and the shift is kept', async () => {
    const d = await seedDemo({ knowledge: 0 });
    const delib = new Deliberation(d.agents[2]);
    const before = delib.map(d.question).positions.find((p) => p.family === 'claude')!;
    const runner = new MockRunner('demo:claude-v2', 'claude', 'large', () => '{"statement": "Fairness depends on context, but every context needs a rule announced in advance.", "confidence": 0.75, "cruxes": ["whether outcomes or procedures matter more"]}');
    expect(await delib.rerun(d.question, runner)).toBe(1);
    const after = delib.map(d.question).positions.find((p) => p.family === 'claude')!;
    expect(after.history.length).toBe(before.history.length + 1);
    expect(after.statement).toMatch(/announced in advance/);
    // A model that doesn't change its mind records nothing new.
    expect(await delib.rerun(d.question, new MockRunner('x', 'claude', 'large', () => JSON.stringify({ statement: after.statement, confidence: after.confidence })))).toBe(0);
  });

  it('one install command, which asks before installing and can dry-run', () => {
    const out = execFileSync('sh', ['distribution/install/install.sh', '--dry-run'], { encoding: 'utf8', env: { ...process.env, CONSTELLATE_HOME: mkdtempSync(join(tmpdir(), 'inst-')) } });
    expect(out).toMatch(/dry run: nothing will change/);
    expect(out).toMatch(/constellate-mcp|install from source|isn't on npm yet/i);
    expect(out).not.toMatch(/npm install -g constellate(\s|$)/);
  });
});
