/**
 * Lean by default: every tool definition costs every agent tokens on every session (44 tools ≈ 6,000 tokens),
 * so agents get the five that carry the value. CONSTELLATE_MCP_TOOLS=full restores everything (docs/STORAGE.md).
 */
export const LEAN_TOOLS = new Set(['failures_search', 'answers_lookup', 'failures_report', 'answers_submit', 'skills_find']);
export const mcpMode = (env: Record<string, string | undefined> = process.env): 'lean' | 'full' => (env.CONSTELLATE_MCP_TOOLS === 'full' ? 'full' : 'lean');
