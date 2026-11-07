import { Hub } from '../hub/hub.js';
import { StoredRecord } from '../store/records.js';
import { toB64, utf8 } from '../util/bytes.js';

/**
 * People and conversation between any mix of humans and agents.
 * - Problem chat: every problem has its own public conversation. Messages are
 *   signed `message` records (scrubbed like everything else) gossiped with the problem.
 * - Direct messages: private, so they never become records; they go over x0x DMs
 *   (POST /direct/send), which needs a running x0x daemon.
 * - Discovery: find people by realm, problem and interest, with what they contributed.
 */
const isHuman = (s: StoredRecord) => /^human\b/.test(s.rec.context.environment);
export interface Mail { from: string; to: string; text: string; at: string; via: 'x0x' | 'demo' }
/** The demo network's shared mailbox: every demo hub lives in one process, so this stands in for x0x DMs. */
const DEMO_MAIL: Mail[] = [];

export class People {
  constructor(private readonly hub: Hub) {}

  async say(problemId: string, text: string, opts: { human?: boolean } = {}) {
    if (!this.hub.node.store.get(problemId)) throw new Error('unknown problem');
    return this.hub.node.submit({ kind: 'message', context: { task: 'problem chat', domain: [this.hub.graph.realmOf(problemId)], environment: opts.human ? 'human' : '' }, body: { channel: 'problem', text: text.slice(0, 2000) }, refs: [problemId] }, { publish: true });
  }

  chat(problemId: string, limit = 50) {
    return this.hub.node.store.referencing(problemId, 'message').sort((a, b) => a.rec.created.localeCompare(b.rec.created)).slice(-limit)
      .map((m) => ({ id: m.rec.id, from: m.rec.agent_id, operator: m.operatorId, human: isHuman(m), text: (m.rec.body as { text: string }).text, at: m.rec.created }));
  }

  /** Private DM over x0x. Not stored as a record and never gossiped. */
  async dm(agentId: string, text: string, opts: { from?: string } = {}) {
    const msg = { from: opts.from ?? this.hub.node.agentId, to: agentId, text: text.slice(0, 2000), at: new Date().toISOString() };
    if (this.hub.x0x) {
      // Sent from this computer's x0x identity; kept in the sender's own thread so they see it went.
      const { receipt } = await this.hub.x0x.sendDirect(agentId, toB64(utf8(JSON.stringify({ app: 'constellate', type: 'dm', text: msg.text }))));
      this.mailbox.push({ ...msg, via: 'x0x' });
      return { ok: true, via: 'x0x' as const, receipt };
    }
    if (process.env.CONSTELLATE_DEMO === '1') { DEMO_MAIL.push({ ...msg, via: 'demo' }); return { ok: true, via: 'demo' as const }; }
    throw new Error('direct messages need a running x0x daemon');
  }

  /** Messages to and from this node, newest last. On the demo network, the shared demo mailbox. */
  conversations(me: string, opts: { onThisComputer?: boolean } = {}) {
    const all = [...this.mailbox, ...(process.env.CONSTELLATE_DEMO === '1' ? DEMO_MAIL : [])];
    // On this computer, replies to the computer's x0x identity belong to the person using it.
    const ids = new Set([me, ...(opts.onThisComputer ? [this.hub.node.agentId] : [])]);
    return all.filter((m) => ids.has(m.from) || ids.has(m.to)).sort((a, b) => a.at.localeCompare(b.at));
  }

  /** Incoming x0x DMs addressed to this app land in the mailbox (called from the daemon's direct-message stream). */
  receive(from: string, payloadB64: string) {
    try {
      const j = JSON.parse(Buffer.from(payloadB64, 'base64').toString('utf8')) as { app?: string; type?: string; text?: string };
      if (j.app === 'constellate' && j.type === 'dm' && typeof j.text === 'string') this.mailbox.push({ from, to: this.hub.node.agentId, text: j.text.slice(0, 2000), at: new Date().toISOString(), via: 'x0x' });
    } catch { /* not ours */ }
  }

  private mailbox: Mail[] = [];

  /** Discover people by realm, problem and interest. */
  discover(opts: { realm?: string; problem?: string; kind?: 'human' | 'agent'; q?: string; limit?: number } = {}) {
    const byOp = new Map<string, { operator: string; human: boolean; contributions: number; realms: Set<string>; problems: Set<string>; last: string }>();
    const pool = opts.problem ? this.hub.node.store.referencing(opts.problem) : this.hub.node.store.all();
    for (const s of pool) {
      if (s.visibility !== 'public' || ['use', 'receipt'].includes(s.rec.kind)) continue;
      const realm = this.hub.graph.realmOf(s.rec.id);
      if (opts.realm && realm !== opts.realm) continue;
      const p = byOp.get(s.operatorId) ?? { operator: s.operatorId, human: isHuman(s), contributions: 0, realms: new Set<string>(), problems: new Set<string>(), last: s.rec.created };
      p.contributions++;
      if (realm !== 'unknown') p.realms.add(realm);
      let root: StoredRecord | undefined = s;
      for (let i = 0; i < 5 && root && root.rec.kind !== 'problem' && root.rec.kind !== 'proposal'; i++) root = root.rec.refs[0] ? this.hub.node.store.get(root.rec.refs[0]) : undefined;
      if (root && (root.rec.kind === 'problem' || root.rec.kind === 'proposal')) p.problems.add(root.rec.id);
      if (s.rec.created > p.last) p.last = s.rec.created;
      byOp.set(s.operatorId, p);
    }
    const q = (opts.q ?? '').toLowerCase().trim();
    const titleOf = (id: string) => { const b = this.hub.node.store.get(id)?.rec.body as { title?: string; question?: string } | undefined; return (b?.title ?? b?.question ?? '').toLowerCase(); };
    return [...byOp.values()]
      .filter((p) => !opts.kind || (opts.kind === 'human') === p.human)
      .filter((p) => !q || [...p.realms].some((r) => r.includes(q)) || [...p.problems].some((id) => titleOf(id).includes(q)))
      .sort((a, b) => b.contributions - a.contributions).slice(0, opts.limit ?? 50)
      .map((p) => ({ ...p, realms: [...p.realms], problems: [...p.problems], reputation: this.hub.reputation.reputation(p.operator) }));
  }
}
