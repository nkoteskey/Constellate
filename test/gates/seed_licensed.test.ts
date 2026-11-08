import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hub } from '../../src/hub/hub.js';
import { LocalSigner } from '../../src/core/identity.js';
import { seedTldr, type TldrPage } from '../../src/seed/tldr.js';
import { ISSUE_SEED_PROPOSED, issueSeedAllowed } from '../../src/seed/issues.js';
import { personalDataCheck } from '../../src/privacy/scrub.js';

/**
 * More open failure data, licensed (docs/SEED_SOURCES.md): tldr-pages command usage (CC BY 4.0) with the licence
 * on every record and in data/seed/LICENSES; the CI-history extension proposed but not active until the owner
 * approves; sources with unclear licences listed, not imported.
 */
const root = join(import.meta.dirname, '../..');
const file = JSON.parse(readFileSync(join(root, 'data/seed/tldr-pages.json'), 'utf8')) as { commit: string; license: string; pages: TldrPage[]; left_out: { command: string; reason: string }[] };

describe('licensed open data', () => {
  it('tldr-pages: every record carries the licence, attribution and a source pinned to a commit, and passes the privacy check', async () => {
    expect(file.license).toBe('CC-BY-4.0');
    expect(file.pages.length).toBeGreaterThan(100);
    const hub = new Hub({ signer: LocalSigner.generate(), preview: false }); // as the starter library is built (desktop/scripts/starter.mjs)
    const r = await seedTldr(hub, file);
    expect(r.skipped).toEqual([]);
    expect(r.added).toBe(file.pages.length);
    for (const s of hub.node.store.ofKind('answer')) {
      const b = s.rec.body as { license: string; attribution: string; source: string; notice: string; proof: { detail: string } };
      expect(b.license).toBe('CC-BY-4.0');
      expect(b.attribution).toBe('tldr-pages team and contributors');
      expect(b.source).toMatch(new RegExp(`^https://github.com/tldr-pages/tldr/blob/${file.commit}/pages/`));
      expect(s.rec.evidence).toEqual([b.source]);
      expect(b.proof.detail).toContain('CC BY 4.0');
      expect(b.notice).toMatch(/placeholders/);
      expect(s.rec.context.environment).toMatch(/CC BY 4\.0/);
      expect(personalDataCheck(s.rec).ok).toBe(true);
    }
    expect((await seedTldr(hub, file)).added).toBe(0); // seeding twice adds nothing
    // Agents see the licence on what they look up.
    const top = hub.ledger.lookupAnswers('extract a tar.gz archive into a directory')[0];
    expect(top).toMatchObject({ license: 'CC-BY-4.0', attribution: 'tldr-pages team and contributors' });
  });

  it('refuses anything not from tldr-pages under CC BY 4.0 at a pinned commit', async () => {
    const hub = new Hub({ signer: LocalSigner.generate(), preview: false });
    const p = file.pages[0];
    const r = await seedTldr(hub, { pages: [{ ...p, license: 'CC-BY-SA-4.0' }, { ...p, source: { ...p.source, commit: 'main' } }, { ...p, source: { ...p.source, repo: 'someone/fork' } }] });
    expect(r.added).toBe(0);
    expect(r.skipped).toHaveLength(3);
  });

  it('the licence text and notice ship with the package; left-out pages are listed', () => {
    expect(readFileSync(join(root, 'data/seed/LICENSES/CC-BY-4.0.txt'), 'utf8')).toMatch(/^Attribution 4\.0 International/);
    const notice = readFileSync(join(root, 'data/seed/LICENSES/NOTICE.md'), 'utf8');
    expect(notice).toContain('tldr-pages');
    expect(notice).toContain(file.commit);
    expect(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).files).toContain('data/seed/LICENSES');
    expect(file.left_out.map((l) => l.command)).toEqual(expect.arrayContaining(['git-config', 'redis-cli']));
  });

  it('public CI history from other projects is proposed, not active, until the owner approves', () => {
    expect(ISSUE_SEED_PROPOSED.length).toBeGreaterThan(5);
    for (const p of ISSUE_SEED_PROPOSED) expect(issueSeedAllowed(p.repo), p.repo).toBe(false);
    const doc = readFileSync(join(root, 'docs/SEED_SOURCES.md'), 'utf8');
    for (const p of ISSUE_SEED_PROPOSED) expect(doc).toContain(p.repo);
    expect(doc).toMatch(/Left out: licence unclear/);
  });
});
