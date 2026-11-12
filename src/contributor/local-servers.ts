import { ollamaUrl, runnerFromSpec } from './catalog.js';

/**
 * What model servers are running on this computer, or on the computers it pools with. Each is asked for its model
 * list once, with a short timeout, all at the same time; one that isn't running just isn't listed.
 *
 *  - Ollama, LM Studio, MLX or llama.cpp (both use port 8080), vLLM: one computer.
 *  - exo (github.com/exo-explore/exo): several Macs pooled into one bigger model, over Thunderbolt 5 or the local
 *    network. Any of its computers answers for all of them, so CONSTELLATE_EXO_URL can point at another one.
 *  - CONSTELLATE_CLUSTER_URL: any other server that pools computers behind an OpenAI-compatible API.
 *
 * Apple has been reported to be working on pooling Macs over Thunderbolt; nothing public says how an app would
 * reach it. If it serves an OpenAI-compatible API, CONSTELLATE_CLUSTER_URL already works with it.
 */
export interface LocalServer {
  provider: 'ollama' | 'lmstudio' | 'mlx' | 'llamacpp' | 'vllm' | 'exo' | 'cluster';
  name: string;
  baseUrl: string;
  /** Models ready to answer now. For exo, only models placed on the cluster (choosing one is done in its dashboard). */
  models: string[];
  /** How many computers it pools and their memory together, when the server reports it (exo does). */
  cluster?: { computers: number; memoryGB: number };
  /** Something the person should know, e.g. that a model still has to be chosen. */
  note?: string;
}

type FetchJson = (url: string, ms: number) => Promise<unknown>;

const getJson: FetchJson = async (url, ms) => {
  try { const r = await fetch(url, { signal: AbortSignal.timeout(ms) }); return r.ok ? await r.json() : null; } catch { return null; }
};

const trim = (u: string) => u.replace(/\/+$/, '');
/** An OpenAI-style model list ({ data: [{ id }] }), without embedding models. Anything else is not a model server. */
const openAiModels = (j: unknown) => {
  const data = (j as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return null;
  return data.filter((m): m is { id: string; owned_by?: string } => typeof m?.id === 'string' && !/embed/i.test(m.id));
};
const pick = (o: unknown, ...keys: string[]): unknown => {
  for (const k of keys) if (o && typeof o === 'object' && k in o) return (o as Record<string, unknown>)[k];
  return undefined;
};

/** exo's cluster state, from GET /state/nodeMemory: one entry per computer, each with its total memory. */
export function exoCluster(nodeMemory: unknown): { computers: number; memoryGB: number } | undefined {
  if (!nodeMemory || typeof nodeMemory !== 'object' || Array.isArray(nodeMemory)) return undefined;
  const nodes = Object.values(nodeMemory as Record<string, unknown>);
  if (!nodes.length) return undefined;
  const bytes = nodes.reduce<number>((sum, n) => sum + (Number(pick(pick(n, 'ramTotal', 'ram_total'), 'inBytes', 'in_bytes')) || 0), 0);
  return { computers: nodes.length, memoryGB: Math.round(bytes / 1024 ** 3) };
}

export interface ServerPlaces { ollama?: string; lmstudio?: string; port8080?: string; vllm?: string; exo?: string; cluster?: string }

/** Where each server listens: its default, unless the person's settings (or a test) say otherwise. */
export function serverPlaces(env: NodeJS.ProcessEnv = process.env): Required<Omit<ServerPlaces, 'cluster'>> & { cluster?: string } {
  return {
    ollama: ollamaUrl(env),
    lmstudio: 'http://127.0.0.1:1234',
    port8080: 'http://127.0.0.1:8080',
    vllm: 'http://127.0.0.1:8000',
    exo: trim(env.CONSTELLATE_EXO_URL?.trim() || 'http://127.0.0.1:52415'),
    cluster: env.CONSTELLATE_CLUSTER_URL?.trim() ? trim(env.CONSTELLATE_CLUSTER_URL.trim()) : undefined,
  };
}

/** Every model server this computer can reach right now, pooled ones first. */
export async function findLocalServers(opts: { env?: NodeJS.ProcessEnv; places?: ServerPlaces; fetchJson?: FetchJson; ms?: number } = {}): Promise<LocalServer[]> {
  const at = { ...serverPlaces(opts.env ?? process.env), ...opts.places };
  const get = (url: string) => (opts.fetchJson ?? getJson)(url, opts.ms ?? 800);
  const [exoPs, exoMem, cluster, ollama, lmstudio, p8080, vllm] = await Promise.all([
    get(`${at.exo}/ollama/api/ps`), get(`${at.exo}/state/nodeMemory`),
    at.cluster ? get(`${at.cluster}/models`) : null,
    get(`${at.ollama}/api/tags`), get(`${at.lmstudio}/v1/models`), get(`${at.port8080}/v1/models`), get(`${at.vllm}/v1/models`),
  ]);
  const out: LocalServer[] = [];

  const exoModels = (exoPs as { models?: unknown } | null)?.models;
  if (Array.isArray(exoModels)) {
    const models = [...new Set(exoModels.map((m) => (m as { model?: unknown; name?: unknown })?.model ?? (m as { name?: unknown })?.name).filter((m): m is string => typeof m === 'string'))];
    const pooled = exoCluster(exoMem);
    out.push({
      provider: 'exo', name: 'exo', baseUrl: `${at.exo}/v1`, models, cluster: pooled,
      note: models.length ? undefined : `exo is running but no model is placed on it yet: choose one in its dashboard (${at.exo}).`,
    });
  }
  const pooledModels = openAiModels(cluster);
  if (at.cluster && pooledModels) out.push({ provider: 'cluster', name: 'your cluster', baseUrl: at.cluster, models: pooledModels.map((m) => m.id) });

  const tags = (ollama as { models?: unknown } | null)?.models;
  if (Array.isArray(tags)) out.push({ provider: 'ollama', name: 'Ollama', baseUrl: `${at.ollama}/v1`, models: tags.map((m) => (m as { name?: unknown })?.name).filter((n): n is string => typeof n === 'string' && !/embed/i.test(n)) });
  const lm = openAiModels(lmstudio);
  if (lm) out.push({ provider: 'lmstudio', name: 'LM Studio', baseUrl: `${at.lmstudio}/v1`, models: lm.map((m) => m.id) });
  const on8080 = openAiModels(p8080);
  if (on8080) {
    const llamacpp = on8080.some((m) => m.owned_by === 'llamacpp');
    out.push({ provider: llamacpp ? 'llamacpp' : 'mlx', name: llamacpp ? 'llama.cpp' : 'MLX', baseUrl: `${at.port8080}/v1`, models: on8080.map((m) => m.id) });
  }
  const vl = openAiModels(vllm);
  if (vl) out.push({ provider: 'vllm', name: 'vLLM', baseUrl: `${at.vllm}/v1`, models: vl.map((m) => m.id) });
  return out;
}

/** The spec for a model on a server found here, as `--model` takes it. Non-default ports go on the end (`@8081`). */
export function specFor(s: LocalServer, model: string) {
  if (s.provider === 'cluster') return `cluster/${model}`;
  if (s.provider === 'ollama') return `ollama/${model}`; // OLLAMA_HOST already says where
  const port = s.baseUrl.match(/^https?:\/\/(?:127\.0\.0\.1|localhost):(\d+)\//)?.[1];
  const usual: Record<string, string> = { lmstudio: '1234', mlx: '8080', llamacpp: '8080', vllm: '8000', exo: '52415' };
  return `${s.provider}/${model}${port && port !== usual[s.provider] ? `@${port}` : ''}`;
}

export const pools = (s: LocalServer) => s.provider === 'exo' || s.provider === 'cluster';

/** The pooled server with a model ready and the most memory, if any: what `contribute` uses on its own. */
export function bestCluster(servers: LocalServer[]) {
  return servers.filter((s) => pools(s) && s.models.length).sort((a, b) => (b.cluster?.memoryGB ?? 0) - (a.cluster?.memoryGB ?? 0))[0];
}

/** One line about a server, for people: what it is, how many computers, how much memory. */
export function describeServer(s: LocalServer) {
  const size = s.cluster ? `${s.cluster.computers} computer${s.cluster.computers === 1 ? '' : 's'}${s.cluster.memoryGB ? `, ${s.cluster.memoryGB} GB of memory together` : ''}` : '';
  if (s.provider === 'exo') return `exo${size ? ` pooling ${size}` : ''}`;
  if (s.provider === 'cluster') return `your cluster at ${s.baseUrl}`;
  return `${s.name} on this computer`;
}

type Pick = { run: { provider: string; model: string } } | null | undefined;

/**
 * What `contribute` runs when no model is named and a pooled server has one ready. The pooled model takes the steps
 * that need a big model. A suggested model this computer already has running takes the small steps and checks other
 * computers' work, when it adds a size or a family. Nothing is downloaded on the person's behalf.
 */
export function clusterPlan(servers: LocalServer[], suggested: { primary?: Pick; verifier?: Pick }, env: NodeJS.ProcessEnv = process.env) {
  const server = bestCluster(servers);
  if (!server) return undefined;
  const main = specFor(server, server.models[0]);
  const top = runnerFromSpec(main, { env });
  const specs = [main];
  const running = (run: { provider: string; model: string }) => servers.some((x) => x.provider === run.provider && x.models.some((m) => m === run.model || m === `${run.model}:latest`));
  for (const pick of [suggested.primary, suggested.verifier]) {
    if (!pick || !running(pick.run)) continue;
    const spec = `${pick.run.provider}/${pick.run.model}`;
    const r = runnerFromSpec(spec, { env });
    if (!specs.includes(spec) && (r.size !== top.size || r.family !== top.family)) specs.push(spec);
  }
  return { server, specs, big: top.size === 'large' };
}
