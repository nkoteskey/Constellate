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
  async dm(agentId: string, text: string) {
    if (!this.hub.x0x) throw new Error('direct messages need a running x0x daemon (coming soon in the browser)');
    return this.hub.x0x.directSend(agentId, toB64(utf8(JSON.stringify({ app: 'constellate', type: 'dm', text }))));
  }

  /** Discover people by realm, problem and interest. */
  discover(opts: { realm?: string; problem?: string; limit?: number } = {}) {
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
    return [...byOp.values()].sort((a, b) => b.contributions - a.contributions).slice(0, opts.limit ?? 50)
      .map((p) => ({ ...p, realms: [...p.realms], problems: [...p.problems], reputation: this.hub.reputation.reputation(p.operator) }));
  }
}
