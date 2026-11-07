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
import { registerContributorRoutes } from './contributor/dashboard.js';
import { runnerFromSpec, providerTable, commands, CATALOG_UPDATED, PROVIDERS } from './contributor/catalog.js';
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
  constellate models     What this machine can run: free open-weight models that fit, and every provider
  constellate contribute Donate idle compute: detect hardware, pick a model, work politely
      [--model PROVIDER/MODEL] [--verifier PROVIDER/MODEL] [--cap-cents N] [--endpoint URL] [--no-ui] [--port N]
      Opens status and controls (pause, plugged-in only, battery, hours, heat) at http://127.0.0.1:4748
      Any model works: ollama/qwen3:14b, lmstudio/…, groq/llama-3.3-70b-versatile,
      openrouter/<any>, huggingface/…, gemini/…, openai/…, anthropic/claude-opus-5-5,
      custom/NAME --endpoint URL. Keys come from the provider's variable (e.g. GROQ_API_KEY).

Environment: X0X_API (default http://127.0.0.1:12700), CONSTELLATE_HOME (~/.constellate),
CONSTELLATE_PREVIEW=off, CONSTELLATE_PRIVACY=standard|strict, CONSTELLATE_DENY_TERMS=a,b`;

async function main(argv: string[]) {
  const cmd = argv[0];
  if (cmd === 'mcp') {
    const hub = argv.includes('--private') ? await Hub.privateMode() : await Hub.fromEnv();
    if (!argv.includes('--private')) importStarter(hub);
    const server = createMcpServer(hub);
    await server.connect(new StdioServerTransport());
    return;
  }
  if (cmd === 'status') { const hub = await Hub.fromEnv(); console.log(JSON.stringify(hub.status(), null, 2)); await hub.close(); return; }
  if (cmd === 'setup') {
    // Until the npm name is ours, every snippet points at this clone's built CLI, never npx and the unclaimed name.
    const cli = fileURLToPath(new URL(import.meta.url.endsWith('.ts') ? '../dist/cli.js' : './cli.js', import.meta.url));
    const cfg = JSON.stringify({ command: 'node', args: [cli, 'mcp'] });
    console.log(`Connect your agent to Constellate (this folder: ${dirname(dirname(cli))})

Claude Code:     claude mcp add constellate -- node "${cli}" mcp
Claude Desktop:  add to claude_desktop_config.json → {"mcpServers": {"constellate": ${cfg}}}
Cursor:          add to ~/.cursor/mcp.json → {"mcpServers": {"constellate": ${cfg}}}
Any MCP client:  node "${cli}" mcp   (over stdio)

Lend your computer instead: node "${cli}" models, then node "${cli}" contribute`);
    return;
  }
  if (cmd === 'keys') return keys(argv.slice(1));
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
    const spec = flag(argv, '--model');
    const model = spec ? runnerFromSpec(spec, { vault: vault() }) : undefined;
    if (model) hub.collective.constitution.attachReviewer(model);
    const web = new WebServer(hub);
    registerAppRoutes(web, { guideModel: model });
    registerEconomyRoutes(web, economy);
    registerFundingRoutes(web, hub, { ledger: credits, cfg: funding, autonomi: hub.archive instanceof AutonomiArchive ? hub.archive : null, publicUrl: process.env.CONSTELLATE_PUBLIC_URL });
    await web.listen(Number(process.env.PORT ?? 4747));
    if (funding) console.log(`Payments: ${funding.mode === 'live' ? 'LIVE (real money)' : 'test mode'}${funding.stripe ? ' · Stripe' : ''}${funding.usdc ? ` · USDC on ${funding.usdc.network} to ${funding.usdc.depositAddress}` : ''}`);
    if (hub.archive instanceof AutonomiArchive) console.log('Archive: Autonomi mainnet (paid, capped daily)');
    new Consolidator(hub, model).schedule(); // "sleep" every 6 hours: distil related lessons into topic pages
    hub.pages.schedule(); // "dream" every 6 hours: re-check pages whose evidence changed (docs/MEMORY.md)
    // Skills across x0x (docs/X0X_SKILLS.md): publish ours to a public x0x data store, keep a public group, pull others'.
    if (hub.x0x) { const sk = () => void hub.x0xSkills.sync().catch(() => {}); setTimeout(sk, 45_000).unref(); setInterval(sk, 6 * 3600_000).unref(); }
    if (model) { const { Deliberation } = await import('./collective/deliberation.js'); new Deliberation(hub).scheduleReruns(model); } // debates revisited as models change
    if (model) console.log(`Model: ${model.id} (guide, constitution review, summaries, debate re-runs)`);
    // Incoming direct messages: history sync between computers, otherwise a person's message for the app's inbox.
    hub.x0x?.directEvents((m) => { if (!hub.sync.handle(m.sender, m.payload)) hub.people.receive(m.sender, m.payload); });
    // Catch up: gossip has no replay, so ask a few online peers for what this computer missed (docs/STORAGE.md).
    if (hub.x0x) setTimeout(() => void hub.x0x!.presenceOnline().then((ids) => hub.sync.request(ids)).catch(() => {}), 15_000).unref();
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
    console.log(`Starter library: ${r.ok} signed lessons from public history${r.rejected ? ` (${r.rejected} refused)` : ''}`);
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
    if (!PROVIDERS.some((p) => p.id === name) && !['stripe', 'stripe-webhook', 'evm-wallet', 'cdp'].includes(name)) { console.log(`Unknown name "${name}". Providers: ${PROVIDERS.map((p) => p.id).join(', ')}; payments: stripe, stripe-webhook, evm-wallet, cdp.`); return; }
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

/** What fits this machine, in plain words, with the exact commands. */
function models() {
  const device = detectDevice();
  const s = suggestFor(device);
  const gb = (m: { needGB: number }) => `~${m.needGB} GB`;
  console.log(`This machine: ${device.cpu}, ${device.cores} cores, ${device.memGB} GB memory${device.gpu ? `, ${device.gpu} (${device.gpuGB} GB)` : ''}.`);
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
  for (const p of providerTable()) console.log(`  ${p.id.padEnd(12)} ${p.name.padEnd(28)} ${p.cost.padEnd(18)} ${p.key ? `key: ${p.key}` : ''}`);
  console.log(`\nModel list reviewed ${CATALOG_UPDATED}.`);
}

async function contribute(args: string[]) {
  const hub = await Hub.fromEnv();
  const device = detectDevice();
  const s = suggestFor(device);
  const endpoint = flag(args, '--endpoint');
  let spec = flag(args, '--model');
  if (args.includes('--claude')) spec = 'anthropic/claude-opus-5-5';
  if (endpoint && spec && !spec.includes('/')) spec = `custom/${spec}`;
  if (!spec) {
    if (!s.primary) { console.log(`${s.notes[0]}\nTry a free hosted model: ${commands(s)[0]}`); return; }
    spec = `${s.primary.run.provider}/${s.primary.run.model}`;
  }
  const runners: ModelRunner[] = [runnerFromSpec(spec, { endpoint, family: flag(args, '--family'), vault: vault() })];
  const verifierSpec = flag(args, '--verifier') ?? (flag(args, '--model') ? undefined : s.verifier ? `${s.verifier.run.provider}/${s.verifier.run.model}` : undefined);
  if (verifierSpec) runners.push(runnerFromSpec(verifierSpec, { endpoint, vault: vault() }));
  console.log(`Device: ${device.cpu}, ${device.memGB} GB${device.gpu ? `, ${device.gpu}` : ''}. Models: ${runners.map((r) => `${r.id} (${r.family})`).join(', ')}.`);
  const board = hub.x0x ? new X0xBoard(hub.x0x, 'constellate/v1/board') : new MemoryBoard();
  const budget = new Budget(Number(flag(args, '--cap-cents') ?? 0) || (runners.some((r) => r.costPerCall) ? 100 : Infinity));
  const policy = { ...POLITE };
  const workers = runners.map((r) => new Worker(hub, r, hub.problems, board, { policy, power: readConditions, budget }));
  // The contributor app: status and controls in the browser, on this machine only. --no-ui to skip.
  if (!args.includes('--no-ui')) {
    const web = new WebServer(hub);
    registerAppRoutes(web);
    registerContributorRoutes(web, { workers, budget, policy, device });
    await web.listen(Number(flag(args, '--port') ?? 4748), '127.0.0.1');
    console.log(`Status and controls: ${web.url}/#/compute`);
  }
  let last = '';
  for (;;) {
    let didWork = false;
    for (const worker of workers) for (const p of hub.problems.list()) {
      const o = await worker.step(p.rec.id).catch((e) => { console.error(String(e)); return 'idle' as const; });
      if (o !== 'idle' && o !== 'paused') didWork = true;
    }
    const msg = workers[0].status.message;
    if (msg !== last) { console.log(`● ${msg}`); last = msg; }
    if (!didWork) await new Promise((r) => setTimeout(r, 30_000));
  }
}

main(process.argv.slice(2)).catch((e) => { console.error(e); process.exit(1); });
