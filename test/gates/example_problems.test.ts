import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Hub } from '../../src/hub/hub.js';
import { LocalSigner } from '../../src/core/identity.js';
import { seedOpenProblems } from '../../src/seed/open-problems.js';
import { EXAMPLE_PROBLEMS, FRONT_PAGE_TITLE } from '../../src/seed/example-problems.js';
import { VerifierRegistry } from '../../src/work/verifiers.js';
import { scrub } from '../../src/privacy/scrub.js';
import { WebServer } from '../../src/web/server.js';
import { registerAppRoutes } from '../../src/web/app.js';
import { schoolbook } from '../../src/work/structure-controls.js';

/**
 * Example problems (src/seed/example-problems.ts, docs/EXAMPLE_PROBLEMS.md): only problems with a built-in checker
 * are seeded. Each has a public source read on a stated date, every step's check is one its checker accepts, no
 * personal data anywhere, and they pass the constitution check. The front-page problem leads the home page.
 */
describe('example problems', () => {
  it('each uses a built-in checker, with valid checks, a dated source and no personal data', async () => {
    const reg = new VerifierRegistry();
    for (const p of EXAMPLE_PROBLEMS) {
      const v = reg.get(p.verifier);
      expect(v, p.title).toBeDefined();
      expect(v!.available).toBeUndefined(); // built in: no outside tool
      expect(p.source.read).toBe('2026-11-25');
      expect(p.source.says.length).toBeLessThanOrEqual(600);
      expect(p.hook.length, p.title).toBeLessThanOrEqual(140);
      expect(scrub(p, { level: 'standard' }).findings, p.title).toEqual([]);
      for (const c of p.chunks) {
        const r = await v!.check(c.check, '');
        expect(r.ok, `${p.title} / ${c.key}`).toBe(false);
        expect(r.detail, `${p.title} / ${c.key}: the check itself should be accepted`).not.toMatch(/the check needs|the check's|is one of|q must be|needs "poly"|not irreducible/);
      }
    }
    expect(new Set(EXAMPLE_PROBLEMS.map((p) => p.realm))).toEqual(new Set(['maths_physics', 'tech_infrastructure', 'philosophy_ethics']));
  });

  it('a known scheme passes the front page’s check format, and a record would be new', async () => {
    const front = EXAMPLE_PROBLEMS.find((p) => p.title === FRONT_PAGE_TITLE)!;
    const v = new VerifierRegistry().get('matmul_scheme')!;
    const step = front.chunks.find((c) => c.key === 'mm-4x4x4')!;
    expect((await v.check(step.check, JSON.stringify(schoolbook(4, 4, 4)))).detail).toMatch(/64 products; this step needs fewer than 48/);
  });

  it('are seeded once, pass the constitution check, and the front-page problem leads the home page', async () => {
    process.env.CONSTELLATE_HOME = mkdtempSync(join(tmpdir(), 'examples-'));
    const hub = new Hub({ signer: LocalSigner.generate(), preview: false });
    const ids = await seedOpenProblems(hub);
    const titles = hub.problems.list().map((p) => (p.rec.body as { title: string }).title);
    for (const p of EXAMPLE_PROBLEMS) expect(titles, p.title).toContain(p.title);
    for (const id of ids) expect(hub.collective.constitution.status(id).state).toBe('cleared');
    expect(await seedOpenProblems(hub)).toEqual([]);
    const front = hub.problems.list().find((p) => (p.rec.body as { title: string }).title === FRONT_PAGE_TITLE)!;
    expect(ids).toContain(front.rec.id);
    expect((front.rec.body as { obstacles?: unknown[] }).obstacles).toHaveLength(3);
    const web = new WebServer(hub); registerAppRoutes(web); await web.listen(0);
    try {
      const sky = await (await fetch(`${web.url}/api/sky`)).json();
      expect(sky.featured[0]).toBe(front.rec.id);
      const page = await (await fetch(`${web.url}/api/problems/${front.rec.id}/page`)).json();
      expect(page.obstacles.map((o: { from: string }) => o.from)).toEqual(['posted', 'posted', 'posted']);
    } finally { await web.close(); }
  });
});
