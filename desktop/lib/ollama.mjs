// Ollama runs the free, open models on this computer. Constellate never installs it silently:
// the app links to ollama.com, then downloads a model only when the person asks.
const BASE = process.env.OLLAMA_HOST ? (process.env.OLLAMA_HOST.startsWith('http') ? process.env.OLLAMA_HOST : `http://${process.env.OLLAMA_HOST}`) : 'http://127.0.0.1:11434';

export const OLLAMA_DOWNLOAD = 'https://ollama.com/download';

/** Is Ollama running, and which models does it already have? */
export async function ollamaStatus(base = BASE) {
  try {
    const r = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return { running: false, models: [] };
    const j = await r.json();
    return { running: true, models: (j.models ?? []).map((m) => m.name) };
  } catch { return { running: false, models: [] }; }
}

/** Has Ollama got this model? ("qwen3:8b" matches "qwen3:8b"; "qwen3" matches "qwen3:latest".) */
export const hasModel = (models, want) => models.some((m) => m === want || m === `${want}:latest`);

/** Download a model, reporting progress as 0..1. Resolves when Ollama says it's done. */
export async function pullModel(model, onProgress = () => {}, base = BASE) {
  const r = await fetch(`${base}/api/pull`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, stream: true }) });
  if (!r.ok || !r.body) throw new Error(`Ollama couldn't download ${model} (${r.status})`);
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of r.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      const m = JSON.parse(line);
      if (m.error) throw new Error(m.error);
      if (m.total) onProgress(Math.min(1, (m.completed ?? 0) / m.total), m.status);
      if (m.status === 'success') { onProgress(1, 'success'); return; }
    }
  }
}
