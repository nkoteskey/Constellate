import { describe, it, expect } from 'vitest';
import { connect, network } from '../helpers.js';
import { Hub } from '../../src/hub/hub.js';
import { LocalSigner } from '../../src/core/identity.js';
import { SERVER_INSTRUCTIONS } from '../../src/mcp/server.js';

/**
 * GATE 1: test agents check the ledger before acting, without being told to.
 * The behavioural half needs a real model: `evals/gate1.ts` (READY FOR HUMAN TESTING,
 * needs ANTHROPIC_API_KEY). This file proves the preconditions that make an agent
 * choose to look: the storefront, cost and speed of a lookup, and the data being there.
 */
describe('GATE 1 — shared memory', () => {
  it('failure reported on one machine is found by another, with the answer that fixed it', async () => {
    const { hubs: [a, b] } = network(2);
    const f = await a.ledger.reportFailure(
      { task: 'Compile tokio app for wasm32-unknown-unknown', domain: ['rust', 'wasm'], environment: 'tokio 1.38, rustc 1.95' },
      { approach: 'cargo build --target wasm32-unknown-unknown with tokio full features', outcome: 'error', error_summary: 'mio does not support wasm32: unresolved import' });
    await a.ledger.submitAnswer(
      { task: 'Compile tokio app for wasm32', domain: ['rust', 'wasm'], environment: 'tokio 1.38, rustc 1.95' },
      { question: 'How to use tokio on wasm32-unknown-unknown?', answer: 'Use tokio with only the rt, sync and macros features (no net/fs), or wasm-bindgen-futures for the executor.', proof: { type: 'test', detail: 'cargo build --target wasm32-unknown-unknown passes with features = ["rt","sync","macros"]' } },
      { fixes: [f.record.id] });
    const { call } = await connect(b);
    const s = await call('failures_search', { query: 'tokio wasm32 build error mio', environment: 'rustc 1.95 tokio 1.38' });
    expect(s.results[0].id).toBe(f.record.id);
    expect(s.results[0].fixed_by).toHaveLength(1);
    const ans = await call('answers_lookup', { question: 'tokio on wasm32?' });
    expect(ans.results[0].answer).toMatch(/wasm-bindgen-futures/);
  });

  it('every tool says what it does, when to use it, and what it costs, in at most three sentences', async () => {
    const hub = new Hub({ signer: LocalSigner.generate() });
    const { client } = await connect(hub);
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThanOrEqual(8);
    for (const t of tools) {
      const sentences = t.description!.split(/(?<=[.!?])\s+/).filter(Boolean);
      expect(sentences.length, t.name).toBeLessThanOrEqual(3);
      expect(t.name, 'no dots in tool names').toMatch(/^[a-z0-9_]+$/);
    }
    const lookups = tools.filter((t) => ['failures_search', 'answers_lookup'].includes(t.name));
    for (const t of lookups) expect(t.description).toMatch(/Free/);
    expect(tools.find((t) => t.name === 'failures_search')!.description).toMatch(/before|error|dead end/);
    expect(SERVER_INSTRUCTIONS).toMatch(/[Bb]efore you spend effort/);
  });

  it('lookups stay small and fast at 2,000 records', async () => {
    const hub = new Hub({ signer: LocalSigner.generate(), preview: false });
    const s = LocalSigner.generate();
    const { signRecord } = await import('../../src/core/record.js');
    const libs = ['serde', 'tokio', 'axum', 'react', 'numpy', 'pandas', 'torch', 'lean', 'mathlib', 'docker'];
    for (let i = 0; i < 2000; i++) {
      const lib = libs[i % libs.length];
      hub.node.store.add(await signRecord({ kind: 'failure', context: { task: `upgrade ${lib} to v${i % 7}`, domain: [lib], environment: `${lib} ${i % 7}.0` }, body: { approach: `bump ${lib} version ${i}`, outcome: 'error', error_summary: `breaking change in ${lib} api number ${i}`, confidence: 0.6 } }, s));
    }
    const t0 = performance.now();
    const r = hub.ledger.searchFailures('upgrade torch breaking change', { environment: 'torch 3.0' });
    const ms = performance.now() - t0;
    expect(r.length).toBe(5);
    expect(JSON.stringify(r).length).toBeLessThan(4096);
    expect(ms).toBeLessThan(1500);
  }, 120_000);

  it('a late joiner catches up from archive pointers without gossip replay', async () => {
    const { hubs: [a], archive } = network(1);
    await a.ledger.reportFailure({ task: 'Run mathlib build', domain: ['lean'], environment: 'lean 4.20' }, { approach: 'lake build without cache', outcome: 'too_slow', error_summary: 'took 3 hours on 8 cores' });
    await a.live.checkpoint();
    const late = new Hub({ signer: LocalSigner.generate(), archive });
    expect(late.node.store.size).toBe(0);
    expect(await late.live.catchUp(a.node.agentId)).toEqual({ fetched: 1, rejected: 0 });
    expect(late.ledger.searchFailures('mathlib build slow')[0].outcome).toBe('too_slow');
  });

  it('preview mode: writes stay private until published', async () => {
    const { hubs: [a, b] } = network(2, { preview: true });
    const { call } = await connect(a);
    const r = await call('failures_report', { task: 'pip install torch', domain: ['python'], environment: 'python 3.13', approach: 'pip install torch==2.1', outcome: 'error', error_summary: 'no wheel for python 3.13' });
    expect(r.published).toBe(false);
    expect(b.node.store.size).toBe(0);
    const prev = await call('hub_previews');
    expect(prev[0].body.error_summary).toBe('no wheel for python 3.13');
    await call('hub_publish', { preview_id: r.preview_id });
    expect(b.node.store.size).toBe(1);
  });

  it('privacy block is explained to the agent, not silently dropped', async () => {
    const { hubs: [a] } = network(1);
    const { call } = await connect(a);
    const r = await call('failures_report', { task: 'deploy', domain: ['ops'], environment: 'x', approach: 'used token ghp_abcdefghijklmnopqrstuvwxyz0123456789', outcome: 'error', error_summary: 'denied' });
    expect(r.isError).toBe(true);
    expect(r.blocked).toBe('privacy');
    expect(r.findings[0].type).toBe('github_token');
  });
});
