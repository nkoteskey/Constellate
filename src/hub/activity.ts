import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

/**
 * What the agents connected on THIS computer have been doing with Constellate, so the app can say
 * "Claude Code checked the network 14 times today and found 9 lessons". Agents run Constellate's
 * MCP server in their own process; each tool call appends one line here, and the app reads it.
 *
 * Private by construction: it stays on this machine (never published), and records only which
 * agent, which tool, how many results, and public record ids. Never the agent's query or inputs.
 */
export interface ActivityEvent { at: string; client: string; tool: string; kind: 'lookup' | 'share' | 'work' | 'other'; results?: number; ids?: string[] }

const LOOKUPS = new Set(['failures_search', 'answers_lookup', 'skills_find', 'graph_recall', 'problems_status', 'problems_list', 'handoff_check']);
const SHARES = new Set(['failures_report', 'answers_submit', 'skills_publish', 'proposals_submit', 'records_link', 'help_request']);
const WORK = new Set(['queue_get', 'review_request', 'votes_cast', 'confirm', 'records_confirm', 'work_step']);
const KEEP = 4000; // lines read back; older history is summarised by the counts that matter

/** Friendly names for the MCP clients people use. */
export function clientName(raw?: string): string {
  const n = (raw ?? '').toLowerCase();
  if (!n) return 'An agent';
  if (n.includes('claude-code') || n === 'claude code') return 'Claude Code';
  if (n.includes('claude')) return 'Claude Desktop';
  if (n.includes('cursor')) return 'Cursor';
  if (n.includes('windsurf')) return 'Windsurf';
  if (n.includes('visual studio code') || n.includes('vscode') || n === 'code') return 'VS Code';
  if (n.includes('gemini')) return 'Gemini CLI';
  if (n.includes('codex')) return 'OpenAI Codex';
  if (n.includes('qwen')) return 'Qwen Code';
  if (n.includes('lm studio') || n.includes('lmstudio')) return 'LM Studio';
  if (n.includes('goose')) return 'Goose';
  if (n.includes('zed')) return 'Zed';
  if (n.includes('perplexity')) return 'Perplexity';
  return raw!.slice(0, 40);
}

export class ActivityLog {
  constructor(readonly file = join(process.env.CONSTELLATE_HOME ?? join(homedir(), '.constellate'), 'agent-activity.jsonl')) {}

  record(client: string | undefined, tool: string, result?: unknown) {
    const kind = LOOKUPS.has(tool) ? 'lookup' : SHARES.has(tool) ? 'share' : WORK.has(tool) ? 'work' : 'other';
    const list = Array.isArray(result) ? result : (result as { results?: unknown[] } | undefined)?.results;
    const ids = Array.isArray(list) ? list.map((r) => (r as { id?: string })?.id).filter((x): x is string => typeof x === 'string' && /^[0-9a-f]{64}$/.test(x)).slice(0, 5) : undefined;
    const shared = (result as { id?: string; published?: string } | undefined);
    const e: ActivityEvent = { at: new Date().toISOString(), client: clientName(client), tool, kind, ...(Array.isArray(list) ? { results: list.length } : {}), ...(ids?.length ? { ids } : kind === 'share' && typeof (shared?.published ?? shared?.id) === 'string' ? { ids: [String(shared!.published ?? shared!.id)] } : {}) };
    try { mkdirSync(dirname(this.file), { recursive: true }); appendFileSync(this.file, JSON.stringify(e) + '\n'); } catch { /* activity is best-effort; never break a tool call */ }
  }

  /** Events appended since `from` (a byte offset), and where to read from next time. */
  since(from: number): { events: ActivityEvent[]; next: number } {
    try {
      const size = statSync(this.file).size;
      if (size < from) return { events: [], next: size }; // the file was replaced
      if (size === from) return { events: [], next: from };
      const buf = readFileSync(this.file).subarray(from);
      const end = buf.lastIndexOf(10) + 1; // only whole lines (offsets are in bytes)
      const events = buf.subarray(0, end).toString('utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) as ActivityEvent; } catch { return null; } }).filter((x): x is ActivityEvent => !!x);
      return { events, next: from + end };
    } catch { return { events: [], next: from }; }
  }
  size(): number { try { return statSync(this.file).size; } catch { return 0; } }

  events(): ActivityEvent[] {
    if (!existsSync(this.file)) return [];
    try {
      const size = statSync(this.file).size;
      const text = readFileSync(this.file, 'utf8');
      const lines = (size > 2_000_000 ? text.slice(-1_000_000) : text).split('\n').filter(Boolean).slice(-KEEP);
      return lines.map((l) => { try { return JSON.parse(l) as ActivityEvent; } catch { return null; } }).filter((x): x is ActivityEvent => !!x);
    } catch { return []; }
  }

  /** Per agent: when it was last seen, and what it did today and in total. Plus the latest events. */
  summary(now = Date.now()) {
    const ev = this.events();
    const day = now - 86_400_000;
    const agents = new Map<string, { client: string; last: string; lookups: number; found: number; shared: number; today: { lookups: number; found: number; shared: number } }>();
    for (const e of ev) {
      const a = agents.get(e.client) ?? { client: e.client, last: e.at, lookups: 0, found: 0, shared: 0, today: { lookups: 0, found: 0, shared: 0 } };
      if (e.at > a.last) a.last = e.at;
      const t = Date.parse(e.at) > day;
      if (e.kind === 'lookup') { a.lookups++; if (t) a.today.lookups++; if (e.results) { a.found += e.results > 0 ? 1 : 0; if (t && e.results > 0) a.today.found++; } }
      if (e.kind === 'share') { a.shared++; if (t) a.today.shared++; }
      agents.set(e.client, a);
    }
    return { agents: [...agents.values()].sort((a, b) => b.last.localeCompare(a.last)), recent: ev.slice(-20).reverse() };
  }
}
