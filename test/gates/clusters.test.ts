import { describe, it, expect, afterAll } from 'vitest';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bestCluster, clusterPlan, describeServer, exoCluster, findLocalServers, specFor } from '../../src/contributor/local-servers.js';
import { runnerFromSpec } from '../../src/contributor/catalog.js';
import { reachableModels } from '../../src/work/model-runs.js';

/**
 * Lending compute should be as easy with several computers as with one. When computers are pooled into one bigger
 * model (exo pools Macs over Thunderbolt 5 or the network; any other pool can be named with
 * CONSTELLATE_CLUSTER_URL), Constellate finds it on its own: `constellate models` lists it with how many computers
 * and how much memory, the app offers its models first, and `contribute` with no model named gives it the steps
 * that need a big model. The servers here are stand-ins that answer the way the real ones do (exo's /ollama/api/ps
 * and /state/nodeMemory, OpenAI-style /models lists, Ollama's /api/tags).
 */
const GiB = 1024 ** 3;
const BIG = 'mlx-community/Llama-3.3-70B-Instruct-4bit';

type Route = (req: IncomingMessage, body: string) => unknown;
async function fake(routes: Record<string, Route>) {
  const hits: { path: string; body: string }[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const path = (req.url ?? '').split('?')[0];
      hits.push({ path, body });
      const route = routes[`${req.method} ${path}`];
      if (!route) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(route(req, body)));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { url, hits, close: () => new Promise<void>((r) => server.close(() => r())) };
}
/** A port with nothing listening, so a real server on this computer can't stand in for one the test leaves out. */
async function closedPort() { const f = await fake({}); await f.close(); return f.url; }

const exoRoutes = (models: string[], memory: Record<string, unknown>): Record<string, Route> => ({
  'GET /ollama/api/ps': () => ({ models: models.map((m) => ({ name: m, model: m, size: 0 })) }),
  'GET /state/nodeMemory': () => memory,
  'POST /v1/chat/completions': () => ({ choices: [{ message: { content: '42' } }] }),
});
const twoMacs = { 'node-a': { ramTotal: { inBytes: 128 * GiB }, ramAvailable: { inBytes: 100 * GiB } }, 'node-b': { ramTotal: { inBytes: 64 * GiB }, ramAvailable: { inBytes: 50 * GiB } } };

const servers: { close(): Promise<void> }[] = [];
afterAll(async () => { await Promise.all(servers.map((s) => s.close())); });
async function stand(routes: Record<string, Route>) { const f = await fake(routes); servers.push(f); return f; }

describe('computers pooled into one bigger model are found and used on their own', () => {
  it('finds exo with its computers and memory, a named cluster, and the single-computer servers, pooled ones first', async () => {
    const exo = await stand(exoRoutes([BIG], twoMacs));
    const cluster = await stand({ 'GET /v1/models': () => ({ object: 'list', data: [{ id: 'qwen3-235b-a22b', object: 'model' }, { id: 'text-embed-3', object: 'model' }] }) });
    const ollama = await stand({ 'GET /api/tags': () => ({ models: [{ name: 'gemma3:4b' }, { name: 'nomic-embed-text' }] }) });
    const llamacpp = await stand({ 'GET /v1/models': () => ({ object: 'list', data: [{ id: 'model.gguf', owned_by: 'llamacpp' }] }) });
    const notAModelServer = await stand({ 'GET /v1/models': () => ({ status: 'ok' }) }); // some other app on 8000
    const none = await closedPort();

    const found = await findLocalServers({ places: { exo: exo.url, cluster: `${cluster.url}/v1`, ollama: ollama.url, lmstudio: none, port8080: llamacpp.url, vllm: notAModelServer.url } });
    expect(found.map((s) => s.provider)).toEqual(['exo', 'cluster', 'ollama', 'llamacpp']);
    expect(found[0]).toMatchObject({ models: [BIG], cluster: { computers: 2, memoryGB: 192 }, baseUrl: `${exo.url}/v1` });
    expect(describeServer(found[0])).toBe('exo pooling 2 computers, 192 GB of memory together');
    expect(found[1].models).toEqual(['qwen3-235b-a22b']); // embedding models are no use for steps
    expect(found[2].models).toEqual(['gemma3:4b']);
    expect(bestCluster(found)).toBe(found[0]); // the most memory wins

    // The spec names the port when it isn't the usual one, and runs against that same server.
    const spec = specFor(found[0], BIG);
    expect(spec).toBe(`exo/${BIG}@${exo.url.split(':').pop()}`);
    const runner = runnerFromSpec(spec, { env: {} });
    expect(runner).toMatchObject({ id: `exo:${BIG}`, family: 'llama', size: 'large', costPerCall: 0 });
    expect(await runner.run('What is 6 × 7?')).toBe('42');
    expect(JSON.parse(exo.hits.find((h) => h.path === '/v1/chat/completions')!.body).model).toBe(BIG);
  });

  it('exo running with no model placed yet says what to do, and is not used', async () => {
    const exo = await stand(exoRoutes([], twoMacs));
    const none = await closedPort();
    const found = await findLocalServers({ places: { exo: exo.url, ollama: none, lmstudio: none, port8080: none, vllm: none } });
    expect(found).toHaveLength(1);
    expect(found[0].note).toBe(`exo is running but no model is placed on it yet: choose one in its dashboard (${exo.url}).`);
    expect(bestCluster(found)).toBeUndefined();
    expect(clusterPlan(found, {})).toBeUndefined();
  });

  it('reads exo memory in either spelling, and nothing when it reports none', () => {
    expect(exoCluster({ a: { ram_total: { in_bytes: 32 * GiB } } })).toEqual({ computers: 1, memoryGB: 32 });
    expect(exoCluster({})).toBeUndefined();
    expect(exoCluster(null)).toBeUndefined();
    expect(exoCluster([1, 2])).toBeUndefined();
  });

  it('contribute with no model named: the pooled model takes the big steps, a small model already running takes the rest', async () => {
    const exo = await stand(exoRoutes([BIG], twoMacs));
    const ollama = await stand({ 'GET /api/tags': () => ({ models: [{ name: 'gemma3:4b' }] }) });
    const none = await closedPort();
    const env = { OLLAMA_HOST: ollama.url };
    const found = await findLocalServers({ env, places: { exo: exo.url, lmstudio: none, port8080: none, vllm: none } });
    const suggested = { primary: { run: { provider: 'ollama', model: 'gemma3:4b' } }, verifier: { run: { provider: 'ollama', model: 'qwen3:4b' } } };
    const plan = clusterPlan(found, suggested, env)!;
    expect(plan.specs).toEqual([specFor(found[0], BIG), 'ollama/gemma3:4b']); // qwen3:4b isn't pulled: nothing is downloaded for the person
    expect(plan.big).toBe(true);
    expect(plan.specs.map((s) => runnerFromSpec(s, { env }).size)).toEqual(['large', 'small']);
  });

  it('the app offers pooled models first, with how many computers they span', async () => {
    const exo = await stand(exoRoutes([BIG], twoMacs));
    const ollama = await stand({ 'GET /api/tags': () => ({ models: [{ name: 'gemma3:4b' }] }) });
    const none = await closedPort();
    const list = await reachableModels({ env: {}, vault: { names: () => [] }, places: { exo: exo.url, ollama: ollama.url, lmstudio: none, port8080: none, vllm: none } });
    expect(list.map((m) => m.spec)).toEqual([specFor({ provider: 'exo', name: 'exo', baseUrl: `${exo.url}/v1`, models: [] }, BIG), 'ollama/gemma3:4b']);
    expect(list[0].note).toBe('exo pooling 2 computers, 192 GB of memory together, free: room for big models');
    expect(list[1].note).toBe('Ollama on this computer, free');
  });

  it('a cluster named by URL, or exo reached on another of its computers, runs from one string', () => {
    expect((runnerFromSpec('cluster/qwen3-235b-a22b', { env: { CONSTELLATE_CLUSTER_URL: 'http://pool.local:9000/v1' } }) as unknown as { baseUrl: string }).baseUrl).toBe('http://pool.local:9000/v1');
    expect(() => runnerFromSpec('cluster/qwen3-235b-a22b', { env: {} })).toThrow(/CONSTELLATE_CLUSTER_URL/);
    expect((runnerFromSpec(`exo/${BIG}`, { env: { CONSTELLATE_EXO_URL: 'http://studio.local:52415/' } }) as unknown as { baseUrl: string }).baseUrl).toBe('http://studio.local:52415/v1');
    expect((runnerFromSpec(`exo/${BIG}`, { env: {} }) as unknown as { baseUrl: string }).baseUrl).toBe('http://127.0.0.1:52415/v1');
  });

  it('`constellate models` lists the pool, its models and that contribute will use it', async () => {
    const exo = await stand(exoRoutes([BIG], twoMacs));
    const none = await closedPort();
    const home = mkdtempSync(join(tmpdir(), 'clusters-'));
    const { stdout } = await promisify(execFile)(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/cli.ts', 'models'], { env: { ...process.env, CONSTELLATE_HOME: home, CONSTELLATE_EXO_URL: exo.url, OLLAMA_HOST: none } });
    expect(stdout).toContain(`Running now:\n  exo pooling 2 computers, 192 GB of memory together: exo/${BIG}@${exo.url.split(':').pop()}`);
    expect(stdout).toContain('exo pooling 2 computers, 192 GB of memory together is ready. `constellate contribute` uses it on its own, for steps that need a big model.');
    expect(stdout).toMatch(/exo\s+exo \(pooled computers\)\s+free/);
    expect(stdout).toMatch(/cluster\s+Your own cluster\s+free\s+url: CONSTELLATE_CLUSTER_URL/);
    expect(stdout).not.toContain('More than one computer?'); // the pointer to exo is for people who haven't got it

    // The desktop app's one switch uses the pool too: with no model chosen there, it names none, so contribute picks the pool.
    const desk = readFileSync(join(import.meta.dirname, '../../desktop/main.mjs'), 'utf8');
    expect(desk).toMatch(/const pooled = settings\.model \? null : await pool\(\)/);
    expect(desk).toMatch(/args: \['contribute', '--lend', \.\.\.models\]/);
    expect(desk).toMatch(/pool: settings\.model \? null : await pool\(\)/);

    const alone = await promisify(execFile)(process.execPath, ['node_modules/tsx/dist/cli.mjs', 'src/cli.ts', 'models'], { env: { ...process.env, CONSTELLATE_HOME: home, CONSTELLATE_EXO_URL: none, OLLAMA_HOST: none } });
    expect(alone.stdout).toContain('More than one computer? exo (github.com/exo-explore/exo) pools Macs into one bigger model');
  }, 90_000);
});
