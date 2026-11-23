import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { Hub } from '../../src/hub/hub.js';
import { LocalSigner } from '../../src/core/identity.js';
import { signRecord } from '../../src/core/record.js';
import { WebServer } from '../../src/web/server.js';
import { registerAppRoutes } from '../../src/web/app.js';

/**
 * Improve a question instead of posting it again (src/collective/versions.ts, docs/VERSIONS.md). Records are
 * permanent, so a revision is a new version pointing at the last one: the author's become current, anyone else's
 * are suggested changes the author can adopt (credited). Asking it differently is a fork with its own votes,
 * linked both ways. Votes carry across versions; credit for the question shows on profiles.
 */
const ctx = { task: 'idea', domain: ['maths_physics'], environment: 'human (browser)' };
const idea = (title: string, extra: Record<string, unknown> = {}) => ({ title, goal: 'Find the smallest open case and settle it.', done: 'A checker anyone can run accepts it.', realm: 'maths_physics', check: 'machine (test or benchmark)', ...extra });

describe('revise and fork ideas', () => {
  it('versions, suggested changes, adoption with credit, framings linked both ways, and votes that carry across versions', async () => {
    const hub = new Hub({ signer: LocalSigner.generate(), preview: false });
    const web = new WebServer(hub); registerAppRoutes(web); await web.listen(0);
    const author = LocalSigner.generate(), other = LocalSigner.generate(), third = LocalSigner.generate();
    const send = async (s: LocalSigner, kind: 'proposal' | 'vote', body: Record<string, unknown>, refs: string[] = []) => {
      const rec = await signRecord({ kind, context: { ...ctx, task: String(body.title ?? 'vote') }, body, refs }, s);
      const r = await fetch(`${web.url}/api/records`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(rec) });
      return { id: rec.id, status: r.status, error: r.ok ? null : ((await r.json()) as { error: string }).error };
    };
    const ideas = async () => (await (await fetch(`${web.url}/api/ideas`)).json()) as { id: string; current: string; title: string; voters: number; versions: { status: string; note: string }[]; suggestions: { id: string; status: string; body?: { title: string } }[]; improved_by: string[]; framings: { id: string }[]; forked_from: { id: string } | null }[];
    try {
      const a = await send(author, 'proposal', idea('Hadamard orders'));
      await send(other, 'vote', { problem: a.id, support: true }, [a.id]);

      // The author's revision becomes current; the vote on the first version still counts.
      const a2 = await send(author, 'proposal', idea('The smallest open Hadamard orders', { revises: a.id, note: 'Narrowed to the smallest open orders' }), [a.id]);
      expect(a2.status).toBe(200);
      let [line] = await ideas();
      expect(line).toMatchObject({ id: a.id, current: a2.id, title: 'The smallest open Hadamard orders', voters: 1 });
      expect(line.versions.map((v) => v.status)).toEqual(['earlier', 'current']);

      // Someone else's revision is a suggestion; they can't adopt it themselves; the author adopts it, credited.
      const s = await send(other, 'proposal', idea('The smallest open Hadamard orders, from four circulant blocks', { revises: a2.id, note: 'Say which certificate counts' }), [a2.id]);
      [line] = await ideas();
      expect(line.current).toBe(a2.id);
      expect(line.suggestions.map((x) => [x.id, x.status])).toEqual([[s.id, 'suggested']]);
      expect((await send(other, 'proposal', idea('Mine now', { revises: a2.id, adopts: s.id, note: 'adopting' }), [a2.id])).error).toMatch(/only the idea’s author adopts/);
      const a3 = await send(author, 'proposal', { ...line.suggestions[0].body, revises: a2.id, adopts: s.id, note: 'Adopted a suggested change' }, [a2.id]);
      expect(a3.status).toBe(200);
      [line] = await ideas();
      expect(line).toMatchObject({ current: a3.id, title: 'The smallest open Hadamard orders, from four circulant blocks', improved_by: [other.agentId] });
      expect(line.suggestions[0].status).toBe('adopted');

      // Asking it differently: its own idea, linked both ways.
      const f = await send(third, 'proposal', idea('Which Hadamard orders can a home computer settle?', { forked_from: a3.id, note: 'Ask what is reachable, not what is open' }), [a3.id]);
      expect(f.status).toBe(200);
      const all = await ideas();
      expect(all).toHaveLength(2);
      expect(all.find((x) => x.id === a.id)!.framings.map((x) => x.id)).toEqual([f.id]);
      expect(all.find((x) => x.id === f.id)!.forked_from?.id).toBe(a.id);

      // Bad links are refused.
      expect((await send(author, 'proposal', idea('x', { revises: a3.id, note: 'n' }), [f.id])).error).toMatch(/revision points at an earlier version/);
      expect((await send(author, 'proposal', idea('x', { forked_from: 'f'.repeat(64), note: 'n' }), ['f'.repeat(64)])).status).toBe(400);
      expect((await send(author, 'proposal', idea('x', { revises: a3.id, forked_from: a3.id }), [a3.id])).error).toMatch(/not both/);

      // The planner and everything else read the current version.
      expect(hub.collective.versions.current(a.id)!.rec.id).toBe(a3.id);
      expect(hub.collective.versions.current(a2.id)!.rec.id).toBe(a3.id);

      // Credit for the question.
      expect(hub.collective.versions.questionCredit(author.agentId)).toEqual({ framed: 1, asked_differently_by_others: 1, changes_adopted: 0 });
      expect(hub.collective.versions.questionCredit(other.agentId)).toMatchObject({ changes_adopted: 1 });
      expect((await (await fetch(`${web.url}/api/me/${other.agentId}`)).json()).questions.changes_adopted).toBe(1);
    } finally { await web.close(); }
  });

  it('a live problem can be asked differently, by an agent or from its page, and lists every framing', async () => {
    const hub = new Hub({ signer: LocalSigner.generate(), preview: false });
    const base = { hook: 'x', goal: 'Answer exactly.', realm: 'maths_physics' as const, definition_of_done: { verifier: 'exact', description: 'Matches.' }, chunks: [{ key: 'a', title: 'A', prompt: 'What is 6 × 7?', check: { expected: '42' } }] };
    const p = (await hub.collective.propose({ title: 'Small facts', ...base })).problem!.id;
    const q = (await hub.collective.propose({ title: 'Small facts, asked as a proof', ...base, forked_from: p })).problem!.id;
    await expect(hub.collective.propose({ title: 'Nowhere', ...base, forked_from: 'a'.repeat(64) })).rejects.toThrow(/forked_from/);
    const web = new WebServer(hub); registerAppRoutes(web); await web.listen(0);
    const { chromium } = createRequire(import.meta.url)('playwright');
    const browser = await chromium.launch();
    try {
      const page0 = (await (await fetch(`${web.url}/api/problems/${p}/page`)).json()) as { framings: { id: string; kind: string }[] };
      expect(page0.framings.map((f) => [f.id, f.kind])).toEqual([[q, 'problem']]);
      expect(((await (await fetch(`${web.url}/api/problems/${q}/page`)).json()) as { forked_from: { id: string } }).forked_from.id).toBe(p);

      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      const errors: string[] = [];
      page.on('pageerror', (e: Error) => errors.push(String(e)));
      await page.goto(`${web.url}/#/p/${p}`);
      await page.waitForSelector('#framings');
      expect(await page.textContent('#framings')).toContain('Small facts, asked as a proof');
      await page.click('#ask-differently');
      await page.waitForSelector('#i-note');
      expect(await page.inputValue('#i-title')).toBe('Small facts');
      await page.fill('#i-title', 'Which small facts can a phone check?');
      await page.fill('#i-note', 'Ask what a phone can check');
      await page.click('#idea button.primary');
      await page.waitForSelector('[data-fork]');
      expect(await page.textContent('#ptab-body')).toMatch(/Which small facts can a phone check\?.*Asks differently: Small facts/s);
      expect(await page.textContent('#ptab-body')).toContain('Revise'); // this browser framed it, so it can revise it
      const page1 = (await (await fetch(`${web.url}/api/problems/${p}/page`)).json()) as { framings: { kind: string }[] };
      expect(page1.framings.map((f) => f.kind).sort()).toEqual(['idea', 'problem']);
      expect(errors).toEqual([]);
    } finally { await browser.close(); await web.close(); }
  }, 60_000);

  it('technology and infrastructure is a realm of its own: in the sky, the proposal form and the problem schema', async () => {
    const hub = new Hub({ signer: LocalSigner.generate(), preview: false });
    const p = await hub.collective.propose({ title: 'Faster gossip on home connections', hook: 'x', goal: 'Lower delivery time.', realm: 'tech_infrastructure', definition_of_done: { verifier: 'exact', description: 'Matches.' }, chunks: [{ key: 'a', title: 'A', prompt: 'p', check: { expected: '1' } }] });
    expect(p.problem).not.toBeNull();
    const web = new WebServer(hub); registerAppRoutes(web); await web.listen(0);
    try {
      const sky = (await (await fetch(`${web.url}/api/sky`)).json()) as { realms: { id: string; name: string }[] };
      expect(sky.realms.map((r) => r.id)).toContain('tech_infrastructure');
      expect(sky.realms.find((r) => r.id === 'tech_infrastructure')!.name).toBe('Technology and infrastructure');
    } finally { await web.close(); }
    expect(readFileSync(new URL('../../DESIGN.md', import.meta.url), 'utf8')).toContain('| Technology and infrastructure |');
  });

  it('is documented', () => {
    const doc = readFileSync(new URL('../../docs/VERSIONS.md', import.meta.url), 'utf8');
    for (const s of ['Revise', 'Suggest a change', 'Ask it differently', 'adopt', 'credit']) expect(doc).toContain(s);
  });
});
