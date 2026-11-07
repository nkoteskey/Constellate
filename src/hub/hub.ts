import { join } from 'node:path';
import { homedir } from 'node:os';
import { HubNode } from './node.js';
import { RecordStore } from '../store/records.js';
import { autonomiFromEnv } from '../store/autonomi.js';
import { LocalArchive, Archive } from '../store/archive.js';
import { RecordBus, X0xBus } from '../transport/bus.js';
import { LocalSigner, Signer } from '../core/identity.js';
import { X0xClient, DaemonSigner } from '../x0x/client.js';
import { Ledger } from '../services/ledger.js';
import { TrustModel } from '../services/trust.js';
import { Reputation } from '../services/reputation.js';
import { CtxInput, toContext } from '../services/ledger.js';
import { LiveState } from './livestate.js';
import { Storage } from './storage.js';
import { HistorySync } from './sync.js';
import { Problems } from '../work/problems.js';
import { Collective } from '../collective/collective.js';
import { Skills } from '../economy/skills.js';
import { Deliberation } from '../collective/deliberation.js';
import { PrivateMemory, MemoryKey } from '../services/memory.js';
import { KnowledgeGraph } from '../graph/graph.js';
import { Collab } from '../collab/collab.js';
import { People } from '../collab/people.js';
import { Metrics } from './metrics.js';
import { Board, MemoryBoard, X0xBoard } from '../work/board.js';
import { Economy } from '../economy/economy.js';
import { Bounties } from '../economy/bounties.js';
import { StorageFund } from '../economy/fund.js';
import { Keeper } from './keeper.js';
import { Pages } from '../graph/pages.js';
import { PaymentRail } from '../economy/rail.js';
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
  /** Key for the private encrypted scratchpad. Generated per hub if not given. */
  memoryKey?: MemoryKey;
  now?: () => number;
  readOnly?: boolean;
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
  readonly memory: PrivateMemory;
  readonly graph: KnowledgeGraph;
  private _collective?: Collective;
  economy?: Economy;
  private _skills?: Skills;
  get skills() { return (this._skills ??= new Skills(this, this.economy)); }
  /** Attach a payment rail (testnet ledger by default; mainnet needs a human). */
  attachRail(rail: PaymentRail) { this.economy = new Economy(this, rail); this._skills = undefined; return this.economy; }
  private _deliberation?: Deliberation;
  get deliberation() { return (this._deliberation ??= new Deliberation(this)); }
  private _people?: People;
  get people() { return (this._people ??= new People(this)); }
  readonly metrics = new Metrics(this);
  private _storage?: Storage;
  /** Storage and its cost: status, compaction, history bundles, opt-in pruning (docs/STORAGE.md). */
  get storage() { return (this._storage ??= new Storage(this)); }
  private _sync?: HistorySync;
  /** Catching up from peers over x0x direct messages (gossip has no replay). */
  get sync() { return (this._sync ??= new HistorySync(this)); }
  private _collab?: Collab;
  get collab() { return (this._collab ??= new Collab(this)); }
  private _bounties?: Bounties;
  get bounties() { return (this._bounties ??= new Bounties(this)); }
  private _fund?: StorageFund;
  get fund() { return (this._fund ??= new StorageFund(this)); }
  private _pages?: Pages;
  /** Topic pages, the session map and dreaming (docs/MEMORY.md). */
  get pages() { return (this._pages ??= new Pages(this)); }
  private _keeper?: Keeper;
  get keeper() { return (this._keeper ??= new Keeper(this)); }
  private _board?: Board;
  get board() { return (this._board ??= this.x0x ? new X0xBoard(this.x0x, 'constellate/v1/board') : new MemoryBoard()); }
  get collective() { return (this._collective ??= new Collective(this)); }

  constructor(o: HubOptions) {
    this.archive = o.archive ?? new LocalArchive();
    this.x0x = o.x0x;
    this.node = new HubNode({ signer: o.signer, store: o.store, bus: o.bus, archive: this.archive, operator: o.operator, privacy: o.privacy, preview: o.preview, readOnly: o.readOnly });
    this.trusted = new Set(o.trusted ?? []);
    this.reputation = new Reputation(this.node.store, { preTrusted: () => [this.node.operatorId, ...this.trusted], now: o.now });
    this.trust = this.reputation;
    this.graph = new KnowledgeGraph(this.node.store, this.trust, { now: o.now });
    this.ledger = new Ledger(this.node, this.trust, this.graph);
    this.live = new LiveState(this.node, this.archive, this.x0x, () => this.storage);
    this.problems = new Problems(this);
    this.memory = new PrivateMemory(this.archive, o.memoryKey ?? MemoryKey.generate());
  }

  setTrust(t: TrustModel) { this.trust = t; this.ledger.setTrust(t); this.graph.setTrust(t); }

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

  /** Record that a record (or a specific link) helped: use strengthens links. */
  async use(target: string, opts: { helpful?: boolean; edge?: string; publish?: boolean } = {}) {
    const t = this.node.store.get(target);
    if (!t) throw new Error(`unknown record ${target}`);
    return this.node.submit({ kind: 'use', context: { task: 'used a record', domain: t.rec.context.domain, environment: '' }, body: { target, helpful: opts.helpful ?? true, ...(opts.edge ? { edge: opts.edge } : {}) }, refs: [target] }, { publish: opts.publish ?? true });
  }

  /** Assert a typed link between two records (buildsOn, fixes, contradicts, confirms, inspiredBy, sameAs). */
  async link(from: string, to: string, type: import('../graph/graph.js').LinkType, note = '', opts: { publish?: boolean } = {}) {
    const a = this.node.store.get(from), b = this.node.store.get(to);
    if (!a || !b) throw new Error('both records must exist');
    return this.node.submit({ kind: 'link', context: { task: `${type} link`, domain: [...new Set([...a.rec.context.domain, ...b.rec.context.domain])].slice(0, 12), environment: '' }, body: { from, to, type, note }, refs: [from, to] }, { publish: opts.publish ?? true });
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

  /**
   * Private read mode for closed projects: a local snapshot of the public ledger,
   * a separate closed identity, no gossip, no daemon, no network. Searches never leave the machine.
   */
  static async privateMode(env = process.env): Promise<Hub> {
    const { closedIdentity, importSnapshot } = await import('../seed/snapshot.js');
    const { readFileSync, existsSync } = await import('node:fs');
    const home = env.CONSTELLATE_HOME ?? join(homedir(), '.constellate');
    const store = new RecordStore();
    const snap = env.CONSTELLATE_SNAPSHOT ?? join(home, 'snapshot.cbor');
    if (existsSync(snap)) importSnapshot(new Uint8Array(readFileSync(snap)), store);
    return new Hub({ signer: closedIdentity(home), store, archive: new LocalArchive(join(home, 'private-archive')), memoryKey: MemoryKey.loadOrCreate(join(home, 'closed-memory.key')), readOnly: true, preview: true });
  }

  /** Production wiring: use the local x0x daemon if it answers, else run offline with a local key. */
  static async fromEnv(env = process.env): Promise<Hub> {
    const home = env.CONSTELLATE_HOME ?? join(homedir(), '.constellate');
    const store = new RecordStore(join(home, 'records'));
    // CONSTELLATE_ARCHIVE=autonomi: permanent storage on Autonomi mainnet (paid; off by default). Any other value is a local folder.
    const archive: Archive = autonomiFromEnv(env) ?? new LocalArchive(env.CONSTELLATE_ARCHIVE && env.CONSTELLATE_ARCHIVE !== 'autonomi' ? env.CONSTELLATE_ARCHIVE : join(home, 'archive'));
    const memoryKey = MemoryKey.loadOrCreate(join(home, 'memory.key'));
    const privacy: ScrubOptions = { level: env.CONSTELLATE_PRIVACY === 'standard' ? 'standard' : 'strict', denyTerms: (env.CONSTELLATE_DENY_TERMS ?? '').split(',').filter(Boolean) };
    const preview = env.CONSTELLATE_PREVIEW !== 'off';
    const x0x = new X0xClient(env.X0X_API, env.X0X_TOKEN, env.X0X_DATA_DIR);
    try {
      await x0x.health();
      const signer = await DaemonSigner.connect(x0x);
      const bus = await X0xBus.connect(x0x);
      return new Hub({ signer, store, bus, archive, x0x, privacy, preview, memoryKey });
    } catch {
      return new Hub({ signer: LocalSigner.loadOrCreate(join(home, 'agent.key')), store, archive, privacy, preview, memoryKey });
    }
  }
}
