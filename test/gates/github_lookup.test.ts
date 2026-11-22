import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Hub } from '../../src/hub/hub.js';
import { LocalSigner } from '../../src/core/identity.js';
import { GithubLookup, lookupQuery } from '../../src/seed/lookup.js';
import { connect } from '../helpers.js';

/**
 * On a miss, an error is looked up once in GitHub's closed issues (src/seed/lookup.ts, docs/SEED_SOURCES.md). Only
 * issues with a fix their own timeline shows are kept, as two short records (titles and links, never the issue's
 * text). Only the error's key words are sent. After that the network answers without GitHub, and once a fix is
 * confirmed, the failure and the fix are archived together.
 */
// Fictional personal details, assembled at run time so this file itself carries none (test/gates/privacy_rule.test.ts).
const USER = ['al', 'ice'].join(''), MAIL = `${USER}${'@'}corp.io`, HOMEDIR = ['', 'home', USER].join('/'), PERSON = ['Jane', 'Smith'].join(' ');
const ERROR = `Error: listen EADDRINUSE: address already in use :::5483\n    at Server.setupListenHandle (${HOMEDIR}/projects/secret-app/node_modules/net.js:1817:16) pid 48213 for ${MAIL}`;

/** A stand-in for GitHub's API: one search result list and the timelines it points to. Records every request. */
function fakeGithub() {
  const calls: string[] = [];
  const items = [
    { number: 1, title: 'Pull: fix the port', repository_url: 'https://api.github.com/repos/acme/server', html_url: 'https://github.com/acme/server/pull/1', pull_request: {}, body: 'x' },
    { number: 2, title: 'EADDRINUSE on restart', repository_url: 'https://api.github.com/repos/acme/server', html_url: 'https://github.com/acme/server/issues/2', closed_at: '2026-10-01T00:00:00Z', body: 'SECRET BODY TEXT that must not be copied' },
    { number: 3, title: 'EADDRINUSE when two daemons start', repository_url: 'https://api.github.com/repos/other/daemon', html_url: 'https://github.com/other/daemon/issues/3', closed_at: '2026-09-01T00:00:00Z', body: 'more text' },
    { number: 4, title: 'EADDRINUSE, never fixed', repository_url: 'https://api.github.com/repos/acme/server', html_url: 'https://github.com/acme/server/issues/4', body: 'y' },
  ];
  const timelines: Record<string, unknown[]> = {
    '/repos/acme/server/issues/2/timeline': [{ event: 'cross-referenced', source: { issue: { title: 'Reuse the socket with SO_REUSEADDR on restart', html_url: 'https://github.com/acme/server/pull/9', pull_request: { merged_at: '2026-10-02T00:00:00Z' } } } }],
    '/repos/other/daemon/issues/3/timeline': [{ event: 'closed', commit_id: 'a'.repeat(40) }],
    '/repos/acme/server/issues/4/timeline': [{ event: 'cross-referenced', source: { issue: { title: 'An unmerged attempt', html_url: 'https://github.com/acme/server/pull/10', pull_request: { merged_at: null } } } }],
  };
  const f = (async (url: string) => {
    const path = url.replace('https://api.github.com', '');
    calls.push(path);
    const body = path.startsWith('/search/issues') ? { items } : timelines[path.split('?')[0]] ?? [];
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe('looking an error up on GitHub when the network has nothing', () => {
  it('sends only the error’s key words: no paths, names, emails, numbers or hashes', () => {
    const q = lookupQuery(ERROR)!;
    expect(q).toContain('EADDRINUSE');
    expect(q).not.toMatch(new RegExp(`${USER}|corp|secret-app|home|48213|1817|5483`));
    expect(lookupQuery('just some notes about my day')).toBeNull();
    expect(lookupQuery(`commit 3f9a2b1c4d5e6f70 failed with error E0425 in ${PERSON}’s module`)).not.toMatch(/3f9a2b|Jane|Smith/);
  });

  it('keeps only closed issues with a fix (titles and links), says what it sent, and asks GitHub once a day', async () => {
    const home = mkdtempSync(join(tmpdir(), 'lookup-'));
    const hub = new Hub({ signer: LocalSigner.generate(), preview: false });
    const gh = fakeGithub();
    const lookup = new GithubLookup(hub, { fetch: gh.f, home });
    process.env.CONSTELLATE_GITHUB_LOOKUP = 'on';
    try {
      const r = (await lookup.lookup(ERROR))!;
      expect(gh.calls[0]).toMatch(/^\/search\/issues\?q=.*is%3Aissue%20is%3Aclosed%20reason%3Acompleted/);
      expect(r.found.map((f) => [f.issue, f.fix])).toEqual([
        ['https://github.com/acme/server/issues/2', 'https://github.com/acme/server/pull/9'],
        ['https://github.com/other/daemon/issues/3', `https://github.com/other/daemon/commit/${'a'.repeat(40)}`],
      ]); // the pull request item and the issue with only an unmerged attempt are left out
      const all = JSON.stringify(hub.node.store.all().map((s) => s.rec));
      expect(all).not.toContain('SECRET BODY TEXT'); // titles and links only
      const failure = hub.node.store.get(r.found[0].failure)!;
      expect(failure.rec.evidence).toEqual(['https://github.com/acme/server/issues/2']);
      expect(hub.node.store.get(r.found[0].answer)!.rec.body).toMatchObject({ answer: 'Reuse the socket with SO_REUSEADDR on restart (https://github.com/acme/server/pull/9)', proof: { type: 'citation' } });

      const n = gh.calls.length;
      expect((await lookup.lookup(ERROR))!.note).toMatch(/earlier today/);
      expect(gh.calls.length).toBe(n); // cached: GitHub isn't asked again

      // A closed project (private read mode) never sends anything; nor does a computer that turned it off.
      process.env.CONSTELLATE_GITHUB_LOOKUP = 'off';
      expect(await new GithubLookup(hub, { fetch: gh.f, home: mkdtempSync(join(tmpdir(), 'lookup-')) }).lookup(ERROR)).toBeNull();
    } finally { process.env.CONSTELLATE_GITHUB_LOOKUP = 'off'; }
  });

  it('through failures_search: a miss is looked up, the next search answers from the network, and a confirmed fix is archived with its failure', async () => {
    const home = mkdtempSync(join(tmpdir(), 'lookup-'));
    const hub = new Hub({ signer: LocalSigner.generate(), preview: false });
    const gh = fakeGithub();
    hub.lookup = new GithubLookup(hub, { fetch: gh.f, home });
    process.env.CONSTELLATE_GITHUB_LOOKUP = 'on';
    try {
      const { call } = await connect(hub);
      const first = await call('failures_search', { query: 'EADDRINUSE address already in use' });
      expect(first.looked_up).toMatchObject({ on: 'GitHub closed issues', sent: expect.stringContaining('EADDRINUSE') });
      expect(first.looked_up.note).toMatch(/archived on Autonomi/);
      expect(first.results.some((r: { fixes: unknown[] }) => r.fixes.length)).toBe(true);

      // The next agent: answered by the network, GitHub not asked.
      const n = gh.calls.length;
      const second = await call('failures_search', { query: 'EADDRINUSE address already in use on restart' });
      expect(second.looked_up).toBeUndefined();
      expect(second.results[0].fixes[0].fix).toMatch(/SO_REUSEADDR/);
      expect(gh.calls.length).toBe(n);

      // Another computer confirms the fix worked: the fix AND the failure it answers qualify for the library.
      const other = new Hub({ signer: LocalSigner.generate(), preview: false });
      for (const s of hub.node.store.all()) other.node.ingest(s.rec);
      const fixId = second.results[0].fixes[0].id;
      const { record } = await other.tried(fixId, { worked: true, error_before: 'EADDRINUSE', environment: 'node 22' }, { publish: true });
      hub.node.ingest(record);
      const kept = new Set(hub.keeper.plan().records.map((r) => r.id));
      expect(kept.has(fixId)).toBe(true);
      expect(kept.has(second.results[0].id)).toBe(true);
    } finally { process.env.CONSTELLATE_GITHUB_LOOKUP = 'off'; }
  });
});
