import { fromB64, toB64 } from '../util/bytes.js';
import { Signer } from '../core/identity.js';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Thin client for the local x0xd REST API (default http://127.0.0.1:12700,
 * bearer token in <data_dir>/api-token). Only the surface the hub uses.
 * Shapes follow saorsa-labs/x0x docs/api-reference.md.
 */
export interface GossipMessage { topic: string; payload: Uint8Array; sender: string; verified: boolean; trust_level?: string }
export interface X0xTask { id: string; title: string; description?: string | null; state: string; claimed_by?: string | null; completed_by?: string | null }

/** A public group someone listed in x0x's directory (a GroupCard, trimmed). */
export interface DiscoveredGroup { id: string; name: string; description: string; tags: string[]; members: number; owner: string; updated: number }

export class X0xError extends Error {
  constructor(readonly status: number, readonly code: string) { super(`x0x ${status}: ${code}`); }
}

/** What a failed direct message means, in plain words (x0x docs: "Direct send error codes"). */
export function directSendProblem(e: unknown): string {
  const code = e instanceof X0xError ? e.code : '';
  if (code === 'recipient_key_unavailable') return 'Couldn’t reach them: their agent hasn’t announced itself anywhere your computer can see on x0x. It may be offline, or not set up for direct messages. Nothing was sent; try again later.';
  if (code === 'recipient_key_invalid') return 'x0x is still catching up on their keys. Nothing was sent; try again in a minute.';
  if (code === 'recipient_pairing_denied') return 'x0x refused to send to that agent on this machine. Nothing was sent.';
  if (code === 'payload_too_large') return 'That message is too long for an x0x direct message. Try a shorter one.';
  if (code === 'timeout') return 'x0x took too long to confirm delivery. It may or may not have arrived.';
  return `x0x couldn’t send it (${e instanceof Error ? e.message : String(e)}).`;
}

export class X0xClient {
  /** Per-request time limit (ms); startup uses a shorter one. */
  timeoutMs?: number;
  /**
   * With X0X_DATA_DIR set (the desktop app sets it to its own x0x instance), the address and
   * token are read from that instance's `api.port` and `api-token` on every request, so a
   * daemon restarted on a new random port is found again without restarting Constellate.
   */
  constructor(private readonly fixedUrl = process.env.X0X_API, private readonly fixedToken = process.env.X0X_TOKEN, private readonly dataDir = process.env.X0X_DATA_DIR) {}

  /** The daemon's current address: the instance's `api.port` when there is one, else X0X_API, else the default port. */
  get baseUrl(): string {
    if (this.dataDir) { const p = readTrimmed(join(this.dataDir, 'api.port')); if (p) return p.startsWith('http') ? p : `http://${p}`; }
    // An empty value counts as unset: a launcher may pass a blank optional field (X0X_API="") rather than leave it out.
    return this.fixedUrl || 'http://127.0.0.1:12700';
  }
  private get token(): string | undefined {
    return (this.dataDir ? readTrimmed(join(this.dataDir, 'api-token')) : undefined) ?? (this.fixedToken || defaultToken());
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = this.token;
    // Nothing waits on the daemon forever: a busy or stuck x0x must not freeze Constellate (or its startup).
    const ms = path === '/direct/send' ? 90_000 : this.timeoutMs ?? Number(process.env.CONSTELLATE_X0X_TIMEOUT_MS ?? 20_000);
    const res = await fetch(this.baseUrl + path, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(ms),
    }).catch((e: Error) => { throw new X0xError(0, e.name === 'TimeoutError' ? `no answer from x0x after ${ms / 1000}s (${method} ${path})` : `can’t reach x0x (${e.message})`); });
    const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || j.ok === false) throw new X0xError(res.status, String(j.error ?? res.statusText));
    return j as T;
  }

  health() { return this.req<{ ok: boolean; status: string; version: string; peers: number }>('GET', '/health'); }
  agent() { return this.req<{ agent_id: string; machine_id: string; user_id: string | null }>('GET', '/agent'); }
  async sign(context: string, payload: Uint8Array) {
    const r = await this.req<{ agent_id: string; public_key_b64: string; signature_b64: string; algorithm: string }>('POST', '/agent/sign', { context, payload_b64: toB64(payload) });
    return { agentId: r.agent_id, publicKey: fromB64(r.public_key_b64), signature: fromB64(r.signature_b64), algorithm: r.algorithm };
  }
  async verify(context: string, payload: Uint8Array, signature: Uint8Array, publicKey: Uint8Array) {
    const r = await this.req<{ valid: boolean }>('POST', '/agent/verify', { context, payload_b64: toB64(payload), signature_b64: toB64(signature), public_key_b64: toB64(publicKey), algorithm: 'x0x.agent-sign.v2.ml-dsa-65' });
    return r.valid;
  }
  publish(topic: string, payload: Uint8Array) { return this.req<{ ok: true }>('POST', '/publish', { topic, payload: toB64(payload) }); }
  async subscribe(topic: string) { return (await this.req<{ subscription_id: string }>('POST', '/subscribe', { topic })).subscription_id; }
  unsubscribe(id: string) { return this.req('DELETE', `/subscribe/${id}`); }

  /** SSE stream of subscribed gossip (`GET /events`). Returns a stop function. */
  events(onMessage: (m: GossipMessage) => void): () => void {
    const ctl = new AbortController();
    (async () => {
      const token = this.token;
      const res = await fetch(this.baseUrl + '/events', { headers: token ? { authorization: `Bearer ${token}` } : {}, signal: ctl.signal });
      if (!res.body) return;
      const dec = new TextDecoder();
      let buf = '';
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buf += dec.decode(chunk, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i); buf = buf.slice(i + 2);
          const data = frame.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
          if (!data) continue;
          try {
            const ev = JSON.parse(data);
            if (ev.type === 'message' && ev.data) onMessage({ ...ev.data, payload: fromB64(ev.data.payload) });
          } catch { /* ignore malformed frames */ }
        }
      }
    })().catch(() => {});
    return () => ctl.abort();
  }

  // Key-value stores: live state.
  createStore(name: string, topic: string, policy: 'signed' | 'append_only' = 'signed') { return this.req<{ id: string }>('POST', '/stores', { name, topic, policy }); }
  joinStore(id: string, expectedOwner: string) { return this.req('POST', `/stores/${id}/join`, { expected_owner: expectedOwner }); }
  storePut(id: string, key: string, value: Uint8Array, contentType = 'application/cbor') { return this.req('PUT', `/stores/${id}/${encodeURIComponent(key)}`, { value: toB64(value), content_type: contentType }); }
  async storeGet(id: string, key: string): Promise<Uint8Array | null> {
    try { return fromB64((await this.req<{ value: string }>('GET', `/stores/${id}/${encodeURIComponent(key)}`)).value); }
    catch (e) { if (e instanceof X0xError && e.status === 404) return null; throw e; }
  }
  async storeKeys(id: string) { return (await this.req<{ keys: { key: string }[] | string[] }>('GET', `/stores/${id}/keys`)).keys.map((k) => (typeof k === 'string' ? k : k.key)); }

  // Collaborative task lists: the Board / Swarm.
  async createTaskList(name: string, topic: string) { return (await this.req<{ id: string }>('POST', '/task-lists', { name, topic })).id; }
  async addTask(listId: string, title: string, description?: string) { return (await this.req<{ task_id: string }>('POST', `/task-lists/${listId}/tasks`, { title, description })).task_id; }
  async tasks(listId: string) { return (await this.req<{ tasks: X0xTask[] }>('GET', `/task-lists/${listId}/tasks`)).tasks; }
  updateTask(listId: string, taskId: string, action: 'claim' | 'complete') { return this.req('PATCH', `/task-lists/${listId}/tasks/${taskId}`, { action }); }

  /** Private direct message (durable by default in x0x ≥0.38). payload is base64. */
  // ── Spaces: public named groups (docs/skill/messaging.md §4.3). Response bodies are parsed
  // defensively: the docs give request shapes, not every response field. Untested against a real daemon.
  async createSpace(name: string, preset: 'public_open' | 'public_announce' = 'public_open', description = '') {
    const j = await this.req<Record<string, any>>('POST', '/groups', { name, preset, ...(description ? { description } : {}) });
    return String(j.group_id ?? j.id ?? j.group?.id ?? '');
  }
  spaceSend(groupId: string, body: string, opts: { threadRoot?: string; threadParent?: string } = {}) {
    return this.req('POST', `/groups/${groupId}/send`, { body, ...(opts.threadRoot ? { thread_root: opts.threadRoot } : {}), ...(opts.threadParent ? { thread_parent: opts.threadParent } : {}) });
  }
  async spaceMessages(groupId: string): Promise<{ id: string; from: string; body: string; at: string }[]> {
    const j = await this.req<any>('GET', `/groups/${groupId}/messages`);
    const list: any[] = Array.isArray(j) ? j : j.messages ?? j.items ?? [];
    return list.map((m) => ({ id: String(m.msg_id ?? m.id ?? ''), from: String(m.sender ?? m.author ?? m.agent_id ?? m.from ?? ''), body: String(m.body ?? m.text ?? ''), at: String(m.timestamp ?? m.ts ?? m.created_at ?? m.at ?? new Date().toISOString()) }));
  }
  async spaceInvite(groupId: string) { const j = await this.req<any>('POST', `/groups/${groupId}/invite`, {}); return String(j.invite ?? j.link ?? j.url ?? ''); }
  // ── Open directories (self_keyed stores, x0x ≥0.41): joined by topic alone; each agent writes only under its own id.
  async joinDirectory(topic: string) {
    try { await this.req('POST', `/stores/${encodeURIComponent(topic)}/join`, { policy: 'self_keyed' }); }
    catch (e) { if (!(e instanceof X0xError && e.status === 409)) throw e; } // already joined is success
  }
  directoryPut(topic: string, key: string, value: Uint8Array) { return this.req('PUT', `/stores/${encodeURIComponent(topic)}/${encodeURIComponent(key)}`, { value: toB64(value), content_type: 'application/json' }); }
  async directoryGet(topic: string, key: string): Promise<Uint8Array | null> {
    try { return fromB64((await this.req<{ value: string }>('GET', `/stores/${encodeURIComponent(topic)}/${encodeURIComponent(key)}`)).value); }
    catch (e) { if (e instanceof X0xError && e.status === 404) return null; throw e; }
  }
  directoryDelete(topic: string, key: string) { return this.req('DELETE', `/stores/${encodeURIComponent(topic)}/${encodeURIComponent(key)}`); }
  async directoryKeys(topic: string): Promise<string[]> {
    const j = await this.req<{ keys: ({ key: string } | string)[] }>('GET', `/stores/${encodeURIComponent(topic)}/keys`);
    return (j.keys ?? []).map((k) => (typeof k === 'string' ? k : k.key));
  }
  // ── Public group discovery (x0x Phase C.2): signed group cards gossiped on tag / name / id shards.
  discoverSubscribe(kind: 'tag' | 'name', key: string) { return this.req('POST', '/groups/discover/subscribe', { kind, key }); }
  async discoverGroups(): Promise<DiscoveredGroup[]> {
    const j = await this.req<any>('GET', '/groups/discover');
    const list: any[] = Array.isArray(j) ? j : j.groups ?? j.cards ?? [];
    return list.filter((c) => c && c.group_id && !c.withdrawn).map((c) => ({
      id: String(c.group_id), name: String(c.name ?? ''), description: String(c.description ?? ''), tags: Array.isArray(c.tags) ? c.tags.map(String) : [],
      members: Number(c.member_count ?? 0), owner: String(c.owner_agent_id ?? ''), updated: Number(c.updated_at ?? 0),
    }));
  }
  // ── Presence (docs/skill/messaging.md §4.1)
  async presenceOnline(): Promise<string[]> {
    const j = await this.req<any>('GET', '/presence/online');
    const list: any[] = Array.isArray(j) ? j : j.agents ?? j.online ?? [];
    return list.map((a) => String(typeof a === 'string' ? a : a.agent_id ?? a.id ?? '')).filter(Boolean);
  }

  /** SSE stream of incoming direct messages (`GET /direct/events`). Returns a stop function. */
  directEvents(onMessage: (m: { sender: string; payload: string }) => void): () => void {
    const ctl = new AbortController();
    (async () => {
      const token = this.token;
      const res = await fetch(this.baseUrl + '/direct/events', { headers: token ? { authorization: `Bearer ${token}` } : {}, signal: ctl.signal });
      const reader = res.body!.getReader(); const dec = new TextDecoder(); let buf = '';
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        buf += dec.decode(value, { stream: true });
        let i; while ((i = buf.indexOf('\n\n')) >= 0) {
          const frame = buf.slice(0, i); buf = buf.slice(i + 2);
          const data = frame.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
          try { const j = JSON.parse(data); const sender = j.sender ?? j.agent_id ?? j.from; if (sender && j.payload) onMessage({ sender, payload: j.payload }); } catch { /* keep-alive */ }
        }
      }
    })().catch(() => { /* daemon went away */ });
    return () => ctl.abort();
  }

  directSend(agentId: string, payloadB64: string, opts: { durable?: boolean } = {}) {
    return this.req<{ ok: true; path?: string }>('POST', '/direct/send', { agent_id: agentId, payload: payloadB64, ...(opts.durable === false ? { require_durable_app_ack: false } : {}) });
  }

  /** Ask the network to look an agent up, and wait briefly for its card (x0x: POST /agents/find, GET /agents/discovered?wait). */
  async findAgent(agentId: string, waitMs = 8000) {
    await this.req('POST', `/agents/find/${agentId}`, {}).catch(() => {});
    const ctl = AbortSignal.timeout(waitMs);
    const token = this.token;
    await fetch(`${this.baseUrl}/agents/discovered/${agentId}?wait=true`, { signal: ctl, headers: token ? { authorization: `Bearer ${token}` } : {} }).catch(() => {});
  }

  /**
   * A direct message that copes with strangers: if x0x doesn't know the recipient yet, look them up and try
   * once more; if they can't send delivery receipts (an older x0x), send without asking for one.
   * Returns whether a delivery receipt came back.
   */
  async sendDirect(agentId: string, payloadB64: string): Promise<{ receipt: boolean }> {
    const attempt = async (): Promise<{ receipt: boolean }> => {
      try { await this.directSend(agentId, payloadB64); return { receipt: true }; }
      catch (e) {
        if (e instanceof X0xError && e.code === 'recipient_ack_semantics_unavailable') { await this.directSend(agentId, payloadB64, { durable: false }); return { receipt: false }; }
        throw e;
      }
    };
    try { return await attempt(); }
    catch (e) {
      if (!(e instanceof X0xError) || e.code !== 'recipient_key_unavailable') throw e;
      await this.findAgent(agentId);
      return attempt();
    }
  }

  constitution() { return this.req<Record<string, unknown>>('GET', '/constitution'); }
}

function readTrimmed(path: string): string | undefined {
  try { return readFileSync(path, 'utf8').trim() || undefined; } catch { return undefined; }
}

function defaultToken(): string | undefined {
  const dirs = [process.env.X0X_DATA_DIR, join(homedir(), '.local/share/x0x'), join(homedir(), 'Library/Application Support/x0x'), join(homedir(), '.x0x')].filter(Boolean) as string[];
  for (const d of dirs) { const p = join(d, 'api-token'); if (existsSync(p)) return readFileSync(p, 'utf8').trim(); }
  return undefined;
}

/** Signs through the daemon so records carry the machine's real x0x agent identity. */
export class DaemonSigner implements Signer {
  private constructor(private readonly client: X0xClient, readonly agentId: string, readonly publicKey: Uint8Array) {}
  static async connect(client: X0xClient): Promise<DaemonSigner> {
    const probe = await client.sign('constellate.probe.v1', new Uint8Array([1]));
    return new DaemonSigner(client, probe.agentId, probe.publicKey);
  }
  async sign(context: string, payload: Uint8Array) { return (await this.client.sign(context, payload)).signature; }
}
