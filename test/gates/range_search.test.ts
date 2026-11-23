import { describe, it, expect } from 'vitest';
import { Hub } from '../../src/hub/hub.js';
import { LocalSigner } from '../../src/core/identity.js';
import { MockRunner } from '../../src/contributor/models.js';
import { Worker } from '../../src/work/worker.js';
import { MemoryBoard } from '../../src/work/board.js';
import { ramseyCirculant, searchRange, vdwPeriodic, type SearchSpec } from '../../src/work/range-search.js';
import { vdwColoringVerifier, ramseyGraphVerifier } from '../../src/work/combinatorics.js';

/**
 * Lent computers search for witnesses, honestly (#32): a search split into ranges, each tried by a stated method,
 * with per-block fingerprints only real work produces. Another identity spot-checks a sample; an honest empty range
 * is credited, a skipped one is caught and searched again, and a find is checked like any answer.
 */
const sync = (...hubs: Hub[]) => { for (const a of hubs) for (const b of hubs) if (a !== b) for (const s of a.node.store.all()) if (s.visibility === 'public') b.node.ingest(s.rec); };
const problem = (n: number, spec: SearchSpec) => ({ title: `Colour 1..${n}`, goal: 'Find a colouring with no one-colour 3-term progression.', realm: 'maths_physics' as const, definition_of_done: { verifier: 'vdw_coloring', description: 'no one-colour progression' }, chunks: [{ key: 'w', title: `W(2,3) > ${n}`, prompt: 'search', check: { colors: 2, k: 3, n, search: spec } }] });
const worker = (h: Hub, family: string) => new Worker(h, new MockRunner(`mock:${family}`, family, 'small', () => 'unused'), h.problems, new MemoryBoard());

describe('searching for witnesses on lent computers', () => {
  it('the kernels find real witnesses, and every witness passes the problem’s own check', async () => {
    const hit = searchRange({ kernel: 'vdw_periodic', range_size: 256, block_size: 32, params: { period: 8, n: 8, k: 3 } }, 0).found!;
    expect((await vdwColoringVerifier.check({ colors: 2, k: 3, n: 8 }, hit)).ok).toBe(true);
    expect(searchRange({ kernel: 'vdw_periodic', range_size: 512, block_size: 64, params: { period: 9, n: 9, k: 3 } }, 0).found).toBeUndefined(); // W(2,3) = 9
    expect(vdwPeriodic.total({ period: 9 })).toBe(512);
    // The 5-cycle is circulant: a graph on 5 vertices with no triangle and no independent 3-set.
    const g = searchRange({ kernel: 'ramsey_circulant', range_size: 4, block_size: 2, params: { n: 5, s: 3, t: 3 } }, 0).found!;
    expect((await ramseyGraphVerifier.check({ s: 3, t: 3, n: 5 }, g)).ok).toBe(true);
    expect(ramseyCirculant.total({ n: 17 })).toBe(256);
  });

  it('an honest empty range is credited after a spot check; a skipped one is caught and searched again', async () => {
    const proposer = new Hub({ signer: LocalSigner.generate(), preview: false });
    const honest = new Hub({ signer: LocalSigner.generate(), preview: false });
    const lazy = new Hub({ signer: LocalSigner.generate(), preview: false });
    const checker = new Hub({ signer: LocalSigner.generate(), preview: false });
    const spec: SearchSpec = { kernel: 'vdw_periodic', range_size: 128, block_size: 32, params: { period: 9, n: 9, k: 3 } }; // 4 ranges, none has a witness
    const p = (await proposer.problems.propose(problem(9, spec), { publish: true })).record.id;
    sync(proposer, honest, lazy, checker);

    expect(await worker(honest, 'qwen').step(p)).toBe('searched'); // range 0
    sync(honest, lazy, checker);
    // A lazy computer claims range 1 but skips every block.
    await lazy.ranges.search(p, 'w', spec, 1, { skipBlocks: new Set([0, 1, 2, 3]) });
    sync(lazy, honest, checker);

    const w = worker(checker, 'llama');
    expect(await w.step(p)).toBe('spot_checked');
    expect(await w.step(p)).toBe('spot_checked');
    sync(checker, honest, lazy, proposer);
    const [hon] = checker.node.store.ofKind('range_report' as never).filter((r) => r.operatorId === honest.node.operatorId);
    const [laz] = checker.node.store.ofKind('range_report' as never).filter((r) => r.operatorId === lazy.node.operatorId);
    expect(checker.ranges.standing(hon)).toBe('credited');
    expect(checker.ranges.standing(laz)).toBe('struck');
    expect(proposer.ranges.credited(honest.node.operatorId)).toBe(128); // an honest empty range earns credit
    expect(proposer.ranges.credited(lazy.node.operatorId)).toBe(0);
    expect(proposer.collective.searched(honest.node.operatorId)).toBeGreaterThan(0);
    expect(proposer.ranges.nextRange(p, 'w', spec)).toBe(1); // the skipped range is open again
    expect(proposer.ranges.coverage(p, 'w', spec)).toMatchObject({ credited: 1, struck: 1, ranges: 4 });
    await expect(honest.ranges.spotCheck(hon.rec.id, spec)).rejects.toThrow(/someone else/);
  });

  it('a find becomes an ordinary answer, checked by another computer before it counts', async () => {
    const proposer = new Hub({ signer: LocalSigner.generate(), preview: false });
    const searcher = new Hub({ signer: LocalSigner.generate(), preview: false });
    const checker = new Hub({ signer: LocalSigner.generate(), preview: false });
    const spec: SearchSpec = { kernel: 'vdw_periodic', range_size: 256, block_size: 32, params: { period: 8, n: 8, k: 3 } };
    const p = (await proposer.problems.propose(problem(8, spec), { publish: true })).record.id;
    sync(proposer, searcher, checker);
    expect(await worker(searcher, 'qwen').step(p)).toBe('searched');
    sync(searcher, checker);
    expect(checker.node.store.ofKind('task_result').map((r) => (r.rec.body as { model: string }).model)).toEqual(['machine search (vdw_periodic)']);
    expect(await worker(checker, 'llama').step(p)).toBe('verified');
    expect((await checker.problems.state(p)).done).toBe(1);
  });
});
