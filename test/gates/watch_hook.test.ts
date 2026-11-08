import { describe, it, expect } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Writable } from 'node:stream';
import { Hub } from '../../src/hub/hub.js';
import { RecordStore } from '../../src/store/records.js';
import { LocalSigner } from '../../src/core/identity.js';
import { watch, errorQuery, cleanForSearch } from '../../src/watch/watch.js';
import { claudeCodeHook } from '../../src/watch/hook.js';

/**
 * Fixes that arrive when the error happens (docs/HOOKS.md): `constellate watch -- <command>` and the Claude Code
 * hook search this computer's ledger with the (locally cleaned) error output and show verified fixes. Neither
 * ever publishes anything.
 */
async function ledger() {
  const home = mkdtempSync(join(tmpdir(), 'watch-'));
  const author = new Hub({ signer: LocalSigner.generate(), store: new RecordStore(join(home, 'records')), preview: false });
  const ctx = { task: 'Start the dev server', domain: ['node'], environment: 'node 22' };
  const { record: failure } = await author.ledger.reportFailure(ctx, { approach: 'Run the dev server after upgrading the bundler', outcome: 'error', error_summary: 'Error: Cannot find module legacy-plugin' }, { publish: true });
  const { record: fix } = await author.ledger.submitAnswer(ctx, { question: 'Cannot find module legacy-plugin', answer: 'Install the legacy plugin package separately: it left the core bundler.', proof: { type: 'test', detail: 'dev server starts' } }, { publish: true, fixes: [failure.id] });
  const other = new Hub({ signer: LocalSigner.generate(), preview: false });
  other.node.ingest(failure); other.node.ingest(fix);
  author.node.ingest((await other.tried(fix.id, { worked: true, environment: 'node 22', error_before: 'Cannot find module legacy-plugin' }, { publish: true })).record);
  const env = { CONSTELLATE_HOME: home, CONSTELLATE_STARTER: 'off' };
  const count = () => ['public', 'private'].map((v) => readdirSync(join(home, 'records', v)).length).reduce((a, b) => a + b, 0);
  return { env, fix, count };
}
const sink = () => { let text = ''; return { stream: new Writable({ write(c, _e, cb) { text += c; cb(); } }), text: () => text }; };

describe('fixes that arrive when the error happens', () => {
  it('watch passes the output through, keeps the exit code, and prints the verified fix; nothing is published', async () => {
    const { env, fix, count } = await ledger();
    const before = count();
    const out = sink(), err = sink();
    const code = await watch(['sh', '-c', 'echo starting; echo "Error: Cannot find module legacy-plugin" >&2; exit 3'], { env, out: out.stream, err: err.stream });
    expect(code).toBe(3);
    expect(out.text()).toContain('starting');
    expect(err.text()).toContain('Error: Cannot find module legacy-plugin');
    expect(err.text()).toMatch(/fixes others verified/);
    expect(err.text()).toContain('Install the legacy plugin package separately');
    expect(err.text()).toContain(fix.id.slice(0, 12));
    expect(err.text()).toMatch(/confirmed by 1 agent on 1 computer/);
    expect(count()).toBe(before); // read-only: no record written
  });

  it('a command that succeeds prints nothing extra', async () => {
    const { env } = await ledger();
    const err = sink();
    expect(await watch(['sh', '-c', 'exit 0'], { env, out: sink().stream, err: err.stream })).toBe(0);
    expect(err.text()).toBe('');
  });

  it('the error is cleaned on this computer before it is used: no secrets, emails or home paths', () => {
    // Built from parts, so this file itself never holds a home path or an address (test/gates/privacy_rule.test.ts).
    const user = ['ka', 'te'].join(''), mail = ['dev', 'corp.io'].join('@');
    const raw = `Error at ${['', 'home', user, 'project', 'src', 'server.ts'].join('/')}:12 reading token=abcdef123456 for ${mail}\nkey ghp_${'a'.repeat(36)}`;
    const q = errorQuery(raw, 'npm run dev');
    expect(q).toContain('server.ts:12');
    for (const bad of [user, 'abcdef123456', mail, 'ghp_', '/home/']) expect(q).not.toContain(bad);
    expect(cleanForSearch('\x1b[31mError\x1b[0m')).toBe('Error');
  });

  it('the Claude Code hook answers a failed Bash call with additionalContext, and stays quiet otherwise', async () => {
    const { env, count } = await ledger();
    const before = count();
    const failed = { hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'npm run dev' }, error: 'Exit code 1\nError: Cannot find module legacy-plugin', is_interrupt: false };
    const out = JSON.parse(await claudeCodeHook(JSON.stringify(failed), env));
    expect(out.hookSpecificOutput.hookEventName).toBe('PostToolUseFailure');
    expect(out.hookSpecificOutput.additionalContext).toContain('Install the legacy plugin package separately');
    expect(await claudeCodeHook(JSON.stringify({ ...failed, is_interrupt: true }), env)).toBe('');
    expect(await claudeCodeHook(JSON.stringify({ ...failed, tool_name: 'Read' }), env)).toBe('');
    expect(await claudeCodeHook(JSON.stringify({ ...failed, error: 'Exit code 1\nzzz qqq' }), env)).toBe('');
    expect(await claudeCodeHook('not json', env)).toBe('');
    expect(count()).toBe(before);
  });

  it('when the same command passes later in the session, the hook asks once whether the fix worked; still nothing is published', async () => {
    const { env, fix, count } = await ledger();
    const before = count();
    const failed = { hook_event_name: 'PostToolUseFailure', session_id: 's1', tool_name: 'Bash', tool_input: { command: 'npm run dev -- --port 5173' }, error: 'Exit code 1\nError: Cannot find module legacy-plugin' };
    await claudeCodeHook(JSON.stringify(failed), env);
    const note = readFileSync(join(env.CONSTELLATE_HOME, 'hook-pending.json'), 'utf8');
    expect(note).not.toContain('5173'); // only the command's first words are kept
    const passed = { hook_event_name: 'PostToolUse', session_id: 's1', tool_name: 'Bash', tool_input: { command: 'npm run dev' }, tool_response: { stdout: 'ready in 300 ms', stderr: '', interrupted: false } };
    expect(await claudeCodeHook(JSON.stringify({ ...passed, session_id: 'other' }), env)).toBe(''); // another session isn't asked
    expect(await claudeCodeHook(JSON.stringify({ ...passed, tool_input: { command: 'ls' } }), env)).toBe(''); // another command isn't either
    const out = JSON.parse(await claudeCodeHook(JSON.stringify(passed), env));
    expect(out.hookSpecificOutput.hookEventName).toBe('PostToolUse');
    expect(out.hookSpecificOutput.additionalContext).toContain('fix_tried');
    expect(out.hookSpecificOutput.additionalContext).toContain(fix.id); // the full id, ready to use
    expect(await claudeCodeHook(JSON.stringify(passed), env)).toBe(''); // asked once
    // Notes expire: a failure two hours old isn't followed up.
    await claudeCodeHook(JSON.stringify(failed), env, Date.now() - 3 * 3600_000);
    expect(await claudeCodeHook(JSON.stringify(passed), env)).toBe('');
    expect(count()).toBe(before);
  });

  it('is documented, with the hook recipe', () => {
    const doc = readFileSync(join(import.meta.dirname, '../../docs/HOOKS.md'), 'utf8');
    expect(doc).toContain('PostToolUseFailure');
    expect(doc).toContain('constellate hook claude-code');
    expect(doc).toMatch(/ever publishes anything/i);
  });
});
