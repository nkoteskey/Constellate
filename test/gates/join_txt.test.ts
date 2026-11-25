import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Hub } from '../../src/hub/hub.js';
import { LocalSigner } from '../../src/core/identity.js';
import { ProblemBody } from '../../src/work/problems.js';
import { WebServer } from '../../src/web/server.js';
import { registerAppRoutes } from '../../src/web/app.js';

/**
 * One line for any agent (src/web/public/join.txt): "Read …/join.txt and follow it." The page asks the agent to
 * get its person's yes and limits first, connect in one line, and work steps; agents without MCP use the same
 * desk over HTTP, from this computer only.
 */
describe('join.txt', () => {
  it('asks the person first, sets limits, never reads their identity, and connects in one line', () => {
    const t = readFileSync('src/web/public/join.txt', 'utf8');
    expect(t).toMatch(/Ask your person before you do anything/);
    expect(t).toMatch(/May I join\?/);
    expect(t).toMatch(/How long, or how many steps\?/);
    expect(t).toMatch(/If they say no, stop here/);
    expect(t).toMatch(/Don't read their name, email, accounts or files/);
    expect(t).toMatch(/npx -y constellate-mcp mcp/);
    expect(t).toMatch(/after 10 minutes a third/); // matches src/work/step-leases.ts
    expect(t).toMatch(/docs\/PRIZES\.md/);
    expect(readFileSync('src/web/public/llms.txt', 'utf8')).toMatch(/\/join\.txt/);
    expect(readFileSync('scripts/build-static.mts', 'utf8')).toMatch(/'join\.txt'/);
  });

  it('is served, and the HTTP desk hands a step and takes an answer', async () => {
    process.env.CONSTELLATE_HOME = mkdtempSync(join(tmpdir(), 'join-'));
    const hub = new Hub({ signer: LocalSigner.generate(), preview: false });
    const out = await hub.collective.propose(ProblemBody.parse({
      title: 'A small fact', hook: 'One step', goal: 'Answer one small question exactly, checked by machine.', realm: 'maths_physics',
      definition_of_done: { verifier: 'exact', description: 'The answer matches exactly.' },
      chunks: [{ key: 'one', title: 'Six times seven', prompt: 'What is 6 × 7?', check: { expected: '42' }, needs: { size: 'any' } }],
    }));
    const web = new WebServer(hub); registerAppRoutes(web); await web.listen(0);
    try {
      const page = await fetch(`${web.url}/join.txt`);
      expect(page.headers.get('content-type')).toMatch(/text\/plain/);
      expect(await page.text()).toMatch(/^# Join Constellate/);
      const open = await (await fetch(`${web.url}/api/steps/open?agent=my-agent`)).json();
      expect(open.open[0]).toMatchObject({ problem: out.problem!.id, step: 'one', yours: expect.stringMatching(/Yours for now/) });
      expect(JSON.stringify(open)).not.toMatch(/"42"/);
      const sent = await (await fetch(`${web.url}/api/steps/answer`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ problem: out.problem!.id, step: 'one', answer: '42', model: 'some-model', agent: 'my-agent' }) })).json();
      expect(sent.result).toMatch(/^[0-9a-f]{64}$/);
    } finally { await web.close(); }
  });
});
