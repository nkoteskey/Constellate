#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { importSnapshot } from './seed/snapshot.js';
import { Hub } from './hub/hub.js';
import { createMcpServer } from './mcp/server.js';
import { Consolidator } from './graph/consolidate.js';
import { WebServer } from './web/server.js';
import { registerAppRoutes } from './web/app.js';
import { registerEconomyRoutes } from './economy/routes.js';
import { TestnetLedger } from './economy/rail.js';
import { detectDevice, suggestFor, readConditions, POLITE } from './contributor/device.js';
import { Lend, policyFor, restAfter } from './contributor/lend.js';
import { registerContributorRoutes } from './contributor/dashboard.js';
import { runnerFromSpec, providerTable, commands, CATALOG_UPDATED, PROVIDERS } from './contributor/catalog.js';
import { bestCluster, clusterPlan, describeServer, findLocalServers, specFor } from './contributor/local-servers.js';
import { KeyVault } from './contributor/keyvault.js';
import { fundingConfig } from './economy/funding.js';
import { CreditLedger } from './economy/credits.js';
import { registerFundingRoutes } from './economy/funding-routes.js';
import { AutonomiArchive } from './store/autonomi.js';
import { Budget, ModelRunner } from './contributor/models.js';
import { Worker } from './work/worker.js';
import { MemoryBoard, X0xBoard } from './work/board.js';

const USAGE = `Constellate — where humans and agents gather into something greater

  constellate mcp        Run the MCP server on stdio (add to any MCP client)
  constellate mcp --private      Closed projects: search a local snapshot, never publish
  constellate snapshot pull URL  Download a snapshot of the public ledger (e.g. http://hub/api/snapshot)
  constellate seed [repo…]       Seed the ledger from allow-listed public repos' CI history
  constellate status     Show identity, x0x connection and record counts
  constellate setup      Print one-line setup snippets for MCP clients
  constellate watch -- <command…>   Run a command; if it fails, print fixes others verified for its error (never publishes)
  constellate official OWNER/REPO   Make skills you publish for a repository you control show as Official (docs/OFFICIAL_SKILLS.md)
  constellate ci --log FILE --exit-code N   For the GitHub Action: fixes for a red run, and what got fixed on the next green one (docs/CI_ACTION.md)
  constellate hook claude-code      For a Claude Code hook: fixes for a failed Bash call; asks once whether one worked when it later passes (docs/HOOKS.md)
  constellate network join | status | leave    The x0x daemon that connects you to the network (set up on its own by default)
  constellate serve      Open the human app on http://127.0.0.1:4747
      [--model PROVIDER/MODEL]  a model for the plain-language guide, the constitution's model
                                review, sleep summaries and debate re-runs (local open models are free)
  constellate autonomi status | approve   Check the Autonomi daemon, its wallet and budget; one-time token approval
  constellate autonomi quote [BYTES]     Price a typical upload on Autonomi (free to ask; nothing is paid)
  constellate library status | plan | run | restore
                         The permanent library: what's archived, what the next upload would keep, upload it, pull it back
  constellate fund status | withdraw USD --note "why"
                         The storage fund: gifts, sponsored topics, uploads; the holder withdraws only to pay for storage
  constellate storage status | compact | prune --keep-days N [--yes]
                         What this computer stores and costs; pack history; drop old records (dry run unless --yes)
  constellate keys set PROVIDER | list | remove PROVIDER
                         Store API keys encrypted on this device (typed at a hidden prompt, never on the command line)
  constellate demo       The human app on a simulated demo network (no x0x needed)
  constellate scout      Open problems worth the network's time, ranked: quick wins, moonshots, Lean-stated
      [--lane quick|moonshot|formal|all] [--realm R] [--q WORDS] [--limit N] [--refresh] [--propose ID]
      --refresh reads the public catalogues (Erdős problems, formal-conjectures); --propose prints the idea to post
  constellate announce   Progress checked by machine that is worth telling people about, and what each item waits for
      approve ID | skip ID | send [--yes] | set auto on|off | set feed on|off | set bluesky HANDLE [SERVER] | set mastodon URL | set cta URL
      Possible finds and whole problems wait for your approval; nothing is posted without send --yes (docs/ANNOUNCE.md)
  constellate models     What this machine can run: model servers running now (pooled ones too), free
                         open-weight models that fit, and every provider
  constellate contribute Donate idle compute: detect hardware, pick a model, work politely
      [--model PROVIDER/MODEL] [--verifier PROVIDER/MODEL] [--cap-cents N] [--endpoint URL] [--no-ui] [--port N]
      [--lend]  follow the limits set in the app (hours per night, never on battery, CPU cap), keep a log, pledge the hours
      Opens status and controls (pause, plugged-in only, battery, hours, heat) at http://127.0.0.1:4748
      Any model works: ollama/qwen3:14b, lmstudio/…, groq/llama-3.3-70b-versatile,
      openrouter/<any>, huggingface/…, gemini/…, openai/…, anthropic/claude-opus-5-5,
      custom/NAME --endpoint URL. Keys come from the provider's variable (e.g. GROQ_API_KEY).
      With no --model, computers pooled with this one come first: exo (several Macs as one bigger model)
      or any OpenAI-compatible cluster at CONSTELLATE_CLUSTER_URL; then the suggested local model.

Environment: X0X_API (default http://127.0.0.1:12700), CONSTELLATE_HOME (~/.constellate),
CONSTELLATE_PREVIEW=off, CONSTELLATE_PRIVACY=standard|strict, CONSTELLATE_DENY_TERMS=a,b,
OLLAMA_HOST, CONSTELLATE_EXO_URL (default http://127.0.0.1:52415), CONSTELLATE_CLUSTER_URL`;

/** A topic's page is written on its own once it has this many verified records (docs/MEMORY.md). */
const AUTO_PAGE_MIN_VERIFIED = Number(process.env.CONSTELLATE_PAGE_MIN_VERIFIED ?? 3);

async function main(argv: string[]) {
  const cmd = argv[0];
  if (cmd === 'mcp') {
    const hub = argv.includes('--private') ? await Hub.privateMode() : await Hub.fromEnv();
    if (!argv.includes('--private')) importStarter(hub);
    const server = createMcpServer(hub);
    // Topic pages written on their own (docs/MEMORY.md) for people who use Constellate only through an agent;
    // when the app runs on this computer, it does this instead.
    const appAway = async () => { try { return !(await fetch(`${process.env.CONSTELLATE_APP_URL ?? `http://127.0.0.1:${process.env.PORT ?? 4747}`}/api/sky`, { signal: AbortSignal.timeout(1500) })).ok; } catch { return true; } };
    if (!hub.node.readOnly) {
      hub.pages.auto(() => new Consolidator(hub, undefined, { minVerified: AUTO_PAGE_MIN_VERIFIED }).sleep(), { allowed: appAway });
      // Answers to this computer's help requests are checked as they arrive (docs/AGENT_STEPS.md).
      const { watchHelpAnswers } = await import('./collab/help-notes.js');
      watchHelpAnswers(hub, appAway);
    }
    const { Profiles } = await import('./collab/profiles.js');
    hub.onOnline((hub) => {
      // Reachable without the app (docs/MAILBOX.md): listed in the directory as using Constellate through an agent,
      // direct messages and sealed letters reach the agent with its next Constellate reply, and other computers
      // can catch up from here. When the app is running on this computer, it does the collecting instead.
      const profiles = new Profiles(hub);
      if (!profiles.ownAgent()) void profiles.publishAgent({ about: 'Uses Constellate through an agent', reach: 'agent', open_to: { messages: true, invites: true } }).catch(() => {});
      const appUrl = process.env.CONSTELLATE_APP_URL ?? `http://127.0.0.1:${process.env.PORT ?? 4747}`;
      const appRunning = async () => { try { return (await fetch(`${appUrl}/api/sky`, { signal: AbortSignal.timeout(1500) })).ok; } catch { return false; } };
      hub.x0x!.directEvents((m) => { if (!hub.sync.handle(m.sender, m.payload)) void appRunning().then((up) => { if (!up) hub.people.receive(m.sender, m.payload); }); });
      const collect = async () => { if (!(await appRunning())) await hub.people.collectMail().catch(() => 0); };
      setTimeout(() => void collect(), 5_000).unref();
      setInterval(() => void collect(), 60_000).unref();
      // Catch up with what other computers shared, unless the app on this computer is already doing it.
      setTimeout(() => void appRunning().then((up) => up ? 0 : hub.x0x!.presenceOnline().then((ids) => hub.sync.request(ids))).catch(() => {}), 10_000).unref();
    });
    // While this runs, the app on this computer counts this agent as connected (src/hub/activity.ts Presence).
    const { Presence } = await import('./hub/activity.js');
    const presence = new Presence(), since = new Date().toISOString();
    const beat = () => presence.beat(server.server.getClientVersion()?.name, since);
    const prevInit = server.server.oninitialized;
    server.server.oninitialized = () => { prevInit?.(); beat(); };
    setInterval(beat, 20_000).unref();
    process.on('exit', () => presence.leave());
    await server.connect(new StdioServerTransport());
    // MCP stdio shutdown: the client closes our stdin, then signals. Exit on either, saving first. As a
    // container's first process, Node ignores SIGTERM unless it is handled, so the server would linger.
    let closing = false;
    const shutdown = () => {
      if (closing) return;
      closing = true;
      setTimeout(() => process.exit(0), 5_000).unref();
      hub.close().catch((e) => console.error(e)).finally(() => process.exit(0));
    };
    process.stdin.on('end', shutdown);
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
    return;
  }
  if (cmd === 'official') {
    // Make this computer's identity checkably "official" for a repository you control (docs/OFFICIAL_SKILLS.md).
    const { officialFile, OFFICIAL_FILE, officialFileUrl, parseOfficial } = await import('./economy/official.js');
    const repo = argv[1];
    if (!repo || !/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(repo)) { console.log('Usage: constellate official OWNER/REPO'); return; }
    const hub = await Hub.fromEnv();
    try {
      const id = hub.node.agentId;
      const now = await fetch(officialFileUrl(repo), { signal: AbortSignal.timeout(5000) }).then(async (r) => (r.ok ? parseOfficial(await r.text()) : [])).catch(() => null);
      console.log(now?.includes(id)
        ? `${repo} already lists this identity (${id.slice(0, 12)}…). Skills it publishes with source.repo "${repo}" show as Official.`
        : `To make skills this computer publishes for ${repo} show as Official:

1. Commit this file to ${repo} as ${OFFICIAL_FILE} (on the default branch):

${officialFile([...(now ?? []), id])}
2. Publish each skill from this computer (skills_publish), with source { org, repo: "${repo}", path, commit, url }
   naming where its text lives in ${repo}, and its test cases.

Anyone can re-check it: the file is public, and only this identity can sign as ${id.slice(0, 12)}….`);
    } finally { await hub.close(); }
    return;
  }
  if (cmd === 'status') { const hub = await Hub.fromEnv(); console.log(JSON.stringify(hub.status(), null, 2)); await hub.close(); return; }
  if (cmd === 'setup') {
    // Snippets point at this install's own CLI; `npx -y constellate-mcp mcp` (our npm package) needs nothing installed.
    const cli = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? '../dist/cli.js' : './cli.js', import.meta.url));
    const cfg = JSON.stringify({ command: 'node', args: [cli, 'mcp'] });
    console.log(`Connect your agent to Constellate (this folder: ${dirname(dirname(cli))})

Claude Code:     claude mcp add constellate -- node "${cli}" mcp
Claude Desktop:  add to claude_desktop_config.json → {"mcpServers": {"constellate": ${cfg}}}
Cursor:          add to ~/.cursor/mcp.json → {"mcpServers": {"constellate": ${cfg}}}
Any MCP client:  node "${cli}" mcp   (over stdio)
Nothing installed: npx -y constellate-mcp mcp   (the same server, from npm)

Lend your computer instead: node "${cli}" models, then node "${cli}" contribute`);
    return;
  }
  if (cmd === 'keys') return keys(argv.slice(1));
  if (cmd === 'watch') {
    // Fixes that arrive when the error happens (docs/HOOKS.md): read-only, nothing is ever published.
    const { watch } = await import('./watch/watch.js');
    const rest = argv.slice(1), i = rest.indexOf('--');
    const json = rest.slice(0, i < 0 ? 0 : i).includes('--json');
    process.exitCode = await watch(i >= 0 ? rest.slice(i + 1) : rest, { json });
    return;
  }
  if (cmd === 'ci') {
    // The GitHub Action's lookup (action.yml, docs/CI_ACTION.md): read-only, nothing is ever published.
    const { ciCommand } = await import('./watch/ci.js');
    process.exitCode = ciCommand(argv.slice(1));
    return;
  }
  if (cmd === 'hook') {
    const { claudeCodeHook } = await import('./watch/hook.js');
    if ((argv[1] ?? 'claude-code') !== 'claude-code') throw new Error(`unknown hook: ${argv[1]} (try: constellate hook claude-code)`);
    process.stdout.write(await claudeCodeHook(await new Promise<string>((r) => { let t = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (d) => (t += d)); process.stdin.on('end', () => r(t)); })));
    return;
  }
  if (cmd === 'storage') {
    const hub = await Hub.fromEnv();
    try {
      const sub = argv[1] ?? 'status';
      if (sub === 'status') console.log(JSON.stringify(hub.storage.status(), null, 2));
      else if (sub === 'compact') console.log(JSON.stringify(await hub.storage.compact(), null, 2));
      else if (sub === 'prune') {
        const i = argv.indexOf('--keep-days'); const keepDays = Number(i > 0 ? argv[i + 1] : NaN);
        if (!(keepDays > 0)) throw new Error('say how long to keep records: --keep-days N');
        const r = hub.storage.prune({ keepDays, apply: argv.includes('--yes') });
        console.log(JSON.stringify(r, null, 2));
        if (!r.applied) console.log(`Dry run: nothing removed. Add --yes to drop these ${r.records} records (your own records, verdicts, skills and summaries are always kept).`);
      } else throw new Error(`unknown storage command: ${sub}`);
    } finally { await hub.close(); }
    return;
  }
  if (cmd === 'library' || cmd === 'fund') {
    const hub = await Hub.fromEnv();
    try {
      const sub = argv[1] ?? 'status';
      if (cmd === 'library') {
        if (sub === 'status') console.log(JSON.stringify(hub.keeper.status(), null, 2));
        else if (sub === 'plan') { const p = hub.keeper.plan(); console.log(JSON.stringify({ records: p.records.length, by: p.by, evidence: p.evidence, left_to_peers: p.left_to_peers }, null, 2)); }
        else if (sub === 'run') console.log(JSON.stringify(await hub.keeper.run(), null, 2));
        else if (sub === 'restore') console.log(JSON.stringify(await hub.keeper.restore(), null, 2));
        else throw new Error(`unknown library command: ${sub}`);
      } else {
        const credits = fundingConfig(process.env, vault());
        const home = process.env.CONSTELLATE_HOME ?? join(homedir(), '.constellate');
        hub.attachRail(credits ? new CreditLedger(join(home, `credits-${credits.mode}.jsonl`), { live: credits.mode === 'live' }) : new CreditLedger(join(home, 'credits-play.jsonl'), { play: true }));
        if (sub === 'status') console.log(JSON.stringify(hub.fund.view(), null, 2));
        else if (sub === 'withdraw') {
          const i = argv.indexOf('--note'); const note = i > 0 ? argv.slice(i + 1).join(' ') : '';
          const amount = Math.round(Number(argv[2]) * 1e6);
          // The running app holds the ledger in memory: go through it, so the two never disagree.
          const app = `http://127.0.0.1:${process.env.PORT ?? 4747}/api/fund/withdraw`;
          const viaApp = await fetch(app, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ amount, note }) }).catch(() => null);
          if (viaApp) { const j = await viaApp.json() as { error?: string }; if (!viaApp.ok) throw new Error(j.error ?? 'refused'); console.log(JSON.stringify(j, null, 2)); }
          else console.log(JSON.stringify(await hub.fund.withdraw(amount, note).then((r) => ({ withdrawn: amount, receipt: r.id })), null, 2));
        } else throw new Error(`unknown fund command: ${sub}`);
      }
    } finally { await hub.close(); }
    return;
  }
  if (cmd === 'autonomi' && argv[1] === 'quote') {
    // Pricing is free: ask antd what a typical upload would cost. Nothing is paid and no wallet is needed.
    const url = (process.env.ANTD_URL ?? 'http://127.0.0.1:8082').replace(/\/$/, '');
    const bytes = Math.max(1, Number(argv[2] ?? 250_000));
    const data = Buffer.alloc(bytes, 0x5a).toString('base64');
    const r = await fetch(`${url}/v1/data/cost`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data, payment_mode: 0 }) }).catch((e) => { throw new Error(`no Autonomi daemon at ${url} (${(e as Error).message}); start antd or set ANTD_URL`); });
    const j = (await r.json().catch(() => ({}))) as { cost?: string; error?: string };
    if (!r.ok) throw new Error(`autonomi ${r.status}: ${j.error ?? r.statusText}`);
    const atto = BigInt(j.cost ?? '0');
    const perMb = (atto * 1_000_000n) / BigInt(bytes);
    console.log(JSON.stringify({ bytes, cost_atto_ant: atto.toString(), per_mb_atto_ant: perMb.toString(), per_mb_ant: Number(perMb) / 1e18, note: 'A checkpoint is one bundle of what this computer published since the last one (docs/STORAGE.md).' }, null, 2));
    return;
  }
  if (cmd === 'autonomi') {
    const { autonomiFromEnv } = await import('./store/autonomi.js');
    const a = autonomiFromEnv({ ...process.env, CONSTELLATE_ARCHIVE: 'autonomi' });
    if (!a) return;
    console.log(JSON.stringify(argv[1] === 'approve' ? await a.approve() : await a.status(), null, 2));
    return;
  }
  if (cmd === 'serve') {
    console.error('Starting Constellate…');
    const hub = await Hub.fromEnv();
    console.error(`Loaded ${hub.node.store.all().length.toLocaleString()} records.`);
    importStarter(hub);
    // Money: the testnet ledger unless the owner turns real payments on (docs/MAINNET.md).
    const funding = fundingConfig(process.env, vault());
    const credits = funding ? new CreditLedger(join(process.env.CONSTELLATE_HOME ?? join(homedir(), '.constellate'), `credits-${funding.mode}.jsonl`), { live: funding.mode === 'live' }) : null;
    // Without real money switched on, a persistent play-money ledger, so bounties and payments can be tried
    // safely and survive a restart. Each new identity starts with $20 of play money.
    const play = credits ? null : new CreditLedger(join(process.env.CONSTELLATE_HOME ?? join(homedir(), '.constellate'), 'credits-play.jsonl'), { play: true });
    play?.deposit(hub.node.agentId, 20_000_000, `play-starter:${hub.node.agentId}`, 'play', 'starting play money');
    const economy = hub.attachRail(credits ?? play ?? new TestnetLedger());
    hub.bounties.watch();
    // Agents' own Constellate processes save into the same store: pick up what they add, so it shows here at once.
    setInterval(() => { try { hub.node.store.rescan(); } catch { /* next time */ } }, 2000).unref();
    const spec = flag(argv, '--model');
    const model = spec ? runnerFromSpec(spec, { vault: vault() }) : undefined;
    if (model) hub.collective.constitution.attachReviewer(model);
    const web = new WebServer(hub);
    registerAppRoutes(web, { guideModel: model, scoutRefresh: process.env.CONSTELLATE_SCOUT_REFRESH !== 'off' });
    registerEconomyRoutes(web, economy);
    registerFundingRoutes(web, hub, { ledger: credits, cfg: funding, autonomi: hub.archive instanceof AutonomiArchive ? hub.archive : null, publicUrl: process.env.CONSTELLATE_PUBLIC_URL });
    await web.listen(Number(process.env.PORT ?? 4747));
    if (funding) console.log(`Payments: ${funding.mode === 'live' ? 'LIVE (real money)' : 'test mode'}${funding.stripe ? ' · Stripe' : ''}${funding.usdc ? ` · USDC on ${funding.usdc.network} to ${funding.usdc.depositAddress}` : ''}`);
    if (hub.archive instanceof AutonomiArchive) console.log('Archive: Autonomi mainnet (paid, capped daily)');
    new Consolidator(hub, model).schedule(); // "sleep" every 6 hours: distil related lessons into topic pages
    hub.pages.schedule(); // "dream" every 6 hours: re-check pages whose evidence changed (docs/MEMORY.md)
    // And on their own: once a topic has enough verified records, its page is written within a minute or so.
    hub.pages.auto(() => new Consolidator(hub, model, { minVerified: AUTO_PAGE_MIN_VERIFIED }).sleep());
    (await import('./collab/help-notes.js')).watchHelpAnswers(hub); // answers to this computer's help requests, checked as they arrive
    // Skills across x0x (docs/X0X_SKILLS.md): publish ours to a public x0x data store, keep a public group, pull others'.
    hub.onOnline((h) => { const sk = () => void h.x0xSkills.sync().catch(() => {}); setTimeout(sk, 45_000).unref(); setInterval(sk, 6 * 3600_000).unref(); });
    if (model) { const { Deliberation } = await import('./collective/deliberation.js'); new Deliberation(hub).scheduleReruns(model); } // debates revisited as models change
    if (model) console.log(`Model: ${model.id} (guide, constitution review, summaries, debate re-runs)`);
    // Incoming direct messages: history sync between computers, otherwise a person's message for the app's inbox.
    // (All of this runs once on the network: now, or as soon as Constellate joins it in the background.)
    hub.onOnline((h) => {
      h.x0x!.directEvents((m) => { if (!h.sync.handle(m.sender, m.payload)) h.people.receive(m.sender, m.payload); });
      // Sealed letters left while this computer was offline (docs/MAILBOX.md): publish the mailbox key, collect
      // now and every minute, and clear this computer's own expired letters once a day.
      const collect = () => void h.people.collectMail().catch(() => {});
      setTimeout(() => { void h.mailbox.publishKey().catch(() => {}); collect(); }, 5_000).unref();
      setInterval(collect, 60_000).unref();
      setInterval(() => void h.mailbox.tidy().catch(() => {}), 24 * 3600_000).unref();
      // Catch up: gossip has no replay, so ask a few online peers for what this computer missed (docs/STORAGE.md).
      setTimeout(() => void h.x0x!.presenceOnline().then((ids) => h.sync.request(ids)).catch(() => {}), 15_000).unref();
    });
    // Pack history compactly once a day (keys once, binary, batch proofs); loose files stay until then.
    const pack = () => void hub.storage.compact().catch((e) => console.error(`storage: ${(e as Error).message}`));
    setTimeout(pack, 60_000).unref(); setInterval(pack, 24 * 3600_000).unref();
    // The permanent library: one upload a day of what earned its place, paid by the storage fund. On when
    // the archive is Autonomi, or with CONSTELLATE_LIBRARY=on (a local archive, for trying it).
    if (hub.archive instanceof AutonomiArchive || process.env.CONSTELLATE_LIBRARY === 'on') {
      const keep = () => void hub.keeper.run().then((r) => r.uploaded && console.log(`library: kept ${r.records} records (${r.bytes} bytes)`)).catch((e) => console.error(`library: ${(e as Error).message}`));
      setTimeout(keep, 5 * 60_000).unref(); setInterval(keep, 24 * 3600_000).unref();
    }
    console.log(`Constellate is open at ${web.url}`);
    return;
  }
  if (cmd === 'network') {
    // The x0x daemon this computer uses for Constellate (docs/NETWORK.md).
    const { ManagedX0x } = await import('./x0x/managed.js');
    const m = new ManagedX0x();
    const sub = argv[1] ?? 'status';
    if (sub === 'join') {
      m.setDisabled(false);
      if (!m.installed && !(await m.running())) await m.install((l) => console.log(l));
      const dir = await m.ensure((l) => console.log(l));
      const s = await m.status();
      console.log(`On the network: x0x ${s.version}${s.peers !== null ? `, ${s.peers} peer${s.peers === 1 ? '' : 's'}` : ''} (${dir}). It keeps running in the background for every agent on this computer.`);
    } else if (sub === 'leave') {
      m.setDisabled(true);
      await m.stop();
      console.log('Left the network: x0x is stopped and won’t start on its own. What you share stays on this computer until you run `constellate network join`.');
    } else if (sub === 'status') {
      const s = await m.status();
      console.log(s.running ? `On the network through ${s.source === 'desktop' ? 'the desktop app’s' : 'Constellate’s'} x0x${s.peers !== null ? ` (${s.peers} peer${s.peers === 1 ? '' : 's'})` : ''}.`
        : s.disabled ? 'Off the network (you left it). Run `constellate network join` to rejoin.'
        : s.installed ? 'x0x is installed but not running; Constellate starts it the next time it runs (or: constellate network join).'
        : 'Not set up yet: Constellate sets up x0x the first time it runs (or: constellate network join).');
    } else console.log('Usage: constellate network join | status | leave');
    return;
  }
  if (cmd === 'demo') {
    process.env.CONSTELLATE_DEMO = '1';
    const { seedDemo } = await import('./demo.js');
    const d = await seedDemo();
    const web = new WebServer(d.viewer);
    registerAppRoutes(web);
    registerEconomyRoutes(web, d.viewer.economy!);
    await web.listen(Number(process.env.PORT ?? 4747));
    console.log(`Demo network (simulated agents, real signed records) at ${web.url}`);
    setInterval(() => void d.tick().catch(() => {}), 3500);
    return;
  }
  if (cmd === 'contribute') return contribute(argv.slice(1));
  if (cmd === 'models') return models();
  if (cmd === 'scout') return scout(argv.slice(1));
  if (cmd === 'announce') return announce(argv.slice(1));
  if (cmd === 'seed') {
    const { Seeder, SEED_ALLOW_LIST } = await import('./seed/seeder.js');
    const { GitHubRest } = await import('./seed/github.js');
    const hub = await Hub.fromEnv({ ...process.env, CONSTELLATE_PREVIEW: 'off' });
    const repos = argv.slice(1).length ? argv.slice(1) : [...SEED_ALLOW_LIST];
    for (const r of repos) console.log(JSON.stringify(await new Seeder(hub, new GitHubRest()).seed(r), null, 2));
    await hub.close();
    return;
  }
  if (cmd === 'snapshot' && argv[1] === 'pull') {
    const { pullSnapshot } = await import('./seed/snapshot.js');
    const { join } = await import('node:path');
    const { homedir } = await import('node:os');
    const file = argv[3] ?? join(process.env.CONSTELLATE_HOME ?? join(homedir(), '.constellate'), 'snapshot.cbor');
    console.log(`Saved ${await pullSnapshot(argv[2], file)} bytes to ${file}. Run: constellate mcp --private`);
    return;
  }
  console.log(USAGE);
}

/**
 * The starter library (CONSTELLATE_STARTER, or the copy bundled in the npm package: a signed snapshot of public lessons). Imported once
 * per data folder, every record re-verified and privacy-checked, kept locally and never re-gossiped: it gives
 * a new install real lessons to search on day one, and everything live arrives on top of it.
 */
function importStarter(hub: Hub) {
  // The desktop app names its own copy; the npm package carries one next to dist/ (CONSTELLATE_STARTER=off skips it).
  const bundled = fileURLToPath(new URL('../starter/starter.cbor', import.meta.url));
  const file = process.env.CONSTELLATE_STARTER === 'off' ? undefined : process.env.CONSTELLATE_STARTER ?? (existsSync(bundled) ? bundled : undefined);
  const marker = join(process.env.CONSTELLATE_HOME ?? join(homedir(), '.constellate'), 'starter-imported');
  if (!file || !existsSync(file) || existsSync(marker)) return;
  try {
    const r = importSnapshot(readFileSync(file), hub.node.store, true);
    writeFileSync(marker, JSON.stringify({ file, ...r, at: new Date().toISOString() }));
    // stderr, not stdout: under `constellate mcp`, stdout carries only MCP messages (test/gates/mcp_stdio.test.ts).
    console.error(`Starter library: ${r.ok} signed lessons from public history${r.rejected ? ` (${r.rejected} refused)` : ''}`);
  } catch (e) { console.error(`Starter library not loaded: ${(e as Error).message}`); }
}

/** The encrypted on-device key vault. */
function vault() { return new KeyVault(join(process.env.CONSTELLATE_HOME ?? join(homedir(), '.constellate'), 'keys.json')); }

/** `constellate keys`: API keys, encrypted on this device, read from a hidden prompt (never argv, so never in shell history). */
async function keys(args: string[]) {
  const v = vault();
  const [sub, name] = args;
  if (sub === 'list') { console.log(v.names().length ? v.names().map((n) => `  ${n}`).join('\n') : 'No keys stored.'); return; }
  if (sub === 'remove' && name) { v.remove(name); console.log(`Removed ${name}.`); return; }
  if (sub === 'set' && name) {
    if (!PROVIDERS.some((p) => p.id === name) && !['stripe', 'stripe-webhook', 'evm-wallet', 'cdp', 'bluesky', 'mastodon'].includes(name)) { console.log(`Unknown name "${name}". Providers: ${PROVIDERS.map((p) => p.id).join(', ')}; payments: stripe, stripe-webhook, evm-wallet, cdp; announcing: bluesky (an app password), mastodon (an access token).`); return; }
    const secret = await hiddenPrompt(`Key for ${name} (input hidden): `);
    if (!secret.trim()) { console.log('Nothing stored.'); return; }
    v.set(name, secret.trim());
    console.log(`Stored ${name}, encrypted on this device. It never goes into a record or over the network except to ${name}.`);
    return;
  }
  console.log('Usage: constellate keys set PROVIDER | list | remove PROVIDER');
}

function hiddenPrompt(q: string): Promise<string> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stdout.write(q);
    if (!stdin.isTTY) { let buf = ''; stdin.setEncoding('utf8'); stdin.on('data', (d) => (buf += d)); stdin.on('end', () => resolve(buf.split('\n')[0])); return; }
    let buf = '';
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
    const on = (ch: string) => {
      if (ch === '\r' || ch === '\n' || ch === '\u0004') { stdin.setRawMode(false); stdin.pause(); stdin.off('data', on); process.stdout.write('\n'); resolve(buf); }
      else if (ch === '\u0003') { process.stdout.write('\n'); process.exit(130); }
      else if (ch === '\u007f') buf = buf.slice(0, -1);
      else buf += ch;
    };
    stdin.on('data', on);
  });
}

function flag(args: string[], name: string) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; }

/** `constellate announce` (docs/ANNOUNCE.md): what to tell people, the owner's approval, and sending. */
async function announce(args: string[]) {
  const { Announcer } = await import('./announce/announce.js');
  const [sub, ...rest] = args;
  if (sub === 'set') {
    const a = new Announcer();
    const [what, v, extra] = rest;
    const onOff = () => { if (v !== 'on' && v !== 'off') throw new Error(`say on or off: constellate announce set ${what} on|off`); return v === 'on'; };
    if (!v) throw new Error('Usage: constellate announce set auto on|off | feed on|off | bluesky HANDLE [SERVER] | mastodon URL | cta URL (off removes an account)');
    const c = what === 'auto' ? a.setConfig({ auto: onOff() })
      : what === 'feed' ? a.setConfig({ feed: onOff() })
      : what === 'bluesky' ? a.setConfig({ bluesky: v === 'off' ? undefined : { handle: v.replace(/^@/, ''), ...(extra ? { service: extra } : {}) } })
      : what === 'mastodon' ? a.setConfig({ mastodon: v === 'off' ? undefined : { instance: v } })
      : what === 'cta' ? a.setConfig({ cta: v })
      : null;
    if (!c) throw new Error(`unknown setting: ${what}`);
    console.log(JSON.stringify(c, null, 2));
    if (what === 'bluesky' && c.bluesky) console.log('Store its app password with `constellate keys set bluesky` (Bluesky: Settings > Privacy and security > App passwords).');
    if (what === 'mastodon' && c.mastodon) console.log('Store an access token with `constellate keys set mastodon` (Preferences > Development > New application, with the write:statuses scope).');
    return;
  }
  if (sub === 'approve' || sub === 'skip') {
    const a = new Announcer();
    if (!rest[0]) throw new Error(`Usage: constellate announce ${sub} ID`);
    const item = sub === 'approve' ? a.approve(rest[0]) : a.skip(rest[0]);
    console.log(sub === 'approve' ? `Approved these exact words; \`constellate announce send --yes\` sends them:\n\n${item.text}` : `Skipped ${item.id}.`);
    return;
  }
  if (sub === 'send') {
    const yes = rest.includes('--yes');
    const r = await new Announcer().send({ yes });
    if (!r.length) console.log('Nothing is cleared to send. `constellate announce` shows what each item waits for.');
    for (const x of r) console.log(`${x.ok ? (yes ? 'sent' : 'would send') : 'not sent'}  ${x.id}${x.sink ? ` to ${x.sink}` : ''}: ${x.detail}`);
    if (!yes && r.some((x) => x.ok)) console.log('\nDry run: nothing was sent. Add --yes to send.');
    return;
  }
  if (sub && sub !== 'list') throw new Error(`unknown announce command: ${sub}`);
  const hub = await Hub.fromEnv();
  try {
    const a = new Announcer(hub);
    await a.collect();
    const items = a.list().filter((i) => i.status !== 'skipped');
    const c = a.config();
    const where = [c.feed ? `a feed file (${a.feedPath()})` : '', c.bluesky ? `Bluesky as @${c.bluesky.handle}` : '', c.mastodon ? `Mastodon at ${c.mastodon.instance}` : ''].filter(Boolean);
    console.log(`Sends to: ${where.join(', ') || 'nowhere yet'}. Automatic posting: ${c.auto ? 'on, for the auto tier' : 'off'}. X: by hand, from the link shown.\n`);
    if (!items.length) { console.log('Nothing to announce yet: progress shows up here once a step is checked by machine.'); return; }
    for (const i of items) {
      console.log(`${i.id}  ${i.tier === 'founder' ? 'needs you' : 'auto'} · ${i.kind}${i.backlog ? ' · from before announcing started' : ''} · ${i.status}`);
      if (i.text) console.log(i.text.split('\n').map((l) => `    ${l}`).join('\n'));
      if (i.x && !Object.keys(i.sent).length) console.log(`    Post on X yourself: ${i.x}`);
      console.log();
    }
    console.log('`constellate announce approve ID` approves the exact words above; `skip ID` drops one; `send` shows what would go (add --yes to send).');
  } finally { await hub.close(); }
}

/** What fits this machine, in plain words, with the exact commands. */
async function scout(args: string[]) {
  const { Scout, ideaFor, LANES } = await import('./scout/scout.js');
  const { REALMS } = await import('./work/problems.js');
  const s = new Scout();
  if (args.includes('--refresh')) {
    console.log('Reading the public catalogues (teorth/erdosproblems, google-deepmind/formal-conjectures)…');
    const r = await s.refresh();
    console.log(`Read ${r.erdos} Erdős problems and ${r.fc} formal-conjectures files on ${r.read}.\n`);
  }
  const id = flag(args, '--propose');
  if (id) {
    const c = s.get(id);
    if (!c) { console.log(`No problem with id ${id}. Run constellate scout to list them.`); process.exitCode = 1; return; }
    if (c.on_network) { console.log(`"${c.title}" is already on the network: open it in the app (constellate serve) and lend a computer to it.`); return; }
    const idea = ideaFor(c);
    console.log(`Title:  ${idea.title}\nRealm:  ${idea.realm}\nGoal:   ${idea.goal.split('\n').filter(Boolean).join('\n        ')}\nDone:   ${idea.done}`);
    console.log(`\nTo post it, open Proposals in the app (constellate serve), choose Suggested and press "Propose this" on it,\nor ask your agent to propose ${c.id} (the proposals_submit tool). It is checked against the constitution first.`);
    return;
  }
  const laneArg = flag(args, '--lane');
  const LANE_ARG: Record<string, (typeof LANES)[number]> = { quick: 'quick_win', quick_win: 'quick_win', moonshot: 'moonshot', formal: 'formal', needs_check: 'needs_check' };
  if (laneArg && laneArg !== 'all' && !LANE_ARG[laneArg]) { console.log('--lane is quick, moonshot, formal or all'); process.exitCode = 1; return; }
  const realm = flag(args, '--realm') as (typeof REALMS)[number] | undefined;
  if (realm && !REALMS.includes(realm)) { console.log(`--realm is one of ${REALMS.join(', ')}`); process.exitCode = 1; return; }
  const limit = Number(flag(args, '--limit')) || (laneArg ? 15 : 5);
  const all = args.includes('--all') || laneArg === 'all';
  const LABEL: Record<string, string> = { quick_win: 'Quick wins: a machine checks an answer, or a finite search could settle it', moonshot: 'Moonshots: big prizes and famous problems', formal: 'Stated in Lean: a proof is machine-checkable', needs_check: 'Not yet machine-checkable' };
  const lanes = laneArg && laneArg !== 'all' ? [LANE_ARG[laneArg]] : LANES.filter((l) => all || l !== 'needs_check');
  for (const l of lanes) {
    const r = s.list({ lane: l, realm, q: flag(args, '--q'), limit, all });
    console.log(`${LABEL[l]} (${r.counts[l]})`);
    for (const c of r.items) {
      console.log(`  ${String(c.score).padStart(3)}  ${c.title}${c.prize ? `  [${c.prize}]` : ''}${c.on_network ? '  (on the network)' : ''}`);
      if (c.statement) console.log(`       ${c.statement.length > 150 ? `${c.statement.slice(0, 147)}…` : c.statement}`);
      console.log(`       ${c.id} · ${c.field} · ${c.why[0] ?? ''}`);
    }
    console.log('');
  }
  const age = s.age();
  if (age === null) console.log('No catalogue on this computer yet: constellate scout --refresh reads the public ones (the app does this on its own).');
  else console.log(`Catalogues read ${age === 0 ? 'today' : `${age} day${age === 1 ? '' : 's'} ago`}${age >= 7 ? ' (constellate scout --refresh for the latest)' : ''}. Propose one: constellate scout --propose ID`);
}

async function models() {
  const device = detectDevice();
  const s = suggestFor(device);
  const gb = (m: { needGB: number }) => `~${m.needGB} GB`;
  console.log(`This machine: ${device.cpu}, ${device.cores} cores, ${device.memGB} GB memory${device.gpu ? `, ${device.gpu} (${device.gpuGB} GB)` : ''}.`);
  const servers = await findLocalServers();
  if (servers.length) {
    console.log('\nRunning now:');
    for (const sv of servers) {
      console.log(`  ${describeServer(sv)}: ${sv.models.length ? sv.models.slice(0, 6).map((m) => specFor(sv, m)).join(', ') : 'no model ready'}`);
      if (sv.note) console.log(`    ${sv.note}`);
    }
  }
  const best = bestCluster(servers);
  if (best) console.log(`\n${describeServer(best)} is ready. \`constellate contribute\` uses it on its own, for steps that need a big model.`);
  else if (!servers.some((sv) => sv.provider === 'exo')) console.log('\nMore than one computer? exo (github.com/exo-explore/exo) pools Macs into one bigger model, over Thunderbolt 5 or your network. Constellate finds it on its own.');
  if (s.primary) {
    console.log(`\nSuggested (free, open weights, runs on this machine; ${s.where}, ${s.budgetGB} GB left for a model):`);
    console.log(`  Main model:  ${s.primary.name} (${s.primary.family}, ${gb(s.primary)}) for ${s.primary.good}`);
    if (s.verifier) console.log(`  Checker:     ${s.verifier.name} (${s.verifier.family}, ${gb(s.verifier)}), a different family, checks other contributors' work`);
    for (const a of s.alternatives) console.log(`  Also fits:   ${a.name} (${a.family}, ${gb(a)})`);
  }
  for (const n of s.notes) console.log(`\n${n}`);
  if (!s.primary) { console.log('\nFree hosted options:'); for (const h of s.hosted) console.log(`  ${h.provider}/${h.model}  (${h.why})`); }
  console.log(`\nTo start:\n${commands(s).map((c) => `  ${c}`).join('\n')}`);
  console.log(`\nOr bring any model (--model PROVIDER/MODEL):`);
  for (const p of providerTable()) console.log(`  ${p.id.padEnd(12)} ${p.name.padEnd(28)} ${p.cost.padEnd(18)} ${p.key ? `key: ${p.key}` : p.url ? `url: ${p.url}` : ''}`);
  console.log(`\nModel list reviewed ${CATALOG_UPDATED}.`);
}

/**
 * `contribute` with no model named, when a pooled server is running: its model takes the big steps. A model this
 * computer already has running takes the small ones and checks other computers' work, if it is a different family.
 * Nothing is downloaded on the person's behalf; what's missing is said, with the command.
 */
async function clusterRunners(s: ReturnType<typeof suggestFor>, verifier?: string): Promise<{ runners: ModelRunner[]; notes: string[] } | undefined> {
  const plan = clusterPlan(await findLocalServers(), s);
  if (!plan) return undefined;
  const runners = plan.specs.map((spec) => runnerFromSpec(spec, { vault: vault() }));
  if (verifier) runners.push(runnerFromSpec(verifier, { vault: vault() }));
  const notes = [`Found ${describeServer(plan.server)}: ${plan.server.models[0]} takes ${plan.big ? 'the steps that need a big model' : 'the steps'}.`];
  if (runners.length === 1 && s.primary) notes.push(`For small steps and checking others' work too: ${commands(s)[0]}, then run this again.`);
  return { runners, notes };
}

async function contribute(args: string[]) {
  const hub = await Hub.fromEnv();
  const device = detectDevice();
  const s = suggestFor(device);
  const endpoint = flag(args, '--endpoint');
  let spec = flag(args, '--model');
  if (args.includes('--claude')) spec = 'anthropic/claude-opus-5-5';
  if (endpoint && spec && !spec.includes('/')) spec = `custom/${spec}`;
  // No model named: computers pooled with this one (exo, CONSTELLATE_CLUSTER_URL) come first, as the biggest.
  const pooled = spec ? undefined : await clusterRunners(s, flag(args, '--verifier'));
  if (!spec && !pooled) {
    if (!s.primary) { console.log(`${s.notes[0]}\nTry a free hosted model: ${commands(s)[0]}`); return; }
    spec = `${s.primary.run.provider}/${s.primary.run.model}`;
  }
  const runners: ModelRunner[] = pooled?.runners ?? [runnerFromSpec(spec!, { endpoint, family: flag(args, '--family'), vault: vault() })];
  const verifierSpec = pooled ? undefined : flag(args, '--verifier') ?? (flag(args, '--model') ? undefined : s.verifier ? `${s.verifier.run.provider}/${s.verifier.run.model}` : undefined);
  if (verifierSpec) runners.push(runnerFromSpec(verifierSpec, { endpoint, vault: vault() }));
  for (const line of pooled?.notes ?? []) console.log(line);
  console.log(`Device: ${device.cpu}, ${device.memGB} GB${device.gpu ? `, ${device.gpu}` : ''}. Models: ${runners.map((r) => `${r.id} (${r.family})`).join(', ')}.`);
  const board = hub.x0x ? new X0xBoard(hub.x0x, 'constellate/v1/board') : new MemoryBoard();
  const budget = new Budget(Number(flag(args, '--cap-cents') ?? 0) || (runners.some((r) => r.costPerCall) ? 100 : Infinity));
  const policy = { ...POLITE };
  // --lend: the desktop app's one-click switch (src/contributor/lend.ts): the person's limits, a log, a pledge.
  const lend = args.includes('--lend') ? new Lend() : null;
  let pledged = -1;
  const applyLimits = async () => {
    if (!lend) return;
    const l = lend.limits();
    Object.assign(policy, policyFor(l, { ...POLITE, paused: policy.paused }));
    const hours = l.hoursPerNight * 7;
    if (hours !== pledged) { pledged = hours; await hub.collective.pledge(hours).catch(() => {}); } // compute_pledge, so votes weigh it once delivered
  };
  await applyLimits();
  if (lend) {
    // Turned off from the app (the process is stopped): the pledge goes back to zero before it exits.
    const stop = () => { void hub.collective.pledge(0).catch(() => {}).finally(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); };
    process.once('SIGTERM', stop); process.once('SIGINT', stop);
  }
  const workers = runners.map((r) => new Worker(hub, r, hub.problems, board, { policy, power: readConditions, budget }));
  // The contributor app: status and controls in the browser, on this machine only. --no-ui to skip.
  if (!args.includes('--no-ui')) {
    const web = new WebServer(hub);
    registerAppRoutes(web);
    registerContributorRoutes(web, { workers, budget, policy, device, lend: lend ?? undefined });
    await web.listen(Number(flag(args, '--port') ?? 4748), '127.0.0.1');
    console.log(`Status and controls: ${web.url}/#/compute`);
  }
  let last = '';
  for (;;) {
    let didWork = false;
    await applyLimits(); // the app may have changed them
    if (lend && !lend.underTonight()) {
      for (const w of workers) w.status = { state: 'waiting', message: `Done for tonight: ${lend.limits().hoursPerNight} hours used. Back tomorrow night.` };
    } else for (const worker of workers) for (const p of hub.problems.list()) {
      const t0 = Date.now();
      worker.last = undefined;
      const o = await worker.step(p.rec.id).catch((e) => { console.error(String(e)); return 'idle' as const; });
      if (o === 'idle' || o === 'paused') continue;
      didWork = true;
      if (lend) {
        const ms = Date.now() - t0;
        lend.addUsage(ms / 1000);
        const did = worker.last as Worker['last']; // set by step()
        if (did) lend.record({ at: new Date().toISOString(), ...did, outcome: o, seconds: Math.round(ms / 100) / 10 });
        // The CPU cap: rest in proportion to the time just worked.
        const rest = restAfter(ms, lend.limits().cpuCapPct);
        if (rest > 0) await new Promise((r) => setTimeout(r, Math.min(rest, 10 * 60_000)));
        if (!lend.underTonight()) break;
      }
    }
    const msg = workers[0].status.message;
    if (msg !== last) { console.log(`● ${msg}`); last = msg; }
    if (!didWork) await new Promise((r) => setTimeout(r, 30_000));
  }
}

main(process.argv.slice(2)).catch((e) => { console.error(e); process.exit(1); });
