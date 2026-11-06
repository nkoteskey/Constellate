import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hub } from '../hub/hub.js';

export class HttpReply { constructor(readonly status: number, readonly body: unknown, readonly headers: Record<string, string> = {}) {} }

export type ApiHandler = (req: IncomingMessage, url: URL, body: () => Promise<any>) => Promise<unknown> | unknown;

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC = [join(here, 'public'), join(here, '../../src/web/public')].find((p) => existsSync(p)) ?? join(here, 'public');
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };

/**
 * The human app's server: public reads need nothing (browsing needs no account),
 * plus a JSON API that other modules extend with routes.
 */
export class WebServer {
  private server?: Server;
  readonly routes: { method: string; pattern: RegExp; fn: (req: IncomingMessage, m: RegExpMatchArray, url: URL, body: () => Promise<any>) => unknown }[] = [];
  url = '';

  constructor(readonly hub: Hub) {
    this.route('GET', /^\/api\/status$/, () => this.hub.status());
    this.route('GET', /^\/api\/problems$/, async () => {
      const out = [];
      for (const p of this.hub.problems.list()) out.push(await this.hub.problems.summary(p.rec.id));
      return out;
    });
    this.route('GET', /^\/api\/problems\/([0-9a-f]{64})$/, (_r, m) => this.hub.problems.summary(m[1]));
    this.route('GET', /^\/api\/records\/([0-9a-f]{64})$/, (_r, m) => {
      const s = this.hub.node.store.get(m[1]);
      if (!s || s.visibility !== 'public') throw Object.assign(new Error('not found'), { status: 404 });
      return { record: s.rec, operator: s.operatorId, trust: this.hub.trust.explain(s), referenced_by: this.hub.node.store.referencing(m[1]).map((r) => ({ id: r.rec.id, kind: r.rec.kind, operator: r.operatorId })) };
    });
  }

  route(method: string, pattern: RegExp, fn: (req: IncomingMessage, m: RegExpMatchArray, url: URL, body: () => Promise<any>) => unknown) {
    this.routes.push({ method, pattern, fn });
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://local');
    const body = async () => { const c: Buffer[] = []; for await (const x of req) c.push(x as Buffer); return c.length ? JSON.parse(Buffer.concat(c).toString('utf8')) : {}; };
    for (const r of this.routes) {
      const m = url.pathname.match(r.pattern);
      if (m && r.method === req.method) {
        try {
          const out = await r.fn(req, m, url, body);
          if (out instanceof HttpReply) { res.writeHead(out.status, { 'content-type': 'application/json', ...out.headers }); return res.end(JSON.stringify(out.body)); }
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(JSON.stringify(out));
        } catch (e) {
          res.writeHead((e as { status?: number }).status ?? 400, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ error: (e as Error).message }));
        }
      }
    }
    if (req.method !== 'GET') { res.writeHead(404); return res.end(); }
    const path = url.pathname === '/' || !extname(url.pathname) ? '/index.html' : url.pathname;
    const file = join(PUBLIC, path.replace(/\.\.+/g, ''));
    if (!file.startsWith(PUBLIC) || !existsSync(file)) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  }

  async listen(port = 4747, host = '127.0.0.1') {
    this.server = createServer((q, s) => void this.handle(q, s));
    await new Promise<void>((r) => this.server!.listen(port, host, r));
    this.url = `http://${host}:${(this.server.address() as AddressInfo).port}`;
    return this;
  }
  async close() { await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r())); }
}
