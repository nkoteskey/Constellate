/**
 * Models are brought by contributors; x0x runs none itself. A runner is a
 * model plus how to call it. Tasks say what they need ("any small model",
 * "strong reasoning model") and some require a different family on purpose.
 */
export type ModelSize = 'small' | 'large';

export interface ModelRunner {
  /** e.g. "mlx:qwen3-8b-4bit", "anthropic:claude-opus-5-5" */
  readonly id: string;
  /** Model family, used to force cross-family verification. */
  readonly family: string;
  readonly size: ModelSize;
  /** Estimated cost per call in US cents (0 for local models). */
  readonly costPerCall: number;
  run(prompt: string, opts?: { maxTokens?: number; system?: string }): Promise<string>;
}

/** Any OpenAI-compatible chat endpoint: Ollama, mlx_lm.server, LM Studio, OpenRouter, OpenAI, Gemini's compat endpoint, self-hosted. */
export class OpenAICompatibleRunner implements ModelRunner {
  constructor(
    readonly id: string,
    readonly family: string,
    readonly size: ModelSize,
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly apiKey?: string,
    readonly costPerCall = 0,
  ) {}
  async run(prompt: string, opts: { maxTokens?: number; system?: string } = {}) {
    const res = await fetch(`${this.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
      body: JSON.stringify({
        model: this.model,
        max_tokens: opts.maxTokens ?? 2048,
        messages: [...(opts.system ? [{ role: 'system', content: opts.system }] : []), { role: 'user', content: prompt }],
      }),
    });
    if (!res.ok) throw new Error(`${this.id}: HTTP ${res.status}`);
    const j = (await res.json()) as { choices: { message: { content: string } }[] };
    return j.choices[0]?.message?.content ?? '';
  }
}

/** Claude through the Anthropic SDK, on the person's API key (never a Claude plan). Loaded lazily so the hub has no hard dependency. */
export class AnthropicRunner implements ModelRunner {
  readonly family = 'claude';
  constructor(readonly id = 'anthropic:claude-opus-5-5', private readonly model = 'claude-opus-5-5', readonly size: ModelSize = 'large', readonly costPerCall = 2, private readonly apiKey?: string) {}
  async run(prompt: string, opts: { maxTokens?: number; system?: string } = {}) {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic(this.apiKey ? { apiKey: this.apiKey } : {});
    const r = await client.messages.create({ model: this.model, max_tokens: opts.maxTokens ?? 16000, system: opts.system, messages: [{ role: 'user', content: prompt }] });
    if (r.stop_reason === 'refusal') throw new Error(`${this.id}: refused`);
    return r.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
  }
}

/** Deterministic stand-in for tests and demos. */
export class MockRunner implements ModelRunner {
  calls = 0;
  constructor(readonly id: string, readonly family: string, readonly size: ModelSize, private readonly fn: (prompt: string, n: number) => string | Promise<string>, readonly costPerCall = 0) {}
  async run(prompt: string) { return this.fn(prompt, this.calls++); }
}

/** Spend caps for paid models: the app stops at the cap. */
export class Budget {
  private spent = new Map<string, number>();
  constructor(public capCents: number) {}
  total() { let t = 0; for (const v of this.spent.values()) t += v; return t; }
  canAfford(r: ModelRunner) { return this.total() + r.costPerCall <= this.capCents; }
  charge(r: ModelRunner) {
    if (!this.canAfford(r)) throw new Error(`budget cap reached (${this.total()}¢ of ${this.capCents}¢)`);
    this.spent.set(r.id, (this.spent.get(r.id) ?? 0) + r.costPerCall);
  }
  report() { return { cap_cents: this.capCents, spent_cents: this.total(), by_model: Object.fromEntries(this.spent) }; }
}
