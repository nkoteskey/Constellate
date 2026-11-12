import { describe, it, expect } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { Hub } from '../../src/hub/hub.js';
import { LocalSigner } from '../../src/core/identity.js';
import { RecordStore } from '../../src/store/records.js';
import { ProblemBody } from '../../src/work/problems.js';
import { agentTools, setAgentTools } from '../../src/work/claude-tools.js';
import { WebServer } from '../../src/web/server.js';
import { registerAppRoutes } from '../../src/web/app.js';

/**
 * Claude Code started by the app runs unattended: nobody can approve a tool while it works. So what it may use is
 * decided up front (src/work/claude-tools.ts): it's only shown those tools, anything else is refused at once
 * instead of waiting, the person's own settings don't apply, and it works in a scratch folder. When it asks for
 * something it can't have, the log says so and names the switch, rather than the run just failing.
 */
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const problemBody = () => ProblemBody.parse({ title: 'Small facts', hook: 'Tiny', goal: 'Answer small questions exactly.', realm: 'maths_physics', definition_of_done: { verifier: 'exact', description: 'Matches exactly.' },
  chunks: [{ key: 'first', title: 'Six times seven', prompt: 'What is 6 × 7?', check: { expected: '42' }, needs: { size: 'any' } }] });

/** A stand-in for Claude Code: its --help lists the flags it knows; a run records its arguments and folder, then reports a refused tool. */
function fakeClaude(home: string, flags = ['--tools', '--restricted', 'dontAsk']) {
  const fake = join(home, 'claude'), argsFile = join(home, 'args.json');
  const lines = [
    { type: 'system', subtype: 'init', model: 'claude-sonnet', mcp_servers: [{ name: 'constellate', status: 'connected' }] },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__constellate__work_step', input: { problem: 'x', step: 'first', answer: '42' } }] } },
    { type: 'result', duration_ms: 2000, permission_denials: [{ tool_name: 'Bash', tool_input: { command: 'python3 search.py' } }] },
  ];
  writeFileSync(fake, `#!/usr/bin/env node
const a = process.argv.slice(2);
if (a.includes('--help')) { console.log(${JSON.stringify(flags.map((f) => `  ${f}   something`).join('\n'))}); process.exit(0); }
require('fs').writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify({ args: a, cwd: process.cwd() }));
for (const l of ${JSON.stringify(lines.map((x) => JSON.stringify(x)))}) console.log(l);
`);
  chmodSync(fake, 0o755);
  return { fake, read: () => JSON.parse(readFileSync(argsFile, 'utf8')) as { args: string[]; cwd: string } };
}

async function runOnce(hub: Hub, id: string) {
  for (const r of hub.agentRuns.forProblem(id)) r.status = 'done'; // let a new run start
  const run = hub.agentRuns.start(id);
  for (let i = 0; i < 100 && hub.agentRuns.get(run.id)!.status === 'running'; i++) await wait(30);
  return hub.agentRuns.get(run.id)!;
}

describe('what Claude Code may use when it runs on its own', () => {
  it('only the tools it may use, refused at once otherwise, in a scratch folder; and a refused tool is named in the log', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tools-'));
    process.env.CONSTELLATE_HOME = home;
    const claude = fakeClaude(home);
    process.env.CONSTELLATE_CLAUDE = claude.fake;
    try {
      const hub = new Hub({ signer: LocalSigner.generate(), store: new RecordStore(), preview: false });
      const id = (await hub.collective.propose(problemBody())).problem!.id;
      expect(agentTools()).toEqual({ web: true, code: false }); // the defaults

      const r = await runOnce(hub, id);
      const { args, cwd } = claude.read();
      const arg = (f: string) => args[args.indexOf(f) + 1];
      expect(arg('--tools')).toBe('WebSearch,WebFetch'); // all it's shown of the built-in tools
      expect(arg('--allowedTools').split(',')).toEqual(['mcp__constellate__work_step', 'mcp__constellate__failures_search', 'mcp__constellate__answers_lookup', 'mcp__constellate__skills_find', 'WebSearch', 'WebFetch']);
      expect(args).toContain('--restricted'); // the person's own Claude Code settings don't apply
      expect(arg('--permission-mode')).toBe('dontAsk'); // refused at once, never waiting for an approval
      expect(args[1]).toMatch(/You are running unattended.*web search and web fetch.*You can't run code here/s);
      expect(cwd.startsWith(join(realpathSync(home), 'agent-work'))).toBe(true); // realpath: on macOS tmpdir() is /var, the child's cwd /private/var
      expect(r.log.map((l) => l.text)).toContain('It may use Constellate\'s tools, web search and web fetch.');
      expect(r.log.map((l) => l.text)).toContain('Claude Code wanted Bash, which this run doesn\'t allow. To let it run code, turn on “Run code in a scratch folder”.');
      expect(r).toMatchObject({ status: 'done', steps: 1 }); // a refused tool doesn't sink the run

      // The person turns on running code: Bash and the file tools, still only in its own folder.
      setAgentTools({ code: true });
      await runOnce(hub, id);
      const second = claude.read();
      expect(second.args[second.args.indexOf('--tools') + 1]).toBe('WebSearch,WebFetch,Bash,Read,Write,Edit,Glob,Grep');
      expect(second.args[1]).toMatch(/Bash and the file tools, inside the current folder only/);
      expect(second.cwd).not.toBe(cwd); // a fresh folder each run

      setAgentTools({ web: false, code: false });
      await runOnce(hub, id);
      const third = claude.read();
      expect(third.args[third.args.indexOf('--tools') + 1]).toBe(''); // Constellate's tools only
    } finally { process.env.CONSTELLATE_CLAUDE = 'off'; delete process.env.CONSTELLATE_HOME; }
  });

  it('an older Claude Code without those flags still runs: only the flags it knows are passed', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tools-old-'));
    process.env.CONSTELLATE_HOME = home;
    const claude = fakeClaude(home, []);
    process.env.CONSTELLATE_CLAUDE = claude.fake;
    try {
      const hub = new Hub({ signer: LocalSigner.generate(), store: new RecordStore(), preview: false });
      const id = (await hub.collective.propose(problemBody())).problem!.id;
      expect(await runOnce(hub, id)).toMatchObject({ status: 'done', steps: 1 });
      const { args } = claude.read();
      for (const f of ['--tools', '--restricted', '--permission-mode']) expect(args).not.toContain(f);
      expect(args[args.indexOf('--allowedTools') + 1]).toContain('WebFetch');
    } finally { process.env.CONSTELLATE_CLAUDE = 'off'; delete process.env.CONSTELLATE_HOME; }
  });

  it('the switches sit under Claude Code in the list, and changing one is saved for the next run', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tools-ui-'));
    process.env.CONSTELLATE_HOME = home;
    process.env.CONSTELLATE_CLAUDE = fakeClaude(home).fake;
    const hub = new Hub({ signer: LocalSigner.generate(), store: new RecordStore(), preview: false });
    const id = (await hub.collective.propose(problemBody())).problem!.id;
    const web = new WebServer(hub);
    registerAppRoutes(web);
    await web.listen(0);
    const { chromium } = createRequire(import.meta.url)('playwright');
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
      const errors: string[] = [];
      page.on('pageerror', (e: Error) => errors.push(String(e)));
      await page.goto(`${web.url}/#/p/${id}`);
      await page.click('#help'); // "Help with this"
      await page.click('[data-act="agentwork"]'); // "Have your agent work on it"
      await page.waitForSelector('#aw-tools [data-tool="code"]');
      expect(await page.textContent('#aw-tools')).toMatch(/Search and read the web.*Run code in a scratch folder.*runs on this computer without asking/s);
      expect(await page.isChecked('#aw-tools [data-tool="web"]')).toBe(true);
      expect(await page.isChecked('#aw-tools [data-tool="code"]')).toBe(false);
      await page.check('#aw-tools [data-tool="code"]');
      for (let i = 0; i < 50 && !agentTools().code; i++) await wait(20);
      expect(agentTools()).toEqual({ web: true, code: true });
      expect(errors).toEqual([]);
    } finally { await browser.close(); await web.close(); process.env.CONSTELLATE_CLAUDE = 'off'; delete process.env.CONSTELLATE_HOME; }
  }, 60_000);
});
