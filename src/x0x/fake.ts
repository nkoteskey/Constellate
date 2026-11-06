import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { LocalSigner, verifyExternal } from '../core/identity.js';
import { fromB64, toB64, toHex } from '../util/bytes.js';
import { sha256Hex } from '../core/canonical.js';
import { utf8 } from '../util/bytes.js';

/**
 * A test double for x0xd's REST API, faithful to the subset Constellate uses
 * (sign/verify DST, gossip publish/subscribe/SSE, KV stores, task lists).
 * Several FakeDaemons share a FakeMesh, standing in for separate machines.
 * The mesh keeps every byte that crossed it in `wire` so tests can prove
 * nothing private leaked.
 */
export class FakeMesh {
  readonly daemons = new Set<FakeDaemon>();
  readonly wire: { topic: string; from: string; payload: Uint8Array }[] = [];
  readonly stores = new Map<string, { owner: string; policy: string; data: Map<string, { value: string; content_type: string }> }>();
  readonly taskLists = new Map<string, { name: string; tasks: Map<string, { id: string; title: string; description: string | null; state: string; claimed_by: string | null; completed_by: string | null }> }>();
  partitioned = new Set<FakeDaemon>();
}

type Sub = { id: string; topic: string };

export class FakeDaemon {
  readonly signer: LocalSigner;
  readonly token = toHex(new Uint8Array(randomBytes(16)));
  private server?: Server;
  private subs: Sub[] = [];
  private sse = new Set<ServerResponse>();
  private joinedStores = new Set<string>();
  url = '';

  constructor(readonly mesh: FakeMesh, readonly name = 'machine') {
    this.signer = LocalSigner.generate();
    mesh.daemons.add(this);
  }
  get agentId() { return this.signer.agentId; }

  async start(): Promise<this> {
    this.server = createServer((req, res) => this.handle(req, res).catch((e) => this.json(res, 500, { ok: false, error: String(e) })));
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
    return this;
  }
  async stop() {
    for (const s of this.sse) s.end();
    this.mesh.daemons.delete(this);
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }

  deliver(topic: string, payload: Uint8Array, sender: string) {
    if (!this.subs.some((s) => s.topic === topic)) return;
    for (const sub of this.subs.filter((s) => s.topic === topic)) {
      const frame = JSON.stringify({ type: 'message', data: { subscription_id: sub.id, topic, payload: toB64(payload), sender, verified: true, trust_level: 'unknown' } });
      for (const s of this.sse) s.write(`data: ${frame}\n\n`);
    }
  }

  private json(res: ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  private async body(req: IncomingMessage): Promise<any> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url!, 'http://x');
    const p = url.pathname;
    const m = req.method!;
    if (m === 'GET' && p === '/health') return this.json(res, 200, { ok: true, status: 'healthy', version: 'fake-0.48.1', peers: this.mesh.daemons.size - 1 });
    if (m === 'GET' && p.startsWith('/constitution')) return this.json(res, 200, { ok: true, version: 'fake', text: 'Do no harm. Be honest. Respect privacy.' });
    if (req.headers.authorization !== `Bearer ${this.token}`) return this.json(res, 401, { ok: false, error: 'unauthorized' });

    if (m === 'GET' && p === '/agent') return this.json(res, 200, { ok: true, agent_id: this.agentId, machine_id: sha256Hex(utf8(this.name + this.agentId)), user_id: null });
    if (m === 'POST' && p === '/agent/sign') {
      const b = await this.body(req);
      const payload = fromB64(b.payload_b64);
      if (payload.length > 64 * 1024) return this.json(res, 413, { ok: false, error: 'payload too large' });
      const sig = await this.signer.sign(b.context, payload);
      return this.json(res, 200, { ok: true, agent_id: this.agentId, public_key_b64: toB64(this.signer.publicKey), signature_b64: toB64(sig), context: b.context, algorithm: 'x0x.agent-sign.v2.ml-dsa-65' });
    }
    if (m === 'POST' && p === '/agent/verify') {
      const b = await this.body(req);
      return this.json(res, 200, { ok: true, valid: verifyExternal(fromB64(b.public_key_b64), b.context, fromB64(b.payload_b64), fromB64(b.signature_b64)), algorithm: 'x0x.agent-sign.v2.ml-dsa-65' });
    }
    if (m === 'POST' && p === '/publish') {
      const b = await this.body(req);
      const payload = fromB64(b.payload);
      if (!String(b.topic).startsWith('local:')) this.mesh.wire.push({ topic: b.topic, from: this.agentId, payload });
      for (const d of this.mesh.daemons) {
        if (String(b.topic).startsWith('local:') ? d === this : d !== this && !this.mesh.partitioned.has(d) && !this.mesh.partitioned.has(this)) d.deliver(b.topic, payload, this.agentId);
      }
      return this.json(res, 200, { ok: true });
    }
    if (m === 'POST' && p === '/subscribe') {
      const b = await this.body(req);
      const id = toHex(new Uint8Array(randomBytes(8)));
      this.subs.push({ id, topic: b.topic });
      return this.json(res, 200, { ok: true, subscription_id: id });
    }
    if (m === 'DELETE' && p.startsWith('/subscribe/')) { this.subs = this.subs.filter((s) => s.id !== p.slice(11)); return this.json(res, 200, { ok: true }); }
    if (m === 'GET' && p === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write(': connected\n\n');
      this.sse.add(res);
      req.on('close', () => this.sse.delete(res));
      return;
    }
    // KV stores
    if (m === 'POST' && p === '/stores') {
      const b = await this.body(req);
      const id = sha256Hex(utf8(`store:${b.topic}`)).slice(0, 32);
      if (!this.mesh.stores.has(id)) this.mesh.stores.set(id, { owner: this.agentId, policy: b.policy ?? 'signed', data: new Map() });
      this.joinedStores.add(id);
      return this.json(res, 200, { ok: true, id, name: b.name, topic: b.topic, policy: b.policy ?? 'signed' });
    }
    let mm = p.match(/^\/stores\/([0-9a-f]+)\/join$/);
    if (m === 'POST' && mm) {
      const s = this.mesh.stores.get(mm[1]);
      const b = await this.body(req);
      if (!b.expected_owner) return this.json(res, 422, { ok: false, error: 'owner_required' });
      if (!s) return this.json(res, 404, { ok: false, error: 'store not found' });
      this.joinedStores.add(mm[1]);
      return this.json(res, 200, { ok: true, id: mm[1] });
    }
    mm = p.match(/^\/stores\/([0-9a-f]+)\/keys$/);
    if (m === 'GET' && mm) {
      const s = this.mesh.stores.get(mm[1]);
      if (!s || !this.joinedStores.has(mm[1])) return this.json(res, 404, { ok: false, error: 'store not found' });
      return this.json(res, 200, { ok: true, keys: [...s.data.keys()].map((key) => ({ key })) });
    }
    mm = p.match(/^\/stores\/([0-9a-f]+)\/(.+)$/);
    if (mm) {
      const s = this.mesh.stores.get(mm[1]);
      const key = decodeURIComponent(mm[2]);
      if (!s || !this.joinedStores.has(mm[1])) return this.json(res, 404, { ok: false, error: 'store not found' });
      if (m === 'GET') { const v = s.data.get(key); return v ? this.json(res, 200, { ok: true, ...v }) : this.json(res, 404, { ok: false, error: 'key not found' }); }
      if (s.owner !== this.agentId) return this.json(res, 403, { ok: false, error: `not authorized: store policy is signed; owner is ${s.owner}` });
      if (m === 'PUT') {
        const b = await this.body(req);
        const prev = s.data.get(key);
        if (s.policy === 'append_only' && prev && prev.value !== b.value) return this.json(res, 409, { ok: false, error: `immutable key: ${key}` });
        s.data.set(key, { value: b.value, content_type: b.content_type ?? 'application/octet-stream' });
        this.mesh.wire.push({ topic: `kv:${mm[1]}`, from: this.agentId, payload: fromB64(b.value) });
        return this.json(res, 200, { ok: true, evicted_keys: [] });
      }
      if (m === 'DELETE') {
        if (s.policy === 'append_only') return this.json(res, 409, { ok: false, error: `immutable key: ${key}` });
        s.data.delete(key); return this.json(res, 200, { ok: true });
      }
    }
    // Task lists: id derives from topic alone, like TaskListId::from_topic.
    if (m === 'POST' && p === '/task-lists') {
      const b = await this.body(req);
      const id = sha256Hex(utf8(`tasks:${b.topic}`)).slice(0, 32);
      if (!this.mesh.taskLists.has(id)) this.mesh.taskLists.set(id, { name: b.name, tasks: new Map() });
      return this.json(res, 201, { ok: true, id, version: 0, committed: 'local' });
    }
    mm = p.match(/^\/task-lists\/([0-9a-f]+)\/tasks$/);
    if (mm) {
      const l = this.mesh.taskLists.get(mm[1]);
      if (!l) return this.json(res, 404, { ok: false, error: 'task list not found' });
      if (m === 'GET') return this.json(res, 200, { ok: true, tasks: [...l.tasks.values()] });
      if (m === 'POST') {
        const b = await this.body(req);
        const id = toHex(new Uint8Array(randomBytes(16)));
        l.tasks.set(id, { id, title: b.title, description: b.description ?? null, state: 'Empty', claimed_by: null, completed_by: null });
        this.mesh.wire.push({ topic: `tasks:${mm[1]}`, from: this.agentId, payload: utf8(JSON.stringify(b)) });
        return this.json(res, 201, { ok: true, task_id: id, version: 1, committed: 'local' });
      }
    }
    mm = p.match(/^\/task-lists\/([0-9a-f]+)\/tasks\/([0-9a-f]+)$/);
    if (m === 'PATCH' && mm) {
      const t = this.mesh.taskLists.get(mm[1])?.tasks.get(mm[2]);
      if (!t) return this.json(res, 404, { ok: false, error: 'task_not_found' });
      const b = await this.body(req);
      // Claims are advisory, never exclusive (x0x ADR): a second claim succeeds too.
      if (b.action === 'claim') { t.state = 'Claimed'; t.claimed_by = this.agentId; }
      else if (b.action === 'complete') { t.state = 'Done'; t.completed_by = this.agentId; }
      else return this.json(res, 400, { ok: false, error: 'bad action' });
      return this.json(res, 200, { ok: true });
    }
    return this.json(res, 404, { ok: false, error: `no route ${m} ${p}` });
  }
}
