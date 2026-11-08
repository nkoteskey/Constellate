import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { redactPersonal } from '../privacy/redact.js';
import { Hub } from '../hub/hub.js';
import { RecordStore } from '../store/records.js';
import { LocalSigner } from '../core/identity.js';
import { importSnapshot } from '../seed/snapshot.js';

/**
 * Fixes that arrive when the error happens (docs/HOOKS.md).
 *
 * `constellate watch -- <command>` runs a command as usual. If it fails, the error output is cleaned on this
 * computer (personal data and secrets removed, paths cut to file names) and used to search the ledger this
 * computer already holds. The best matching fixes others have verified are printed under the output.
 *
 * Nothing is published, ever: watch opens the ledger read-only, with a throwaway identity that can't sign.
 */

const SECRETS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\b[Bb]earer\s+[A-Za-z0-9._~+/-]{16,}=*/g,
  /\b(pass(word|wd)?|secret|api[_-]?key|token|auth)\s*[:=]\s*["']?[^\s"',;]{6,}/gi,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/gi,
  /\b[A-Za-z0-9+/_-]{40,}={0,2}/g, // long tokens of any kind
];

/** The error output, cleaned for searching: no secrets, no personal data, paths cut to their file name. */
export function cleanForSearch(text: string): string {
  let s = text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''); // terminal colours
  for (const re of SECRETS) s = s.replace(re, ' ');
  s = redactPersonal(s);
  s = s.replace(/(?:[A-Za-z]:)?(?:[\\/][\w.@+-]+)+[\\/]([\w.@+-]+)/g, '$1'); // /any/path/to/file.ts → file.ts
  s = s.replace(/\b\d{1,3}(\.\d{1,3}){3}(:\d+)?\b/g, ' '); // addresses
  s = s.replace(/\b[0-9a-f]{12,}\b/gi, ' '); // hashes and ids
  return s.replace(/[<>]\w+[<>]?/g, ' ').replace(/[ \t]+/g, ' ');
}

const ERRORISH = /\b(error|errors|failed|failure|fatal|panic(ked)?|exception|traceback|cannot|can't|could not|couldn't|not found|no such|undefined|denied|refused|timed? ?out|segmentation|abort(ed)?|killed|exit (code|status))\b|^E\d{3,}|✗|×/i;

/** The few lines that say what went wrong, as a search query (at most 500 characters). */
export function errorQuery(output: string, command = ''): string {
  const lines = cleanForSearch(output).split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 2 && /[A-Za-z]{3}/.test(l));
  const tail = lines.slice(-200);
  const hits = tail.filter((l) => ERRORISH.test(l));
  const picked = [...new Set((hits.length ? hits.slice(0, 3).concat(hits.slice(-3)) : tail.slice(-6)))];
  const tool = cleanForSearch(command).trim().split(/\s+/)[0] ?? '';
  return [tool, ...picked].join(' ').replace(/\s+/g, ' ').trim().slice(0, 500);
}

export interface Suggestion { id: string; fix: string; for: string; trust: string; verified: boolean }

/** The best matching fixes, verified ones first: confirmed by others, or merged upstream. */
export function suggestFixes(hub: Hub, query: string, limit = 3): Suggestion[] {
  if (!query) return [];
  const out = new Map<string, Suggestion>();
  const trustOf = (confirmed: string | null | undefined, confirmations: number, proof?: string) =>
    confirmed ? { trust: confirmed, verified: true } : confirmations ? { trust: `${confirmations} independent confirmation${confirmations === 1 ? '' : 's'}`, verified: true }
      : /merged pull request/.test(proof ?? '') ? { trust: 'fix merged upstream', verified: true } : { trust: 'not yet confirmed by anyone else', verified: false };
  for (const f of hub.ledger.searchFailures(query, { limit: 4 })) {
    for (const x of f.fixes) {
      const a = hub.node.store.get(x.id);
      const proof = (a?.rec.body as { proof?: { detail?: string } } | undefined)?.proof?.detail;
      if (!out.has(x.id)) out.set(x.id, { id: x.id, fix: x.fix, for: f.error_summary || f.approach, ...trustOf(x.confirmed, a ? hub.trust.explain(a).confirmations : 0, proof) });
    }
  }
  for (const a of hub.ledger.lookupAnswers(query, { limit: 4 })) {
    if (!out.has(a.id)) out.set(a.id, { id: a.id, fix: (a.headline ?? a.answer).slice(0, 300), for: a.question, ...trustOf(a.confirmed, a.confirmations, a.proof?.detail) });
  }
  const all = [...out.values()];
  const verified = all.filter((s) => s.verified);
  // Verified fixes first; if none matched, at most two unconfirmed ones, labelled as such.
  return (verified.length ? verified : all.slice(0, 2)).slice(0, limit);
}

/** This computer's ledger, read-only: what `constellate mcp` and the app keep, plus the bundled starter library. */
export function openLedgerReadOnly(env: Record<string, string | undefined> = process.env): Hub {
  const home = env.CONSTELLATE_HOME ?? join(homedir(), '.constellate');
  const store = new RecordStore(existsSync(join(home, 'records')) ? join(home, 'records') : undefined);
  const bundled = fileURLToPath(new URL('../../starter/starter.cbor', import.meta.url));
  const starter = env.CONSTELLATE_STARTER === 'off' ? undefined : env.CONSTELLATE_STARTER ?? (existsSync(bundled) ? bundled : undefined);
  if (starter && existsSync(starter) && !existsSync(join(home, 'starter-imported'))) {
    try { importSnapshot(readFileSync(starter), store, false); } catch { /* the starter is a bonus, never required */ }
  }
  return new Hub({ signer: LocalSigner.generate(), store, readOnly: true, preview: true });
}

/** What to print under a failed command. */
export function formatSuggestions(s: Suggestion[], query: string): string {
  if (!s.length) return `constellate: nothing on the network matches this error yet. Once you fix it, share the fix (answers_submit) so the next agent doesn't have to.\n`;
  const lines = [`constellate: ${s.some((x) => x.verified) ? 'fixes others verified' : 'possible fixes (not yet verified)'} for this error:`];
  s.forEach((x, i) => lines.push(`  ${i + 1}. ${x.fix.replace(/\s+/g, ' ').slice(0, 300)}`, `     for: ${x.for.replace(/\s+/g, ' ').slice(0, 160)}`, `     ${x.trust} · id ${x.id.slice(0, 12)}`));
  lines.push(`  Tried one? Tell the network whether it worked: fix_tried with its id (from your agent), or confirm it in the app.`);
  void query;
  return lines.join('\n') + '\n';
}

/**
 * Run a command, passing its output through. On a non-zero exit, print the best matching verified fixes to
 * stderr. Resolves to the command's own exit code.
 */
export async function watch(argv: string[], opts: { env?: Record<string, string | undefined>; out?: NodeJS.WritableStream; err?: NodeJS.WritableStream; json?: boolean } = {}): Promise<number> {
  if (!argv.length) throw new Error('say which command to run: constellate watch -- <command> [args…]');
  const out = opts.out ?? process.stdout, err = opts.err ?? process.stderr;
  const MAX = 64 * 1024;
  let tail = '';
  const keep = (d: Buffer) => { tail = (tail + d.toString('utf8')).slice(-MAX); };
  const child = spawn(argv[0], argv.slice(1), { stdio: ['inherit', 'pipe', 'pipe'], env: { ...process.env, ...(opts.env ?? {}) } as NodeJS.ProcessEnv });
  child.stdout!.on('data', (d: Buffer) => { out.write(d); keep(d); });
  child.stderr!.on('data', (d: Buffer) => { err.write(d); keep(d); });
  const forward = (sig: NodeJS.Signals) => () => child.kill(sig);
  const onInt = forward('SIGINT'), onTerm = forward('SIGTERM');
  process.on('SIGINT', onInt); process.on('SIGTERM', onTerm);
  const code = await new Promise<number>((resolve) => {
    child.on('error', (e) => { err.write(`constellate watch: couldn't run ${argv[0]}: ${e.message}\n`); resolve(127); });
    child.on('close', (c, sig) => resolve(c ?? (sig ? 128 + 15 : 1)));
  });
  process.off('SIGINT', onInt); process.off('SIGTERM', onTerm);
  if (code === 0) return 0;
  const query = errorQuery(tail, argv.join(' '));
  const hub = openLedgerReadOnly({ ...process.env, ...(opts.env ?? {}) });
  const s = suggestFixes(hub, query);
  err.write(opts.json ? JSON.stringify({ exit_code: code, query, fixes: s }) + '\n' : `\n${formatSuggestions(s, query)}`);
  return code;
}
