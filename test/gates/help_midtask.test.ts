import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Hub } from '../../src/hub/hub.js';
import { LocalSigner } from '../../src/core/identity.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { MemoryBoard } from '../../src/work/board.js';
import { watchHelpAnswers, helpFor, shownSkills } from '../../src/collab/help-notes.js';
import type { SignedRecord } from '../../src/core/record.js';

/**
 * Asking for help mid-task (docs/AGENT_STEPS.md "Help requests"): a help request reaches connected agents whose
 * shown skills match, once, in their next reply; they answer with answers_submit; the asker's computer checks the
 * answer by machine before accepting it. No money moves unless a payment rail is attached (off by default).
 */
const computer = () => new Hub({ signer: LocalSigner.generate(), preview: false });
const wait = async (ok: () => boolean, ms = 3000) => { for (let t = 0; t < ms && !ok(); t += 20) await new Promise((r) => setTimeout(r, 20)); return ok(); };

async function connect(hub: Hub, name = 'claude-code') {
  const server = createMcpServer(hub);
  const [x, y] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name, version: '1' });
  await Promise.all([server.connect(x), client.connect(y)]);
  const call = async (tool: string, args: Record<string, unknown>) => JSON.parse(((await client.callTool({ name: tool, arguments: args })).content as { text: string }[])[0].text);
  return { client, call };
}

async function world() {
  const asker = computer(), expert = computer(), stranger = computer();
  const all = [asker, expert, stranger];
  const spread = (r: SignedRecord) => { for (const h of all) h.node.ingest(r); };
  // The expert has shown it knows Rust linking; the stranger only knows Postgres.
  spread((await expert.ledger.submitAnswer({ task: 'link a cross build', domain: ['rust', 'linker'], environment: 'rust 1.90' }, { question: 'undefined reference when cross linking', answer: 'Use lld for the target.', proof: { type: 'test', detail: 'build links' } }, { publish: true })).record);
  spread((await stranger.ledger.reportFailure({ task: 'migrate', domain: ['postgres'], environment: 'pg 17' }, { approach: 'drop column first', outcome: 'wrong_result', error_summary: 'data lost' }, { publish: true })).record);
  const req = await asker.collab.askForHelp({ question: 'Which linker flag makes rustc use lld? Answer with the flag only.', needs: 'any', verifier: 'exact', check: { expected: 'link-arg=-fuse-ld=lld' }, bounty: 0 }, new MemoryBoard(), ['rust', 'linker']);
  spread(req);
  return { asker, expert, stranger, spread, req };
}

describe('asking for help mid-task', () => {
  it('reaches connected agents whose shown skills match, once, in their next reply', async () => {
    const { expert, stranger, req } = await world();
    expect(shownSkills(expert)).toEqual(new Set(['rust', 'linker']));
    expect(helpFor(stranger, shownSkills(stranger), new Set())).toBeNull();

    const e = await connect(expert);
    const first = await e.call('failures_search', { query: 'tokio runtime panics' });
    expect(first.help_wanted).toMatchObject({ request: req.id, topics: ['rust', 'linker'], checked_by: expect.stringMatching(/^exact \(by machine\)/) });
    expect(first.help_wanted.how).toContain(`fixes: ["${req.id}"]`);
    expect(first.help_wanted.bounty).toBeUndefined(); // no bounty offered, none mentioned
    expect((await e.call('failures_search', { query: 'tokio runtime panics' })).help_wanted).toBeUndefined(); // once

    const s = await connect(stranger);
    expect((await s.call('failures_search', { query: 'anything' })).help_wanted).toBeUndefined();
    // ...unless this session is working in those topics right now.
    expect((await s.call('answers_lookup', { question: 'cross compile', domain: ['Rust'] })).help_wanted?.request).toBe(req.id);
    await e.client.close(); await s.client.close();
  });

  it('answers still pass their check: a wrong one is rejected, the right one accepted, each judged once', async () => {
    const { asker, expert, stranger, spread, req } = await world();
    const stop = watchHelpAnswers(asker);
    try {
      const s = await connect(stranger), e = await connect(expert);
      const wrong = await s.call('answers_submit', { task: 'help', domain: ['rust'], environment: 'rust 1.90', question: 'lld flag', answer: '-C linker=lld', proof_type: 'test', proof_detail: 'guess', fixes: [req.id] });
      expect(wrong.published).toBe(true); // answers to help requests go out at once
      spread(stranger.node.store.get(wrong.id)!.rec);
      expect(await wait(() => asker.node.store.referencing(wrong.id, 'contradiction').length === 1)).toBe(true);
      const right = await e.call('answers_submit', { task: 'help', domain: ['rust'], environment: 'rust 1.90', question: 'lld flag', answer: '-C link-arg=-fuse-ld=lld', proof_type: 'test', proof_detail: 'links', fixes: [req.id] });
      spread(expert.node.store.get(right.id)!.rec);
      expect(await wait(() => asker.node.store.referencing(right.id, 'confirmation').length === 1)).toBe(true);
      // Checking again changes nothing: no second verdict on either answer.
      expect(await asker.collab.acceptHelp(req.id, asker.board)).toEqual({ accepted: right.id });
      expect(asker.node.store.referencing(wrong.id, 'contradiction')).toHaveLength(1);
      expect(asker.node.store.referencing(right.id, 'confirmation')).toHaveLength(1);
      // Answered: once the acceptance reaches other computers, it's no longer offered to anyone.
      for (const c of asker.node.store.referencing(right.id, 'confirmation')) spread(c.rec);
      expect(helpFor(stranger, new Set(['rust']), new Set())).toBeNull();
      expect(asker.economy).toBeUndefined(); // no payment rail: no money moved
      await s.client.close(); await e.client.close();
    } finally { stop(); }
  });
});
