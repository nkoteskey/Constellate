import { errorQuery, openLedgerReadOnly, suggestFixes, formatSuggestions } from './watch.js';

/**
 * The Claude Code hook (docs/HOOKS.md): registered on PostToolUseFailure with matcher "Bash", it receives the
 * failed call on stdin ({ tool_name, tool_input: { command }, error: "Exit code N\n<output>", is_interrupt })
 * and answers with JSON whose additionalContext Claude sees next to the error: the fixes others verified.
 *
 * It reads this computer's ledger and nothing else. It never publishes, never signs, never sends the error
 * anywhere. Anything it can't parse, an interrupt, or no match, and it answers with nothing.
 */
export async function claudeCodeHook(stdin: string, env: Record<string, string | undefined> = process.env): Promise<string> {
  let ev: { hook_event_name?: string; tool_name?: string; tool_input?: { command?: string }; error?: string; is_interrupt?: boolean; tool_response?: { stdout?: string; stderr?: string; exit_code?: number; exitCode?: number } };
  try { ev = JSON.parse(stdin); } catch { return ''; }
  if (ev.tool_name !== 'Bash' || ev.is_interrupt) return '';
  const event = ev.hook_event_name ?? 'PostToolUseFailure';
  let output = '';
  if (typeof ev.error === 'string') {
    // "Exit code N" first, then the command's output. Exit code 0 (or none) isn't a failed command.
    const m = /^Exit code (\d+)/.exec(ev.error);
    if (m && m[1] === '0') return '';
    output = ev.error.replace(/^Exit code \d+\r?\n?/, '');
  } else if (ev.tool_response) {
    const code = ev.tool_response.exit_code ?? ev.tool_response.exitCode;
    if (code === 0 || code === undefined) return '';
    output = `${ev.tool_response.stdout ?? ''}\n${ev.tool_response.stderr ?? ''}`;
  } else return '';
  const query = errorQuery(output, ev.tool_input?.command ?? '');
  if (!query) return '';
  const fixes = suggestFixes(openLedgerReadOnly(env), query);
  if (!fixes.length) return '';
  return JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: formatSuggestions(fixes, query).trim() } }) + '\n';
}
