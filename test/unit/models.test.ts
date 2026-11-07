import { describe, it, expect } from 'vitest';
import { suggest, commands, familyOf, OPEN_MODELS, PROVIDERS } from '../../src/web/public/js/models.js';
import { runnerFromSpec } from '../../src/contributor/catalog.js';

describe('any model, and the right free one for the device', () => {
  it('suggests open-weight models that fit, plus a different family to verify', () => {
    const mac = suggest({ memGB: 36, appleSilicon: true });
    expect(mac.runtime).toBe('ollama');
    expect(mac.notes.join(' ')).toMatch(/MLX runs the same models faster/);
    expect(mac.primary!.needGB).toBeLessThanOrEqual(mac.budgetGB + 0.5);
    expect(mac.verifier!.family).not.toBe(mac.primary!.family);

    const gamer = suggest({ memGB: 32, gpuGB: 24 });
    expect(gamer.primary!.id).toBe('qwen3-32b');
    expect(gamer.primary!.run.provider).toBe('ollama');

    const laptop = suggest({ memGB: 8 });
    expect(laptop.primary!.needGB).toBeLessThanOrEqual(3.6);
    expect(laptop.notes.join(' ')).toMatch(/No dedicated GPU/);

    for (const d of [{ memGB: 4 }, { memGB: 6, mobile: true }]) {
      const s = suggest(d);
      expect(s.primary).toBeNull();
      expect(s.hosted.length).toBeGreaterThan(0); // free hosted options instead
      expect(commands(s)[0]).toMatch(/--model groq\//);
    }
  });

  it('gives exact commands', () => {
    expect(commands(suggest({ memGB: 32, gpuGB: 24 }))).toEqual(['ollama pull qwen3:32b && ollama pull gemma3:27b', 'constellate contribute --model ollama/qwen3:32b --verifier ollama/gemma3:27b']);
  });

  it('every listed model names a real family and fits its own budget maths', () => {
    for (const m of OPEN_MODELS) { expect(familyOf(m.ollama)).toBe(m.family); expect(m.needGB).toBeGreaterThan(0); }
    expect(new Set(PROVIDERS.map((p) => p.id)).size).toBe(PROVIDERS.length);
  });

  it('runs any model from one string', () => {
    const env = { GROQ_API_KEY: 'k', ANTHROPIC_API_KEY: 'a', OPENROUTER_API_KEY: 'o' };
    expect(runnerFromSpec('ollama/qwen3:14b', { env })).toMatchObject({ id: 'ollama:qwen3:14b', family: 'qwen', costPerCall: 0, size: 'small' });
    expect(runnerFromSpec('qwen3:8b', { env }).id).toBe('ollama:qwen3:8b'); // a bare name means Ollama
    expect(runnerFromSpec('groq/llama-3.3-70b-versatile', { env })).toMatchObject({ family: 'llama', costPerCall: 0, size: 'large' });
    expect(runnerFromSpec('openrouter/deepseek/deepseek-r1:free', { env })).toMatchObject({ id: 'openrouter:deepseek/deepseek-r1:free', family: 'deepseek' });
    expect(runnerFromSpec('anthropic/claude-opus-5-5', { env })).toMatchObject({ family: 'claude', costPerCall: 2 });
    expect((runnerFromSpec('mlx/mlx-community/Qwen3-8B-4bit@8081', { env }) as unknown as { baseUrl: string }).baseUrl).toBe('http://127.0.0.1:8081/v1');
    expect(() => runnerFromSpec('openai/gpt-5', { env })).toThrow(/OPENAI_API_KEY/);
    expect(() => runnerFromSpec('custom/my-model', { env })).toThrow(/--endpoint/);
    expect(runnerFromSpec('custom/my-model', { env, endpoint: 'http://gpu-box:9000/v1' }).id).toBe('custom:my-model');
  });
});
