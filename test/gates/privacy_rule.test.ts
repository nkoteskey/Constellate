import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { Hub } from '../../src/hub/hub.js';
import { LocalSigner } from '../../src/core/identity.js';
import { signRecord } from '../../src/core/record.js';
import { scrub } from '../../src/privacy/scrub.js';
import { redactPersonal } from '../../src/privacy/redact.js';
import { findPersonNames } from '../../src/privacy/names.js';
import { IssueSeeder } from '../../src/seed/issues.js';
import { WebServer } from '../../src/web/server.js';
import { registerAppRoutes } from '../../src/web/app.js';

/**
 * Constellate's personal-data rule. Records are permanent, so people are only
 * ever named by a public handle (@name) or an organisation: never an email,
 * phone number, personal name or home folder. Enforced at every way in:
 * publishing, the browser, records arriving from other nodes, imported public
 * history, and this repository itself.
 */
const ctx = { task: 't', domain: ['x'], environment: 'human (browser)' };

describe('the personal-data rule', () => {
  it('names people only by public handle or organisation', () => {
    expect(scrub({ text: 'Thanks to Jane Smith for the fix' }).findings.map((f) => f.type)).toContain('person_name');
    expect(scrub({ text: 'Dr. Okafor reviewed it' }).findings.map((f) => f.type)).toContain('person_name');
    expect(scrub({ text: 'Thanks to @janesmith and Saorsa Labs for the fix' }).ok).toBe(true);
    expect(scrub({ text: 'Carl Friedrich Gauss, Navier–Stokes and Euler are fine to cite' }).ok).toBe(true);
    expect(findPersonNames("same bug Chris O'Neil fixed").map((n) => n.name)).toEqual(["Chris O'Neil"]);
  });

  it('cleans imported public history instead of losing the lesson', () => {
    expect(redactPersonal('Reported by Jane Smith <jane@corp.io>, call +44 7700 900123, logs in /Users/jane/dev')).toBe('Reported by <person> <<email>>, call <phone>, logs in ~/dev');
    expect(redactPersonal('job 118835064165 at 2026-10-19 03:16 on v0.46.3; POST /home/seat')).toBe('job 118835064165 at 2026-10-19 03:16 on v0.46.3; POST /home/seat');
  });

  it('the seeder signs the cleaned text, never the personal details', async () => {
    const hub = new Hub({ signer: LocalSigner.generate(), preview: false });
    await new IssueSeeder(hub).seed({ issues: [{ repo: 'saorsa-labs/x0x', number: 1, title: 'Crash on start reported by Jane Smith', body: 'Jane Smith (jane@corp.io) saw a panic in /Users/jane/x0x.', url: 'https://github.com/saorsa-labs/x0x/issues/1' }], pulls: [] });
    const all = JSON.stringify(hub.node.store.all().map((s) => s.rec));
    expect(all).toMatch(/<person>/);
    expect(all).not.toMatch(/Jane Smith|jane@corp\.io|\/Users\/jane/);
  });

  it('a node refuses records from the network that carry personal data: not stored, served, archived or passed on', async () => {
    const hub = new Hub({ signer: LocalSigner.generate(), preview: false });
    const other = LocalSigner.generate(); // another node that ignored the rule
    const leaky = await signRecord({ kind: 'failure', context: { ...ctx, environment: 'x' }, body: { approach: 'deploy', outcome: 'error', error_summary: 'ask jane@corp.io, she knows', confidence: 0.5 } }, other);
    expect(hub.node.ingest(leaky, 'peer')).toBeNull();
    expect(hub.node.store.get(leaky.id)).toBeUndefined();
    expect(hub.node.rejected.at(-1)!.reason).toMatch(/personal data: email/);
    const clean = await signRecord({ kind: 'failure', context: { ...ctx, environment: 'x' }, body: { approach: 'deploy', outcome: 'error', error_summary: 'ask @jane, she knows', confidence: 0.5 } }, other);
    expect(hub.node.ingest(clean, 'peer')).not.toBeNull();
  });

  it('the app refuses a person’s record that names someone', async () => {
    const hub = new Hub({ signer: LocalSigner.generate(), preview: false });
    const web = new WebServer(hub); registerAppRoutes(web); await web.listen(0);
    try {
      const p = await hub.collective.propose((await import('../../src/work/launch.js')).leanLaunchProblem());
      const rec = await signRecord({ kind: 'message', context: ctx, body: { channel: 'problem', text: 'Michael Brown from my lab can check this' }, refs: [p.problem!.id] }, LocalSigner.generate());
      const r = await fetch(`${web.url}/api/records`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(rec) });
      expect(r.status).toBe(400);
      expect((await r.json()).findings.map((f: { type: string }) => f.type)).toContain('person_name');
    } finally { await web.close(); }
  });

  it('this repository carries no personal data either', () => {
    const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n')
      .filter((f) => f && !/\.(png|woff2|ico)$|package-lock\.json$/.test(f) && !['test/unit/scrub.test.ts', 'test/gates/privacy_rule.test.ts', 'src/privacy/names.ts'].includes(f)); // the detector's own tests and docs use fictional example names
    const found: string[] = [];
    for (const f of files) {
      const s = readFileSync(f, 'utf8');
      for (const n of findPersonNames(s)) found.push(`${f}: name "${n.name}"`);
      for (const m of s.matchAll(/\b[A-Za-z0-9._%+-]+@(?!(?:[\w-]+\.)*example\.)(?!users\.noreply\.github\.)[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g)) if (!/^no-?reply@/i.test(m[0])) found.push(`${f}: email ${m[0]}`);
      for (const m of s.matchAll(/(\/Users\/|\/home\/)(?!runner\b|user\b|ubuntu\b|root\b|seat\b|rename\b)[A-Za-z0-9._-]+/g)) found.push(`${f}: path ${m[0]}`);
    }
    expect(found).toEqual([]);
  });
});
