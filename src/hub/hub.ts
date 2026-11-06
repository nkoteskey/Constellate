import { join } from 'node:path';
import { homedir } from 'node:os';
import { HubNode } from './node.js';
import { RecordStore } from '../store/records.js';
import { LocalArchive, Archive } from '../store/archive.js';
import { RecordBus, X0xBus } from '../transport/bus.js';
import { LocalSigner, Signer } from '../core/identity.js';
import { X0xClient, DaemonSigner } from '../x0x/client.js';
import { Ledger } from '../services/ledger.js';
import { TrustModel } from '../services/trust.js';
import { Reputation } from '../services/reputation.js';
import { CtxInput, toContext } from '../services/ledger.js';
import { LiveState } from './livestate.js';
import { Problems } from '../work/problems.js';
import { ScrubOptions } from '../privacy/scrub.js';
import { OperatorClaim } from '../core/operator.js';

export interface HubOptions {
  signer: Signer;
  store?: RecordStore;
  bus?: RecordBus;
  archive?: Archive;
  x0x?: X0xClient;
  operator?: OperatorClaim;
  privacy?: ScrubOptions;
  preview?: boolean;
  /** Operator ids trusted a priori (x0x contacts marked trusted, colleagues). The local operator is always trusted. */
  trusted?: string[];
  now?: () => number;
}

/** Everything one agent's local hub offers, composed over one HubNode. */
export class Hub {
  readonly node: HubNode;
  readonly archive: Archive;
  readonly x0x?: X0xClient;
  readonly live: LiveState;
  trust: TrustModel;
  readonly reputation: Reputation;
  readonly trusted: Set<string>;
  readonly ledger: Ledger;
  readonly problems: Problems;

  constructor(o: HubOptions) {
    this.archive = o.archive ?? new LocalArchive();
    this.x0x = o.x0x;
    this.node = new HubNode({ signer: o.signer, store: o.store, bus: o.bus, archive: this.archive, operator: o.operator, privacy: o.privacy, preview: o.preview });
    this.trusted = new Set(o.trusted ?? []);
    this.reputation = new Reputation(this.node.store, { preTrusted: () => [this.node.operatorId, ...this.trusted], now: o.now });
    this.trust = this.reputation;
    this.ledger = new Ledger(this.node, this.trust);
    this.live = new LiveState(this.node, this.archive, this.x0x);
    this.problems = new Problems(this);
  }

  setTrust(t: TrustModel) { this.trust = t; this.ledger.setTrust(t); }

  /** Sign a confirmation: you hit the same failure, or verified the same answer. Confirmations, not votes. */
  async confirm(id: string, ctx: Partial<CtxInput> & { note?: string } = {}, opts: { publish?: boolean } = {}) {
    const target = this.node.store.get(id);
    if (!target) throw new Error(`unknown record ${id}`);
    if (target.operatorId === this.node.operatorId) throw new Error('you cannot confirm your own operator\'s records');
    return this.node.submit({ kind: 'confirmation', refs: [id], context: toContext({ task: ctx.task ?? target.rec.context.task, domain: ctx.domain ?? target.rec.context.domain, environment: ctx.environment ?? target.rec.context.environment, inputs_text: ctx.inputs_text }), body: { verdict: 'reproduced', note: ctx.note ?? '' } }, opts);
  }

  /** Disagree with evidence. Both records stay visible with their environments; often both are right under different conditions. */
  async contradict(id: string, reason: string, ctx: Partial<CtxInput> = {}, opts: { publish?: boolean } = {}) {
    const target = this.node.store.get(id);
    if (!target) throw new Error(`unknown record ${id}`);
    return this.node.submit({ kind: 'contradiction', refs: [id], context: toContext({ task: ctx.task ?? target.rec.context.task, domain: ctx.domain ?? target.rec.context.domain, environment: ctx.environment ?? target.rec.context.environment, inputs_text: ctx.inputs_text }), body: { reason } }, opts);
  }

  status() {
    const counts: Record<string, number> = {};
    for (const s of this.node.store.all()) counts[s.rec.kind] = (counts[s.rec.kind] ?? 0) + 1;
    return {
      agent_id: this.node.agentId,
      operator_id: this.node.operatorId,
      x0x: this.x0x ? this.x0x.baseUrl : 'offline (local key, no gossip)',
      preview_mode: this.node.preview,
      records: counts,
      pending_previews: this.node.pendingPreviews().length,
    };
  }

  async close() { await this.node.close(); }

  /** Production wiring: use the local x0x daemon if it answers, else run offline with a local key. */
  static async fromEnv(env = process.env): Promise<Hub> {
    const home = env.CONSTELLATE_HOME ?? join(homedir(), '.constellate');
    const store = new RecordStore(join(home, 'records'));
    const archive = new LocalArchive(join(home, 'archive'));
    const privacy: ScrubOptions = { level: env.CONSTELLATE_PRIVACY === 'standard' ? 'standard' : 'strict', denyTerms: (env.CONSTELLATE_DENY_TERMS ?? '').split(',').filter(Boolean) };
    const preview = env.CONSTELLATE_PREVIEW !== 'off';
    const x0x = new X0xClient(env.X0X_API);
    try {
      await x0x.health();
      const signer = await DaemonSigner.connect(x0x);
      const bus = await X0xBus.connect(x0x);
      return new Hub({ signer, store, bus, archive, x0x, privacy, preview });
    } catch {
      return new Hub({ signer: LocalSigner.loadOrCreate(join(home, 'agent.key')), store, archive, privacy, preview });
    }
  }
}
