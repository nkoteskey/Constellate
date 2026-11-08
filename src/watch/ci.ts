import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { errorQuery, openLedgerReadOnly, suggestFixes, Suggestion } from './watch.js';

/**
 * The CI side of "fixes that arrive when the error happens" (action.yml, docs/CI_ACTION.md).
 *
 * A red run: the failed command's output is cleaned on the runner and searched against the ledger the npm
 * package carries (the starter library); the fixes others verified go into the job summary and an annotation.
 * The next green run on the same workflow, job and branch: the summary says what was fixed and since which
 * commit, and gives the agent or person who fixed it what they need to tell the network whether a suggested
 * fix worked.
 *
 * Like `watch` and the hook, it only reads: nothing is signed, published or sent anywhere. The one thing it keeps
 * is a small state file (restored between runs by actions/cache): whether the last run failed, its cleaned
 * error and the fix ids suggested.
 */
export interface CiState { failed: boolean; query: string; fixes: { id: string; fix: string; trust: string }[]; sha: string; at: string }
export interface CiReport { summary: string; annotations: string[]; state: CiState; outputs: Record<string, string> }

const esc = (s: string) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const md = (s: string) => s.replace(/\s+/g, ' ').replace(/([\\`*_[\]|<>])/g, '\\$1').trim();
const short = (sha: string) => sha.slice(0, 7);

export function ciReport(opts: { log: string; exitCode: number; command?: string; prev?: CiState | null; sha?: string; find: (query: string) => Suggestion[]; now?: Date }): CiReport {
  const sha = opts.sha ?? '';
  const at = (opts.now ?? new Date()).toISOString();
  const lines: string[] = ['### Constellate'];
  const annotations: string[] = [];

  if (opts.exitCode !== 0) {
    const query = errorQuery(opts.log, opts.command ?? '');
    const fixes = query ? opts.find(query) : [];
    const verified = fixes.some((f) => f.verified);
    if (fixes.length) {
      lines.push('', `**${verified ? 'Fixes other agents verified' : 'Possible fixes (not yet verified)'}** for this error:`, '');
      fixes.forEach((f, i) => lines.push(`${i + 1}. ${md(f.fix).slice(0, 400)}`, `   - for: ${md(f.for).slice(0, 200)}`, `   - ${md(f.trust)} · id \`${f.id}\``));
      lines.push('', 'Tried one? Once it works, tell the network with `fix_tried` (id, `worked: true`, your environment). Fixes confirmed on other computers rank first, and the next team skips this error.');
      annotations.push(`::warning title=Constellate: ${verified ? 'a verified fix' : 'a possible fix'} for this error::${esc(`${fixes[0].fix.replace(/\s+/g, ' ').slice(0, 300)} (${fixes[0].trust}; ${fixes.length} in the job summary)`)}`);
    } else {
      lines.push('', 'Nothing on the network matches this error yet. When you fix it, share the fix (`answers_submit`), so the next team finds it.');
    }
    if (query) lines.push('', `<sub>Searched with the cleaned error, which never left this runner: ${md(query).slice(0, 300)}</sub>`);
    const state: CiState = { failed: true, query, fixes: fixes.map((f) => ({ id: f.id, fix: f.fix.slice(0, 300), trust: f.trust })), sha, at };
    return { summary: lines.join('\n') + '\n', annotations, state, outputs: { fixes: JSON.stringify(state.fixes), fixed_since_red: 'false', suggested: String(fixes.length) } };
  }

  // Green. If the last run here was red, say what got fixed, and how to report it.
  const prev = opts.prev?.failed ? opts.prev : null;
  if (prev) {
    lines.push('', `**Fixed since the last red run**${prev.sha ? ` (\`${short(prev.sha)}\` → \`${short(sha)}\`)` : ''}: ${md(prev.query).slice(0, 300) || 'the earlier failure'}`);
    if (prev.fixes.length) {
      lines.push('', 'Constellate had suggested:', '');
      prev.fixes.forEach((f, i) => lines.push(`${i + 1}. ${md(f.fix).slice(0, 300)} (${md(f.trust)}) · id \`${f.id}\``));
      lines.push('', `If one of these is what fixed it, tell the network: \`fix_tried\` with that id, \`worked: true\`, your environment and \`error_before\`. If it was fixed another way, share that fix with \`answers_submit\`.`);
    } else {
      lines.push('', 'Nothing on the network matched it. Share the fix with `answers_submit` so the next team finds it.');
    }
    annotations.push(`::notice title=Constellate: fixed since the last red run::${esc(`${prev.query.slice(0, 200)}${prev.fixes.length ? ` (did a suggested fix work? See the job summary.)` : ''}`)}`);
  }
  const state: CiState = { failed: false, query: '', fixes: [], sha, at };
  return { summary: prev ? lines.join('\n') + '\n' : '', annotations, state, outputs: { fixes: '[]', fixed_since_red: String(!!prev), suggested: '0' } };
}

/** `constellate ci --log FILE --exit-code N [--command CMD] [--state FILE] [--sha SHA]`: summary, annotations, outputs. */
export function ciCommand(args: string[], env: Record<string, string | undefined> = process.env, out: (s: string) => void = (s) => process.stdout.write(s)): number {
  const flag = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const logFile = flag('--log'), exitCode = Number(flag('--exit-code') ?? NaN);
  if (!logFile || !Number.isInteger(exitCode)) throw new Error('usage: constellate ci --log FILE --exit-code N [--command CMD] [--state FILE] [--sha SHA]');
  const log = existsSync(logFile) ? readFileSync(logFile, 'utf8').slice(-200_000) : '';
  const stateFile = flag('--state');
  let prev: CiState | null = null;
  try { prev = stateFile && existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) as CiState : null; } catch { prev = null; }
  const hub = exitCode !== 0 ? openLedgerReadOnly(env) : null;
  const r = ciReport({ log, exitCode, command: flag('--command'), prev, sha: flag('--sha') ?? env.GITHUB_SHA, find: (q) => (hub ? suggestFixes(hub, q) : []) });
  for (const a of r.annotations) out(a + '\n');
  if (r.summary && env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, r.summary);
  else if (r.summary) out(r.summary);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, Object.entries(r.outputs).map(([k, v]) => `${k}=${v.replace(/\n/g, ' ')}`).join('\n') + '\n');
  if (stateFile) { mkdirSync(dirname(stateFile), { recursive: true }); writeFileSync(stateFile, JSON.stringify(r.state)); }
  return 0;
}
