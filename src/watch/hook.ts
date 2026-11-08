import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { errorQuery, openLedgerReadOnly, suggestFixes, formatSuggestions, cleanForSearch, Suggestion } from './watch.js';

/**
 * The Claude Code hook (docs/HOOKS.md).
 *
 * - On PostToolUseFailure (matcher "Bash") it receives the failed call on stdin ({ tool_name, tool_input: { command },
 *   error: "Exit code N\n<output>", is_interrupt }) and answers with JSON whose additionalContext Claude sees next
 *   to the error: the fixes others verified.
 * - On PostToolUse (matcher "Bash"), when the same command now succeeds in the same session after fixes were
 *   suggested, it asks the agent once to say whether the fix worked (fix_tried). That report is what makes fixes
 *   rank and what the hit rate counts, so the loop closes where the work happened.
 *
 * It never publishes, never signs, never sends the error anywhere. The one thing it writes is a small note on
 * this computer (hook-pending.json): the command's first words, the cleaned error and the suggested fix ids, so
 * it can ask the follow-up question. Notes expire after two hours. Anything it can't parse, an interrupt, or no
 * match, and it answers with nothing.
 */
type HookEvent = {
  hook_event_name?: string; session_id?: string; tool_name?: string; tool_input?: { command?: string }; error?: string; is_interrupt?: boolean;
  tool_response?: { stdout?: string; stderr?: string; exit_code?: number; exitCode?: number; interrupted?: boolean };
};
interface Pending { session: string; command: string; query: string; fixes: { id: string; fix: string }[]; at: number }
const TTL = 2 * 3600_000;
const MAX_PENDING = 20;

/** The command's first few words, cleaned: enough to recognise a rerun, never the whole command. */
export function commandKey(command: string) {
  return cleanForSearch(command).trim().split(/\s+/).filter((w) => !/^-/.test(w)).slice(0, 3).join(' ').toLowerCase().slice(0, 80);
}

function pendingFile(env: Record<string, string | undefined>) {
  return join(env.CONSTELLATE_HOME ?? join(homedir(), '.constellate'), 'hook-pending.json');
}
function readPending(env: Record<string, string | undefined>, now: number): Pending[] {
  try { const f = pendingFile(env); return existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')) as Pending[]).filter((p) => now - p.at < TTL) : []; } catch { return []; }
}
function writePending(env: Record<string, string | undefined>, list: Pending[]) {
  try { const f = pendingFile(env); mkdirSync(join(f, '..'), { recursive: true }); writeFileSync(f, JSON.stringify(list.slice(-MAX_PENDING))); } catch { /* a note we couldn't keep only means no follow-up */ }
}

/** What the agent sees when a command that failed now passes: one question, with everything fix_tried needs. */
export function followUp(p: Pending): string {
  const one = p.fixes.length === 1;
  return [
    `constellate: this command failed earlier in this session, and Constellate suggested ${one ? 'a fix' : 'fixes'} for it. It passes now.`,
    ...p.fixes.map((f, i) => `  ${one ? '' : `${i + 1}. `}${f.fix.replace(/\s+/g, ' ').slice(0, 200)} (id ${f.id})`),
    `If you applied ${one ? 'it' : 'one of them'}, tell the network it worked: call fix_tried with that id, worked: true, your environment, and error_before: "${p.query.slice(0, 200).replace(/"/g, "'")}".`,
    `If you fixed it another way, share that fix with answers_submit so the next agent finds it. Either way, this is the only time you'll be asked.`,
  ].join('\n');
}

export async function claudeCodeHook(stdin: string, env: Record<string, string | undefined> = process.env, now = Date.now()): Promise<string> {
  let ev: HookEvent;
  try { ev = JSON.parse(stdin); } catch { return ''; }
  if (ev.tool_name !== 'Bash' || ev.is_interrupt || ev.tool_response?.interrupted) return '';
  const event = ev.hook_event_name ?? 'PostToolUseFailure';
  const session = ev.session_id ?? 'default';
  const command = ev.tool_input?.command ?? '';
  const answer = (text: string) => JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text.trim() } }) + '\n';

  let output = '';
  let failed: boolean;
  if (typeof ev.error === 'string') {
    // "Exit code N" first, then the command's output. Exit code 0 (or none) isn't a failed command.
    const m = /^Exit code (\d+)/.exec(ev.error);
    failed = !(m && m[1] === '0');
    output = ev.error.replace(/^Exit code \d+\r?\n?/, '');
  } else if (ev.tool_response) {
    const code = ev.tool_response.exit_code ?? ev.tool_response.exitCode;
    failed = event === 'PostToolUseFailure' ? code !== 0 : code !== undefined && code !== 0;
    output = `${ev.tool_response.stdout ?? ''}\n${ev.tool_response.stderr ?? ''}`;
  } else return '';

  // A success: if this command failed earlier with fixes suggested, ask once whether one worked.
  if (!failed) {
    if (event !== 'PostToolUse') return '';
    const key = commandKey(command);
    const list = readPending(env, now);
    const i = list.findIndex((p) => p.session === session && p.command === key);
    if (i < 0 || !key) return '';
    const [p] = list.splice(i, 1);
    writePending(env, list);
    return answer(followUp(p));
  }

  const query = errorQuery(output, command);
  if (!query) return '';
  const fixes: Suggestion[] = suggestFixes(openLedgerReadOnly(env), query);
  if (!fixes.length) return '';
  const key = commandKey(command);
  if (key) writePending(env, [...readPending(env, now).filter((p) => !(p.session === session && p.command === key)), { session, command: key, query, fixes: fixes.map((f) => ({ id: f.id, fix: f.fix.slice(0, 300) })), at: now }]);
  return answer(formatSuggestions(fixes, query));
}
