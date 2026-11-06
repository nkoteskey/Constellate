import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { Hub } from '../../src/hub/hub.js';
import { LocalSigner } from '../../src/core/identity.js';
import { IssueSeeder, IssueDump, closedBy, firstParagraph, issueSeedAllowed } from '../../src/seed/issues.js';
import { verifyRecord } from '../../src/core/record.js';

/**
 * Seeding from Saorsa Labs' public issues and merged pull requests
 * (owner-approved 2026-11-06). A closed issue is what went wrong; the merged
 * pull request that closed it is what fixed it. Every record links its source.
 */
describe('GATE 1 — seeding from public issue history', () => {
  it('allows only the approved public sources', () => {
    expect(issueSeedAllowed('saorsa-labs/x0x')).toBe(true);
    expect(issueSeedAllowed('saorsa-labs/ant-quic')).toBe(true);
    expect(issueSeedAllowed('nkoteskey/daylight')).toBe(true);
    expect(issueSeedAllowed('someone/else')).toBe(false);
    expect(issueSeedAllowed('saorsa-labs-fork/x0x')).toBe(false);
  });

  it('pairs issues with the pull requests that closed them, and cleans GitHub markdown', () => {
    expect(closedBy({ repo: 'saorsa-labs/x0x', number: 9, title: 'fix(ci): shrink debuginfo', url: 'u', body: 'Closes #1789 and #1790. Also fixes saorsa-labs/ant-quic#12' }))
      .toEqual([{ repo: 'saorsa-labs/x0x', number: 1789 }, { repo: 'saorsa-labs/x0x', number: 1790 }, { repo: 'saorsa-labs/ant-quic', number: 12 }]);
    const md = '## Summary\n\n- The Test Suite job dies with **exit 143** while compiling `x0x-test-harness`.\n\n```\nlog\n```\n\nCo-Authored-By: Claude <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_x';
    expect(firstParagraph(md)).toBe('The Test Suite job dies with exit 143 while compiling x0x-test-harness.');
  });

  it('turns a sample of the real harvest into linked, signed failures and fixes, with nothing private', async () => {
    const dump = JSON.parse(readFileSync(new URL('../../data/seed/saorsa-labs.json', import.meta.url), 'utf8')) as IssueDump;
    expect(dump.issues.length).toBeGreaterThan(700);
    expect(dump.pulls.length).toBeGreaterThan(1300);
    const outsider = { repo: 'someone/else', number: 1, title: 'crash on start', url: 'https://github.com/someone/else/issues/1' };
    const hub = new Hub({ signer: LocalSigner.generate(), preview: false });
    const rep = await new IssueSeeder(hub).seed({ issues: [outsider, ...dump.issues], pulls: dump.pulls }, { limit: 160 });
    expect(rep.denied).toEqual(['someone/else']);
    expect(rep.failures).toBeGreaterThan(40);
    expect(rep.answers).toBeGreaterThan(40);
    const all = hub.node.store.all();
    for (const s of all) {
      expect(verifyRecord(s.rec).ok).toBe(true);
      expect(s.rec.evidence.length).toBeGreaterThan(0);
      for (const u of s.rec.evidence) expect(u).toMatch(/^https:\/\/github\.com\/saorsa-labs\/[\w.-]+\/(issues|pull)\/\d+$/);
    }
    // Fixes are linked to the failures they fix.
    expect(all.filter((s) => s.rec.kind === 'answer' && s.rec.refs.length === 1).length).toBeGreaterThan(20);
    // Bot footers, session links and emails never enter a record.
    expect(JSON.stringify(all.map((s) => s.rec.body))).not.toMatch(/Co-Authored-By|claude\.ai\/code\/session|@anthropic\.com/);
    // And it's useful: a real CI failure comes back with its real fix.
    const r = hub.ledger.searchFailures('named_groups.json permissions shared_secret', { limit: 1 })[0];
    expect(r?.approach).toMatch(/named_groups\.json/);
  }, 120_000);
});
