import { AnthropicRunner, ModelRunner, ModelSize, OpenAICompatibleRunner } from './models.js';
import { PROVIDERS, familyOf, parseModelSpec } from '../web/public/js/models.js';

export { PROVIDERS, OPEN_MODELS, FREE_HOSTED, CATALOG_UPDATED, suggest, commands, familyOf, parseModelSpec } from '../web/public/js/models.js';

/** Rough cents per call for paid hosted models, used only for the spending cap. Local and free tiers cost 0. */
const PAID = new Set(['openai', 'anthropic', 'xai', 'together', 'deepseek']);

/**
 * Any model, from one string: "ollama/qwen3:14b", "groq/llama-3.3-70b-versatile",
 * "openrouter/deepseek/deepseek-r1:free", "anthropic/claude-opus-5-5",
 * "custom/my-model" with an endpoint. A local model may name its port: "mlx/<model>@8081".
 * Keys come from the provider's environment variable (or the encrypted key vault).
 */
export function runnerFromSpec(spec: string, opts: { endpoint?: string; key?: string; env?: NodeJS.ProcessEnv; size?: ModelSize; family?: string; vault?: { get(name: string): string | undefined } } = {}): ModelRunner {
  const env = opts.env ?? process.env;
  let { provider, model } = parseModelSpec(spec);
  if (!model) throw new Error(`no model named in "${spec}"`);
  let baseUrl = provider.baseUrl;
  const port = provider.kind === 'local' ? model.match(/@(\d{2,5})$/) : null;
  if (port) { model = model.slice(0, port.index); baseUrl = baseUrl!.replace(/:\d+\//, `:${port[1]}/`); }
  if (provider.id === 'custom') {
    if (!opts.endpoint) throw new Error('a custom model needs --endpoint <OpenAI-compatible URL>');
    baseUrl = opts.endpoint;
  }
  // Keys: the encrypted on-device vault first (`constellate keys set`), then the provider's usual variable.
  const key = opts.key ?? opts.vault?.get(provider.id) ?? (provider.keyEnv ? env[provider.keyEnv] : provider.id === 'custom' ? env.MODEL_API_KEY : undefined);
  if (provider.kind === 'hosted' && !key) throw new Error(`${provider.name} needs an API key: run \`constellate keys set ${provider.id}\` (stored encrypted on this device) or set ${provider.keyEnv}`);
  const family = opts.family ?? familyOf(model);
  const size: ModelSize = opts.size ?? (/(\d+)b/i.test(model) && Number(model.match(/(\d+)b/i)![1]) < 20 ? 'small' : 'large');
  const cost = PAID.has(provider.id) ? 2 : 0;
  const id = `${provider.id}:${model}`;
  if (provider.native === 'anthropic') return new AnthropicRunner(id, model, size, cost, key);
  return new OpenAICompatibleRunner(id, family, size, baseUrl!, model, key, cost);
}

/** For `constellate models`: every way to bring a model, in one list. */
export function providerTable() {
  return PROVIDERS.map((p) => ({ id: p.id, name: p.name, where: p.kind, cost: p.cost, open_weights: p.openWeight, key: p.keyEnv ?? '', example: `${p.id}/${p.example}` }));
}
