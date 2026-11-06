import { join } from 'node:path';
import { homedir } from 'node:os';
import { HubNode } from './node.js';
import { RecordStore } from '../store/records.js';
import { LocalArchive, Archive } from '../store/archive.js';
import { RecordBus, X0xBus } from '../transport/bus.js';
import { LocalSigner, Signer } from '../core/identity.js';
import { X0xClient, DaemonSigner } from '../x0x/client.js';
import { Ledger } from '../services/ledger.js';
import { FlatTrust, TrustModel } from '../services/trust.js';
import { LiveState } from './livestate.js';
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
}

/** Everything one agent's local hub offers, composed over one HubNode. */
export class Hub {
  readonly node: HubNode;
  readonly archive: Archive;
  readonly x0x?: X0xClient;
  readonly live: LiveState;
  trust: TrustModel;
  readonly ledger: Ledger;

  constructor(o: HubOptions) {
    this.archive = o.archive ?? new LocalArchive();
    this.x0x = o.x0x;
    this.node = new HubNode({ signer: o.signer, store: o.store, bus: o.bus, archive: this.archive, operator: o.operator, privacy: o.privacy, preview: o.preview });
    this.trust = new FlatTrust(this.node.store);
    this.ledger = new Ledger(this.node, this.trust);
    this.live = new LiveState(this.node, this.archive, this.x0x);
  }

  setTrust(t: TrustModel) { this.trust = t; this.ledger.setTrust(t); }

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
