import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hub } from '../../src/hub/hub.js';
import { LocalSigner } from '../../src/core/identity.js';
import { PaperSeeder, PaperLessons, PAPER_SOURCES } from '../../src/seed/papers.js';
import { findPersonNames } from '../../src/privacy/names.js';

/**
 * Research memory (docs/RESEARCH_AGENTS.md): negative results and findings from public AI-generated papers,
 * each linked to its paper, labelled self-reported and not independently reproduced, from allowed sources only,
 * and findable by an agent before it repeats the experiment.
 */
const data = JSON.parse(readFileSync(join(import.meta.dirname, '../../data/seed/scientist-two.json'), 'utf8')) as PaperLessons[];
const one: PaperLessons = {
  paper: 'test', title: 'Contiguous masking for protein encoders', url: `${PAPER_SOURCES[0].prefix}applications/Test.pdf`, tags: ['protein-structure', 'Self Supervised'],
  summary: 'A test paper.',
  lessons: [
    { kind: 'failure', approach: 'Holonomy-targeted masking instead of contiguous masking', outcome: 'wrong_result', error_summary: 'Reports no gain over contiguous masking (top-1 within 0.3).', applies_when: '38M-parameter encoder, 370k structures' },
    { kind: 'answer', question: 'How to pretrain a protein structure encoder for fold classification?', answer: 'Supervise curvature 2-forms instead of coordinates. Reports +2.4 top-1 in distribution.' },
  ],
};

describe('research memory from published papers', () => {
  it('the data file is the reviewed ScientistTwo corpus: allowed sources only, no personal names, nothing overclaimed', () => {
    expect(data.length).toBeGreaterThanOrEqual(80);
    expect(data.reduce((n, p) => n + p.lessons.filter((l) => l.kind === 'failure').length, 0)).toBeGreaterThan(250);
    for (const p of data) {
      expect(PAPER_SOURCES.some((s) => p.url.startsWith(s.prefix)), p.paper).toBe(true);
      const text = JSON.stringify({ ...p, url: '' });
      expect(findPersonNames(text).map((n) => n.name), p.paper).toEqual([]);
      expect(text, p.paper).not.toMatch(/\bproved\b|conclusively|@[a-z0-9-]+\.[a-z]{2,}/i);
    }
  });

  it('seeds failures and findings an agent can find, linked and honestly labelled, once', async () => {
    const hub = new Hub({ signer: LocalSigner.generate(), preview: false });
    const r = await new PaperSeeder(hub).seed([one, { ...one, paper: 'elsewhere', url: 'https://example.org/paper.pdf' }]);
    expect(r).toMatchObject({ papers: 1, failures: 1, answers: 1 });
    expect(r.skipped).toEqual([{ paper: 'elsewhere', reason: 'not from an allowed source' }]);
    const found = hub.ledger.searchFailures('holonomy masking protein encoder')[0];
    expect(found).toMatchObject({ approach: one.lessons[0].approach, environment: expect.stringMatching(/AI-generated paper, self-reported, not independently reproduced/) });
    expect(hub.node.store.get(found.id)!.rec.evidence).toEqual([one.url]);
    expect(hub.node.store.get(found.id)!.rec.context.domain).toEqual(['research', 'protein-structure', 'self-supervised']);
    const ans = hub.ledger.lookupAnswers('pretrain protein structure encoder fold classification')[0];
    expect(ans).toMatchObject({ headline: 'Supervise curvature 2-forms instead of coordinates.', proof: { type: 'citation', detail: expect.stringMatching(/not independently reproduced/) } });
    expect(ans.fixes).toEqual([found.id]); // the failed variant sits next to the one that worked
    expect((await new PaperSeeder(hub).seed([one])).skipped).toEqual([{ paper: 'test', reason: 'already seeded' }]);
  });
});
