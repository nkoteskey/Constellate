import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hub } from '../../src/hub/hub.js';
import { LocalSigner } from '../../src/core/identity.js';
import { LocalArchive } from '../../src/store/archive.js';
import { MemoryNetwork } from '../../src/transport/bus.js';
import { MemoryBoard } from '../../src/work/board.js';
import { MockRunner, Budget } from '../../src/contributor/models.js';
import { ModelRouter, cloudRunners } from '../../src/contributor/router.js';
import { KeyVault } from '../../src/contributor/keyvault.js';
import { TestnetLedger } from '../../src/economy/rail.js';
import { agentCard, requirePayment, submitPayment, settlePayment, A2A_X402_EXTENSION } from '../../src/economy/a2a.js';
import { Skills } from '../../src/economy/skills.js';

/** Amendment 1 §3 (protocols), §4 (supporting capabilities), §5 (models). */
function world() {
  const net = new MemoryNetwork();
  const archive = new LocalArchive();
  const mk = () => new Hub({ signer: LocalSigner.generate(), bus: net.bus(), archive, preview: false });
  return { mk };
}

describe('§3 protocols — A2A discovery and agent-to-agent x402', () => {
  it('extends the x0x A2A Agent Card with Constellate services, skills and the x402 extension', async () => {
    const { mk } = world();
    const hub = mk();
    await new Skills(hub).publish({ name: 'json-repair', description: 'Fix malformed JSON', capabilities: ['json'], price: 5000, instructions: 'Repair it.', tests: [{ input: '{', check: { expected: '{}' } }], verifier: 'exact' });
    const x0xCard = { name: 'alice-laptop', url: 'x0x://8a3f', skills: [{ id: 'kv.store', name: 'store' }], capabilities: { streaming: false }, x0xAgentId: '8a3f' };
    const card = agentCard(hub, x0xCard) as Record<string, any>;
    expect(card.x0xAgentId).toBe('8a3f'); // x0x's card is extended, not replaced
    expect(card.skills.map((s: { id: string }) => s.id)).toEqual(expect.arrayContaining(['kv.store', 'constellate.failures', 'constellate.answers', 'constellate.skills']));
    expect(card.skills.find((s: { name: string }) => s.name === 'json-repair')['x-price-micro-usdc']).toBe(5000);
    expect(card.capabilities.extensions[0].uri).toBe(A2A_X402_EXTENSION);
  });

  it('pays agent to agent over the a2a-x402 flow, with failures reported, never settled twice', async () => {
    const ledger = new TestnetLedger();
    const buyer = LocalSigner.generate(), seller = LocalSigner.generate();
    ledger.faucet(buyer.agentId, 10_000);
    const req = requirePayment('task-1', ledger.network, seller.agentId, 2_500, 'skill:json-repair', 'one run');
    expect(req.metadata['x402.payment.status']).toBe('payment-required');
    const sub = await submitPayment(req, buyer, 5_000);
    expect(sub.metadata['x402.payment.status']).toBe('payment-submitted');
    const done = await settlePayment(ledger, req, sub);
    expect(done.metadata['x402.payment.status']).toBe('payment-completed');
    expect(ledger.balance(seller.agentId)).toBe(2_500);
    expect((await settlePayment(ledger, req, sub)).metadata['x402.payment.error']).toMatch(/replay/);
    expect((await submitPayment(req, buyer, 100)).metadata['x402.payment.status']).toBe('payment-rejected');
    const wrongTask = { ...sub, taskId: 'task-2' };
    expect((await settlePayment(ledger, req, wrongTask)).metadata['x402.payment.status']).toBe('payment-failed');
  });
});

describe('§4 supporting capabilities', () => {
  it('verifiable hand-off: the next agent checks the note before trusting it', async () => {
    const { mk } = world();
    const a = mk(), b = mk();
    const { record: f } = await a.ledger.reportFailure({ task: 'migrate db', domain: ['postgres'], environment: 'pg 17' }, { approach: 'drop column first', outcome: 'wrong_result', error_summary: 'data lost' }, { publish: true });
    const { record: h } = await a.collab.handoff({ task: 'migrate db', tried: ['drop column first'], state: 'schema v2 drafted', next: 'backfill then drop', to: b.node.agentId }, [f.id], ['postgres']);
    expect(await b.collab.checkHandoff(h.id)).toMatchObject({ trusted: true, problems: [] });
    const { record: bare } = await a.collab.handoff({ task: 'x', tried: [], state: 's', next: 'n' }, ['f'.repeat(64)], ['x']);
    const r = await b.collab.checkHandoff(bare.id);
    expect(r.trusted).toBe(false);
    expect(r.problems[0]).toMatch(/not found/);
  });

  it('mid-task help through the Swarm returns a checkable answer; wrong answers are contradicted', async () => {
    const { mk } = world();
    const asker = mk(), wrong = mk(), right = mk();
    const board = new MemoryBoard();
    const req = await asker.collab.askForHelp({ question: 'What is 12 * 34?', needs: 'any', verifier: 'exact', check: { expected: '408' }, bounty: 0 }, board, ['maths']);
    expect(await wrong.collab.answerHelp(board, new MockRunner('m:w', 'llama', 'small', () => 'It is 406'))).not.toBeNull();
    expect(await right.collab.answerHelp(board, new MockRunner('m:r', 'qwen', 'small', () => '12*34 = 408'))).not.toBeNull(); // claims are advisory, so a second specialist can still answer
    const acc = await asker.collab.acceptHelp(req.id, board);
    const accepted = asker.node.store.get(acc.accepted!)!;
    expect((accepted.rec.body as { answer: string }).answer).toMatch(/408/);
    expect(asker.node.store.ofKind('contradiction')).toHaveLength(1);
    expect((await board.list())[0].state).toBe('done');
  });

  it('disagreement court: an independent third agent rules, reasoning kept, humans pulled in only when unsure', async () => {
    const { mk } = world();
    const a = mk(), b = mk(), judge = mk(), c = mk();
    const { record: ans } = await a.ledger.submitAnswer({ task: 'cache', domain: ['redis'], environment: 'redis 7' }, { question: 'Is SCAN safe in prod?', answer: 'Yes, with COUNT 100', proof: { type: 'benchmark', detail: 'p99 2ms' } }, { publish: true });
    const { record: con } = await b.contradict(ans.id, 'blocked our cluster', { environment: 'redis 6, 40M keys' }, { publish: true });
    expect(judge.collab.cases()).toEqual([[ans.id, con.id]]);
    const sure = await judge.collab.hear(ans.id, con.id, new MockRunner('m:j', 'mistral', 'large', () => 'BOTH\n0.8\nSafe on redis 7 at modest size; on redis 6 with 40M keys COUNT must be tuned.'));
    expect(sure!.rec.body).toMatchObject({ decision: 'both_conditional', needs_human: false, judge_family: 'mistral' });
    expect(judge.collab.cases()).toEqual([]);
    await expect(a.collab.hear(ans.id, con.id, new MockRunner('m', 'x', 'large', () => 'FIRST\n1'))).rejects.toThrow(/independent/);
    const { record: con2 } = await judge.contradict(ans.id, 'also slow', { environment: 'redis 7' }, { publish: true });
    const unsure = await c.collab.hear(ans.id, con2.id, new MockRunner('m:j2', 'qwen', 'large', () => 'UNDECIDED\n0.3\nNot enough evidence.'));
    expect((unsure!.rec.body as { needs_human: boolean }).needs_human).toBe(true);
  });

  it('huddle view shows who teamed up, hand-offs, and each signed step', async () => {
    const { mk } = world();
    const a = mk(), b = mk();
    const { record: p } = await a.problems.propose({ title: 'T', goal: 'g', realm: 'maths_physics', definition_of_done: { verifier: 'exact', description: 'd' }, chunks: [{ key: 'k', title: 'k', prompt: 'p', check: { expected: '1' } }] }, { publish: true });
    await a.node.submit({ kind: 'task_result', context: { task: 't', domain: ['maths_physics'], environment: 'm:llama' }, body: { problem: p.id, chunk: 'k', output: '1', model: 'm:llama', family: 'llama' }, refs: [p.id] }, { publish: true });
    await a.collab.handoff({ task: 'T', tried: ['k'], state: 'one result', next: 'verify k', to: b.node.agentId }, [p.id], ['maths_physics']);
    const h = b.collab.huddle(p.id);
    expect(h.agents).toHaveLength(1);
    expect(h.handoffs[0].to).toBe(b.node.agentId);
    expect(h.steps.length).toBe(2);
  });
});

describe('§5 models — mixing local and cloud', () => {
  it('routes to the cheapest model that fits, honours family exclusions and per-model caps, and reports spend', async () => {
    const local = new MockRunner('mlx:qwen3-14b', 'qwen', 'small', () => 'l');
    const claude = new MockRunner('anthropic:claude-opus-5-5', 'claude', 'large', () => 'c', 3);
    const gemini = new MockRunner('google:gemini', 'gemini', 'large', () => 'g', 2);
    const router = new ModelRouter([local, claude, gemini], new Budget(9), { 'google:gemini': 4 });
    expect(router.pick({ size: 'small' })!.id).toBe('mlx:qwen3-14b');
    expect(router.pick({ size: 'large' })!.id).toBe('google:gemini');
    await router.run({ size: 'large' }, 'x'); await router.run({ size: 'large' }, 'x');
    expect(router.pick({ size: 'large' })!.id).toBe('anthropic:claude-opus-5-5'); // gemini hit its own cap
    expect(router.pick({ size: 'large', notFamily: 'claude' })).toBeNull();
    await router.run({ size: 'large' }, 'x'); // claude: 4 + 3 = 7 of 9 spent
    expect(router.pick({ size: 'large' })).toBeNull(); // another claude run (3) would pass the overall cap of 9
    expect(router.pick({ size: 'small' })!.id).toBe('mlx:qwen3-14b'); // local models stay free

    expect(router.spend().models.find((m) => m.id === 'google:gemini')).toMatchObject({ spent_cents: 4, cap_cents: 4 });
  });

  it('cloud keys come from the encrypted device vault only', () => {
    const v = new KeyVault(join(mkdtempSync(join(tmpdir(), 'v-')), 'keys.json'));
    expect(cloudRunners(v)).toHaveLength(0);
    v.set('anthropic', 'sk-ant-x'); v.set('gemini', 'g'); v.set('openai', 'o');
    expect(cloudRunners(v).map((r) => r.family).sort()).toEqual(['claude', 'gemini', 'openai']);
  });
});
