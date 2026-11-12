// Types for models.js, shared by the browser app and the command line.
export interface Provider {
  id: string; name: string; kind: 'local' | 'hosted' | 'custom'; baseUrl?: string; keyEnv?: string;
  native?: 'anthropic'; cost: string; openWeight: boolean | 'mixed'; note?: string; example: string; setup?: string;
  /** Pools several computers into one bigger model (exo, or a cluster at urlEnv). */
  cluster?: boolean; urlEnv?: string;
}
export interface OpenModel {
  id: string; name: string; family: string; params: number; active?: number; needGB: number; licence: string; good: string; ollama: string; mlx?: string;
}
export interface Placed extends OpenModel { run: { provider: string; model: string } }
export interface HostedOption { provider: string; model: string; family: string; why: string }
export interface DeviceInfo { memGB: number; appleSilicon?: boolean; gpuGB?: number; mobile?: boolean; cores?: number }
export interface Suggestion {
  budgetGB: number; runtime: 'ollama' | 'none'; where: string;
  primary: Placed | null; verifier: Placed | null; alternatives: Placed[]; hosted: HostedOption[]; notes: string[]; updated: string;
}
export const CATALOG_UPDATED: string;
export const PROVIDERS: Provider[];
export const OPEN_MODELS: OpenModel[];
export const FREE_HOSTED: HostedOption[];
export function familyOf(model?: string): string;
export function parseModelSpec(spec?: string): { provider: Provider; model: string };
export function suggest(device: DeviceInfo): Suggestion;
export const RUN: string;
export function commands(s: Suggestion): string[];
