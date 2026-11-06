import { AnthropicRunner, Budget, ModelRunner, OpenAICompatibleRunner, ModelSize } from './models.js';
import { KeyVault } from './keyvault.js';

/**
 * Mix local and cloud models and route each task to whichever fits:
 * right size, a different family when verification demands it, local first
 * (free), then the cheapest affordable cloud model. Spend is tracked per model
 * against the user's cap.
 */
export interface TaskNeeds { size: ModelSize | 'any'; notFamily?: string; preferFamily?: string }

export class ModelRouter {
  constructor(readonly runners: ModelRunner[], readonly budget: Budget, readonly perModelCap: Record<string, number> = {}) {}

  private spentOn(id: string) { return (this.budget.report().by_model as Record<string, number>)[id] ?? 0; }
  private affordable(r: ModelRunner) { return this.budget.canAfford(r) && (this.perModelCap[r.id] === undefined || this.spentOn(r.id) + r.costPerCall <= this.perModelCap[r.id]); }

  pick(n: TaskNeeds): ModelRunner | null {
    const fit = this.runners.filter((r) => (n.size === 'any' || r.size === n.size) && r.family !== n.notFamily && this.affordable(r));
    fit.sort((a, b) => (a.costPerCall - b.costPerCall) || (Number(b.family === n.preferFamily) - Number(a.family === n.preferFamily)));
    return fit[0] ?? null;
  }

  async run(n: TaskNeeds, prompt: string) {
    const r = this.pick(n);
    if (!r) throw new Error('no model fits this task within your spending cap');
    this.budget.charge(r);
    return { model: r.id, family: r.family, output: await r.run(prompt) };
  }

  /** What each model has spent against the cap, for the contributor app's status view. */
  spend() {
    const rep = this.budget.report();
    return { cap_cents: rep.cap_cents, spent_cents: rep.spent_cents, models: this.runners.map((r) => ({ id: r.id, family: r.family, local: r.costPerCall === 0, spent_cents: this.spentOn(r.id), cap_cents: this.perModelCap[r.id] ?? null })) };
  }
}

/** Cloud models by API key (stored encrypted on this device only, never broadcast). */
export function cloudRunners(vault: KeyVault): ModelRunner[] {
  const out: ModelRunner[] = [];
  const k = (n: string) => vault.get(n);
  if (k('anthropic')) out.push(new AnthropicRunner('anthropic:claude-opus-5-5', 'claude-opus-5-5', 'large', 2, k('anthropic')));
  if (k('openai')) out.push(new OpenAICompatibleRunner('openai:gpt', 'openai', 'large', 'https://api.openai.com/v1', process.env.CONSTELLATE_OPENAI_MODEL ?? 'gpt-5', k('openai'), 2));
  if (k('gemini')) out.push(new OpenAICompatibleRunner('google:gemini', 'gemini', 'large', 'https://generativelanguage.googleapis.com/v1beta/openai', process.env.CONSTELLATE_GEMINI_MODEL ?? 'gemini-2.5-pro', k('gemini'), 2));
  if (k('openrouter')) out.push(new OpenAICompatibleRunner('openrouter', process.env.CONSTELLATE_OPENROUTER_FAMILY ?? 'openrouter', 'large', 'https://openrouter.ai/api/v1', process.env.CONSTELLATE_OPENROUTER_MODEL ?? 'meta-llama/llama-3.3-70b-instruct', k('openrouter'), 1));
  return out;
}
