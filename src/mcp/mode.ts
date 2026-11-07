/**
 * Lean by default: every tool definition costs every agent tokens on every session (47 tools ≈ 6,000 tokens),
 * so agents get the few that carry the value: look things up, share what failed and worked, and bounties (docs/BOUNTIES.md). CONSTELLATE_MCP_TOOLS=full restores everything (docs/STORAGE.md).
 */
export const LEAN_TOOLS = new Set(['failures_search', 'answers_lookup', 'failures_report', 'answers_submit', 'skills_find', 'bounty_post', 'bounties', 'plan_report']);
export const mcpMode = (env: Record<string, string | undefined> = process.env): 'lean' | 'full' => (env.CONSTELLATE_MCP_TOOLS === 'full' ? 'full' : 'lean');
