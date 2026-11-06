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

export class X0xError extends Error {
  constructor(readonly status: number, message: string) { super(`x0x ${status}: ${message}`); }
}

export class X0xClient {
  constructor(readonly baseUrl = process.env.X0X_API ?? 'http://127.0.0.1:12700', private readonly token = process.env.X0X_TOKEN ?? defaultToken()) {}

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(this.baseUrl + path, {
      method,
      headers: { 'content-type': 'application/json', ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
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
      const res = await fetch(this.baseUrl + '/events', { headers: this.token ? { authorization: `Bearer ${this.token}` } : {}, signal: ctl.signal });
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
  directSend(agentId: string, payloadB64: string) { return this.req<{ ok: true }>('POST', '/direct/send', { agent_id: agentId, payload: payloadB64 }); }

  constitution() { return this.req<Record<string, unknown>>('GET', '/constitution'); }
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
