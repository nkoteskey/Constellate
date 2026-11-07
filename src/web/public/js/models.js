// Any model, and the right free one for your device.
//
// One source of truth, used by the app in the browser and by `constellate
// contribute` on the machine itself, so both always suggest the same thing.
// Constellate runs no model of its own: contributors bring theirs. Open-weight
// models that run locally are free and private, so they are suggested first;
// any hosted model works too, through its OpenAI-compatible API or Claude's.

/** When this list was last reviewed. Model names move fast; the list is data, easy to update. */
export const CATALOG_UPDATED = '2026-11-06';

/**
 * Where a model can run. Every provider here speaks the OpenAI chat API except
 * Anthropic, which uses its own SDK. `custom` takes any compatible URL.
 */
export const PROVIDERS = [
  { id: 'ollama', name: 'Ollama', kind: 'local', baseUrl: 'http://127.0.0.1:11434/v1', cost: 'free', openWeight: true, note: 'Easiest way to run open models on Mac, Windows and Linux.', example: 'qwen3:14b', setup: 'Install from ollama.com, then: ollama pull <model>' },
  { id: 'mlx', name: 'MLX (Apple Silicon)', kind: 'local', baseUrl: 'http://127.0.0.1:8080/v1', cost: 'free', openWeight: true, note: 'Fastest on M-series Macs.', example: 'mlx-community/Qwen3-14B-4bit', setup: 'pip install mlx-lm, then: mlx_lm.server --model <model> --port 8080' },
  { id: 'lmstudio', name: 'LM Studio', kind: 'local', baseUrl: 'http://127.0.0.1:1234/v1', cost: 'free', openWeight: true, note: 'A desktop app with a model browser; start its local server.', example: 'qwen3-14b' },
  { id: 'llamacpp', name: 'llama.cpp server', kind: 'local', baseUrl: 'http://127.0.0.1:8080/v1', cost: 'free', openWeight: true, note: 'Any GGUF model, CPU or GPU.', example: 'local' },
  { id: 'vllm', name: 'vLLM', kind: 'local', baseUrl: 'http://127.0.0.1:8000/v1', cost: 'free', openWeight: true, note: 'For a server with a big GPU.', example: 'Qwen/Qwen3-32B' },
  { id: 'groq', name: 'Groq', kind: 'hosted', baseUrl: 'https://api.groq.com/openai/v1', keyEnv: 'GROQ_API_KEY', cost: 'free tier', openWeight: true, note: 'Hosted open-weight models, very fast, with a free tier.', example: 'llama-3.3-70b-versatile' },
  { id: 'openrouter', name: 'OpenRouter', kind: 'hosted', baseUrl: 'https://openrouter.ai/api/v1', keyEnv: 'OPENROUTER_API_KEY', cost: 'free models + paid', openWeight: 'mixed', note: 'Hundreds of models behind one key, including free ones (names ending in :free).', example: 'meta-llama/llama-3.3-70b-instruct:free' },
  { id: 'huggingface', name: 'Hugging Face', kind: 'hosted', baseUrl: 'https://router.huggingface.co/v1', keyEnv: 'HF_TOKEN', cost: 'free tier', openWeight: true, note: 'Open models from the Hub, with free monthly credits.', example: 'Qwen/Qwen3-32B' },
  { id: 'together', name: 'Together AI', kind: 'hosted', baseUrl: 'https://api.together.xyz/v1', keyEnv: 'TOGETHER_API_KEY', cost: 'paid', openWeight: true, example: 'Qwen/Qwen3-235B-A22B-Instruct-2507-tput' },
  { id: 'mistral', name: 'Mistral', kind: 'hosted', baseUrl: 'https://api.mistral.ai/v1', keyEnv: 'MISTRAL_API_KEY', cost: 'free tier', openWeight: 'mixed', example: 'mistral-small-latest' },
  { id: 'deepseek', name: 'DeepSeek', kind: 'hosted', baseUrl: 'https://api.deepseek.com/v1', keyEnv: 'DEEPSEEK_API_KEY', cost: 'paid', openWeight: true, example: 'deepseek-chat' },
  { id: 'gemini', name: 'Google Gemini', kind: 'hosted', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', keyEnv: 'GEMINI_API_KEY', cost: 'free tier', openWeight: false, example: 'gemini-2.5-flash' },
  { id: 'openai', name: 'OpenAI', kind: 'hosted', baseUrl: 'https://api.openai.com/v1', keyEnv: 'OPENAI_API_KEY', cost: 'paid', openWeight: false, example: 'gpt-5' },
  { id: 'xai', name: 'xAI', kind: 'hosted', baseUrl: 'https://api.x.ai/v1', keyEnv: 'XAI_API_KEY', cost: 'paid', openWeight: false, example: 'grok-4' },
  { id: 'anthropic', name: 'Anthropic (Claude)', kind: 'hosted', native: 'anthropic', keyEnv: 'ANTHROPIC_API_KEY', cost: 'paid', openWeight: false, example: 'claude-opus-5-5' },
  { id: 'custom', name: 'Any OpenAI-compatible URL', kind: 'custom', cost: 'yours', openWeight: 'mixed', note: 'Pass --endpoint with the URL; add MODEL_API_KEY if it needs one.', example: 'my-model' },
];

/**
 * Open-weight models worth running locally, best first. `needGB` is what the
 * 4-bit build needs in memory with room for context. `params` is the total
 * size in billions; MoE models note their (much smaller) active size.
 */
export const OPEN_MODELS = [
  { id: 'qwen3-32b', name: 'Qwen3 32B', family: 'qwen', params: 32, needGB: 20, licence: 'Apache-2.0', good: 'strong reasoning and code', ollama: 'qwen3:32b', mlx: 'mlx-community/Qwen3-32B-4bit' },
  { id: 'gemma3-27b', name: 'Gemma 3 27B', family: 'gemma', params: 27, needGB: 18, licence: 'Gemma terms', good: 'careful writing and checking', ollama: 'gemma3:27b', mlx: 'mlx-community/gemma-3-27b-it-4bit' },
  { id: 'mistral-small-24b', name: 'Mistral Small 3.1 24B', family: 'mistral', params: 24, needGB: 16, licence: 'Apache-2.0', good: 'fast general work', ollama: 'mistral-small3.1:24b' },
  { id: 'gpt-oss-20b', name: 'gpt-oss 20B', family: 'gpt-oss', params: 21, active: 3.6, needGB: 14, licence: 'Apache-2.0', good: 'reasoning; quick even on CPU (mixture of experts)', ollama: 'gpt-oss:20b' },
  { id: 'qwen3-14b', name: 'Qwen3 14B', family: 'qwen', params: 14, needGB: 10, licence: 'Apache-2.0', good: 'reasoning and code', ollama: 'qwen3:14b', mlx: 'mlx-community/Qwen3-14B-4bit' },
  { id: 'phi4-14b', name: 'Phi-4 14B', family: 'phi', params: 14, needGB: 10, licence: 'MIT', good: 'maths and logic', ollama: 'phi4:14b' },
  { id: 'gemma3-12b', name: 'Gemma 3 12B', family: 'gemma', params: 12, needGB: 9, licence: 'Gemma terms', good: 'checking other models’ work', ollama: 'gemma3:12b', mlx: 'mlx-community/gemma-3-12b-it-4bit' },
  { id: 'qwen3-8b', name: 'Qwen3 8B', family: 'qwen', params: 8, needGB: 6, licence: 'Apache-2.0', good: 'everyday tasks', ollama: 'qwen3:8b', mlx: 'mlx-community/Qwen3-8B-4bit' },
  { id: 'llama3.1-8b', name: 'Llama 3.1 8B', family: 'llama', params: 8, needGB: 6, licence: 'Llama 3.1 licence', good: 'everyday tasks', ollama: 'llama3.1:8b', mlx: 'mlx-community/Meta-Llama-3.1-8B-Instruct-4bit' },
  { id: 'gemma3-4b', name: 'Gemma 3 4B', family: 'gemma', params: 4, needGB: 4, licence: 'Gemma terms', good: 'screening and verification', ollama: 'gemma3:4b', mlx: 'mlx-community/gemma-3-4b-it-4bit' },
  { id: 'qwen3-4b', name: 'Qwen3 4B', family: 'qwen', params: 4, needGB: 3.5, licence: 'Apache-2.0', good: 'screening and verification', ollama: 'qwen3:4b', mlx: 'mlx-community/Qwen3-4B-4bit' },
  { id: 'llama3.2-3b', name: 'Llama 3.2 3B', family: 'llama', params: 3, needGB: 2.5, licence: 'Llama 3.2 licence', good: 'light verification', ollama: 'llama3.2:3b', mlx: 'mlx-community/Llama-3.2-3B-Instruct-4bit' },
];

/** Free hosted options for devices that can't run a model (phones, small laptops). */
export const FREE_HOSTED = [
  { provider: 'groq', model: 'llama-3.3-70b-versatile', family: 'llama', why: 'free tier, open weights, very fast' },
  { provider: 'openrouter', model: 'meta-llama/llama-3.3-70b-instruct:free', family: 'llama', why: 'free model, one key for hundreds more' },
  { provider: 'huggingface', model: 'Qwen/Qwen3-32B', family: 'qwen', why: 'free monthly credits, open weights' },
  { provider: 'gemini', model: 'gemini-2.5-flash', family: 'gemini', why: 'generous free tier (not open weights)' },
];

/** A model's family, from its name. Verification must come from a different family. */
export function familyOf(model = '') {
  const m = String(model).toLowerCase();
  const rules = [['claude', 'claude'], ['gpt-oss', 'gpt-oss'], ['gpt', 'openai'], ['o1', 'openai'], ['o3', 'openai'], ['o4', 'openai'], ['gemini', 'gemini'], ['gemma', 'gemma'], ['qwen', 'qwen'], ['qwq', 'qwen'], ['llama', 'llama'], ['mixtral', 'mistral'], ['mistral', 'mistral'], ['ministral', 'mistral'], ['deepseek', 'deepseek'], ['phi', 'phi'], ['grok', 'grok'], ['command', 'cohere'], ['kimi', 'kimi'], ['glm', 'glm']];
  for (const [k, f] of rules) if (m.includes(k)) return f;
  return 'unknown';
}

/** "ollama/qwen3:14b" → { provider, model }. A bare name means Ollama. */
export function parseModelSpec(spec = '') {
  const i = spec.indexOf('/');
  const head = i > 0 ? spec.slice(0, i) : '';
  const provider = PROVIDERS.find((p) => p.id === head.toLowerCase());
  return provider ? { provider, model: spec.slice(i + 1) } : { provider: PROVIDERS[0], model: spec };
}

/**
 * Suggest free, open-weight models that fit a device.
 * device: { memGB, appleSilicon, gpuGB?, mobile?, cores? }
 * Leaves room for the person's own work: models only run when the machine is idle.
 */
export function suggest(device) {
  const mem = Math.max(0, Number(device.memGB) || 0);
  const gpu = Math.max(0, Number(device.gpuGB) || 0);
  const notes = [];
  let budget, runtime, where;
  if (device.mobile) { budget = 0; runtime = 'none'; where = 'phone or tablet'; }
  else if (device.appleSilicon) { budget = mem * 0.65; runtime = 'ollama'; where = `${mem} GB unified memory`; }
  else if (gpu >= 6) { budget = gpu * 0.9; runtime = 'ollama'; where = `${gpu} GB graphics memory`; }
  else { budget = mem * 0.45; runtime = 'ollama'; where = `${mem} GB memory, no dedicated GPU`; }
  const cpuOnly = !device.appleSilicon && gpu < 6;
  if (cpuOnly && budget > 0) notes.push('No dedicated GPU found: models run on the processor, which is slower. Smaller models suit verification, which is most of the work.');
  const fits = OPEN_MODELS.filter((m) => m.needGB <= budget && (!cpuOnly || m.params <= 14 || (m.active ?? m.params) <= 4));
  // Ollama everywhere: one install, uses the GPU (Metal on Macs), and swaps models in and out by itself.
  const tag = (m) => ({ ...m, run: { provider: 'ollama', model: m.ollama } });
  if (!fits.length) {
    notes.push(device.mobile ? 'Phones can’t run a model alongside everything else. Use a free hosted model below, or help by reviewing and rating, which needs no model at all.' : `${where} is too little to run a model alongside your own work. A free hosted model works instead, or help by reviewing and rating.`);
    return { budgetGB: Math.round(budget), runtime: 'none', where, primary: null, verifier: null, alternatives: [], hosted: FREE_HOSTED, notes, updated: CATALOG_UPDATED };
  }
  const primary = tag(fits[0]);
  // A second, different family checks the first one's work: the network never trusts one family alone.
  const v = fits.find((m) => m.family !== primary.family);
  const verifier = v ? tag(v) : null;
  if (!verifier) notes.push('Only one model family fits, so another contributor will verify its work.');
  const alternatives = fits.slice(1).filter((m) => m.id !== verifier?.id).slice(0, 3).map(tag);
  if (device.appleSilicon && primary.mlx) notes.push(`On Apple Silicon, MLX runs the same models faster: mlx_lm.server --model ${primary.mlx}, then --model mlx/${primary.mlx}.`);
  return { budgetGB: Math.round(budget), runtime, where, primary, verifier, alternatives, hosted: FREE_HOSTED, notes, updated: CATALOG_UPDATED };
}

/** How to run Constellate: from the folder it was cloned and built in (Connect page, step 1), until the npm package is published. */
export const RUN = 'node dist/cli.js';

/** The exact commands to get going, for a suggestion. */
export function commands(s) {
  if (!s.primary) return [`${RUN} contribute --model groq/${FREE_HOSTED[0].model}   # needs GROQ_API_KEY (free tier)`];
  const spec = (m) => `${m.run.provider}/${m.run.model}`;
  return [
    `ollama pull ${s.primary.run.model}${s.verifier ? ` && ollama pull ${s.verifier.run.model}` : ''}`,
    `${RUN} contribute --model ${spec(s.primary)}${s.verifier ? ` --verifier ${spec(s.verifier)}` : ''}`,
  ];
}
