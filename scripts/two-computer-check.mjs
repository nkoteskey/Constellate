#!/usr/bin/env node
/**
 * Two-computer check (docs/NETWORK.md): does a lesson shared on one computer reach another over the public
 * x0x network, and how long does it take?
 *
 *   Computer A:  node scripts/two-computer-check.mjs share
 *                → joins the network, shares one uniquely tagged failure, prints its tag
 *   Computer B:  node scripts/two-computer-check.mjs wait <tag>
 *                → joins the network, polls failures_search until the tagged failure shows up, prints the delay
 *
 * Both sides run Constellate exactly as an agent does: an MCP client talking to `constellate mcp` over stdio,
 * with CONSTELLATE_X0X=auto, so x0x is set up and joined the same way it is for anyone using the npm package.
 *
 * Options:
 *   --cli "<command>"   how to start Constellate (default: this checkout's dist/cli.js, else npx -y constellate-mcp)
 *   --timeout <sec>     how long to wait for the network and for the failure (default 600)
 *   --every <sec>       how often B searches (default 2)
 *
 * The delay is measured from the time A put in the record to the time B first saw it, so it depends on the two
 * clocks agreeing; B also prints how long it waited itself. Nothing personal goes into the record: the tag is
 * random and the text is fixed.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : dflt; };
const role = args[0];
const timeoutMs = Number(opt('timeout', '600')) * 1000;
const everyMs = Number(opt('every', '2')) * 1000;
const localCli = join(here, '..', 'dist', 'cli.js');
const cli = (opt('cli', '') || (existsSync(localCli) ? `node ${localCli}` : 'npx -y constellate-mcp')).split(' ').filter(Boolean);
const say = (l) => process.stdout.write(`${l}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TAG_RE = /^[a-z0-9]{10}$/;
const newTag = () => randomBytes(8).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '').padEnd(10, '0').slice(0, 10);
const approachFor = (tag, at) => `two-computer-check ${tag}: a test failure shared at ${at} to time how long it takes to reach another computer`;

async function connect() {
  const transport = new StdioClientTransport({
    command: cli[0], args: [...cli.slice(1), 'mcp'],
    // The full tool set, so the check can ask hub_status whether it's on the network; published at once.
    env: { ...process.env, CONSTELLATE_X0X: process.env.CONSTELLATE_X0X ?? 'auto', CONSTELLATE_MCP_TOOLS: 'full', CONSTELLATE_PREVIEW: 'off' },
    stderr: 'inherit',
  });
  const client = new Client({ name: 'two-computer-check', version: '1' });
  await client.connect(transport);
  const call = async (name, a = {}) => {
    const r = await client.callTool({ name, arguments: a });
    const text = r.content?.[0]?.text ?? 'null';
    const j = JSON.parse(text);
    if (r.isError) throw new Error(j.error ?? text);
    return j;
  };
  return { client, call };
}

/** Wait until this computer's Constellate is on the x0x network (it sets x0x up on its own the first time). */
async function online(call, deadline) {
  let told = '';
  for (;;) {
    const s = await call('hub_status');
    if (!String(s.x0x).startsWith('offline')) { say(`On the x0x network as ${String(s.agent_id).slice(0, 8)} (${s.x0x}).`); return s; }
    const note = (await call('failures_search', { query: 'two-computer-check', limit: 1 })).network;
    if (note && note !== told) { told = note; say(note); }
    if (Date.now() > deadline) throw new Error('not on the x0x network yet: check the log above (CONSTELLATE_X0X must not be off)');
    await sleep(2000);
  }
}

async function share() {
  const { client, call } = await connect();
  try {
    await online(call, Date.now() + timeoutMs);
    const tag = newTag(), at = new Date().toISOString();
    const r = await call('failures_report', {
      task: 'Two-computer check of the Constellate network', domain: ['constellate', 'network-check'], environment: 'two-computer-check script',
      approach: approachFor(tag, at), outcome: 'error', error_summary: 'Not a real failure: a timing probe for the two-computer check', publish: true,
    });
    say(`Shared failure ${r.id} at ${at}.`);
    say(`Tag: ${tag}`);
    say(`On the other computer run:  node scripts/two-computer-check.mjs wait ${tag}`);
    // Stay connected a little so the share has gone out, and so this computer can answer catch-up requests.
    const stay = Number(opt('stay', '120')) * 1000;
    say(`Staying on the network for ${Math.round(stay / 1000)} s so the other computer can also catch up from here…`);
    await sleep(stay);
  } finally { await client.close(); }
}

async function wait(tag) {
  if (!TAG_RE.test(tag ?? '')) throw new Error('give the tag the other computer printed: wait <tag>');
  const { client, call } = await connect();
  const started = Date.now();
  try {
    const joined = await online(call, started + timeoutMs);
    void joined;
    say(`Searching for ${tag} every ${everyMs / 1000} s…`);
    for (;;) {
      const r = await call('failures_search', { query: `two-computer-check ${tag}`, domain: ['network-check'], limit: 5 });
      const hit = (r.results ?? []).find((x) => String(x.approach ?? '').includes(`two-computer-check ${tag}:`));
      if (hit) {
        const seen = Date.now();
        const sharedAt = Date.parse(String(hit.approach).match(/shared at (\S+) to time/)?.[1] ?? '');
        say(`Arrived: failure ${hit.id}.`);
        if (Number.isFinite(sharedAt)) say(`Delay: ${((seen - sharedAt) / 1000).toFixed(1)} s from when it was shared (assumes the two clocks agree).`);
        say(`Waited here: ${((seen - started) / 1000).toFixed(1)} s, including joining the network.`);
        say('RESULT: ok');
        return;
      }
      if (Date.now() - started > timeoutMs) { say(`RESULT: not seen within ${timeoutMs / 1000} s`); process.exitCode = 1; return; }
      await sleep(everyMs);
    }
  } finally { await client.close(); }
}

const main = role === 'share' ? share() : role === 'wait' ? wait(args[1]) : Promise.reject(new Error('usage: two-computer-check.mjs share | wait <tag>  [--cli "<command>"] [--timeout SEC] [--every SEC] [--stay SEC]'));
main.catch((e) => { console.error(e.message); process.exitCode = 1; }).finally(() => setTimeout(() => process.exit(), 200).unref());
