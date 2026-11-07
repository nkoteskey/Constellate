import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { decodeCanonical } from '../core/canonical.js';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpReply, RawReply, StreamReply, WebServer } from './server.js';
import { Guide } from './guide.js';
import { ProblemSpaces } from '../x0x/spaces.js';
import { Deliberation } from '../collective/deliberation.js';
import { verifyRecord, SignedRecord, RecordKind } from '../core/record.js';
import { scrub, readableBody } from '../privacy/scrub.js';
import { StoredRecord } from '../store/records.js';
import { REALMS, ProblemBody } from '../work/problems.js';
import { verifyOperatorClaim, OperatorClaim } from '../core/operator.js';
import { fromB64, utf8 } from '../util/bytes.js';
import { peerIdFromPublicKey, verifyExternal } from '../core/identity.js';
import { familyOf } from './public/js/models.js';
import { ModelRunner } from '../contributor/models.js';

/** Kinds a person can sign in the browser. Each one with more than a simple shape gets its own check below. */
const HUMAN_KINDS: RecordKind[] = ['rating', 'confirmation', 'contradiction', 'vote', 'argument', 'position', 'pledge', 'message', 'use',
  'proposal', 'answer', 'task_result', 'challenge', 'piece', 'curation', 'identity_link', 'ruling', 'payout_address'];

export const REALM_INFO: Record<string, { name: string; colour: string; judged: string }> = {
  maths_physics: { name: 'Mathematics and physics', colour: '#7aa2ff', judged: 'Machine-checked' },
  life_sciences: { name: 'Life sciences', colour: '#6fe3b4', judged: 'Machine-scored, with extra safety review' },
  planet_energy: { name: 'Planet and energy', colour: '#9ad66b', judged: 'Machine-scored' },
  philosophy_ethics: { name: 'Philosophy and ethics', colour: '#d9a6ff', judged: 'Deliberation maps, rated by humans' },
  art_creativity: { name: 'Art and creativity', colour: '#ff9fb2', judged: 'Appreciated, not scored; humans curate' },
};

const isHuman = (s: StoredRecord) => /^human\b/.test(s.rec.context.environment);
/** Find an installed package's directory by walking up node_modules (works under any loader). */
const pkgDir = (name: string) => {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const cand = join(dir, 'node_modules', name);
    if (existsSync(join(cand, 'package.json'))) return cand;
    const up = dirname(dir);
    if (up === dir) return '';
    dir = up;
  }
};
const VENDOR: Record<string, string> = {
  '@noble/post-quantum': pkgDir('@noble/post-quantum'),
  '@noble/hashes': pkgDir('@noble/hashes'),
  '@noble/curves': pkgDir('@noble/curves'),
  cborg: pkgDir('cborg'),
};

/** The human app API: the living sky, problem pages, deliberations, Me, and signed contributions from the browser. */
export function registerAppRoutes(web: WebServer, opts: { guideModel?: ModelRunner } = {}) {
  const hub = web.hub;
  const guide = new Guide(hub, opts.guideModel);
  const guide_ = guide;
  const delib = new Deliberation(hub);
  const spaces = new ProblemSpaces(hub);

  web.route('GET', /^\/vendor\/(@noble\/post-quantum|@noble\/hashes|@noble\/curves|cborg)\/(.+\.js)$/, (_r, m) => {
    const base = VENDOR[m[1]];
    const file = join(base, m[2].replace(/\.\.+/g, ''));
    if (!base || !file.startsWith(base) || !existsSync(file)) throw Object.assign(new Error('not found'), { status: 404 });
    return new RawReply(readFileSync(file), 'text/javascript');
  });

  const activity = (id: string) => {
    // Everything in the thread counts: ratings on arguments on positions on a debate, confirmations on checkpoints…
    const refs: StoredRecord[] = [];
    const seen = new Set<string>();
    const walk = (x: string, depth: number) => { for (const r of hub.node.store.referencing(x)) { if (seen.has(r.rec.id)) continue; seen.add(r.rec.id); refs.push(r); if (depth < 3) walk(r.rec.id, depth + 1); } };
    walk(id, 0);
    const day = Date.now() - 86_400_000;
    const ops = new Map<string, 'human' | 'agent'>();
    for (const r of refs) ops.set(r.operatorId, isHuman(r) ? 'human' : 'agent');
    return { recent: refs.filter((r) => Date.parse(r.rec.created) > day).length, total: refs.length, agents: [...ops.values()].filter((v) => v === 'agent').length, humans: [...ops.values()].filter((v) => v === 'human').length, last: refs.map((r) => r.rec.created).sort().at(-1) ?? null };
  };

  web.route('GET', /^\/api\/sky$/, async () => {
    const problems = [];
    for (const p of hub.problems.list()) {
      const s = await hub.problems.summary(p.rec.id);
      problems.push({ id: s.id, title: s.title, hook: s.hook, realm: s.realm, kind: 'problem', progress: s.progress, activity: activity(s.id) });
    }
    for (const q of delib.questions()) {
      const b = q.rec.body as { question: string; hook: string; realm: string };
      problems.push({ id: q.rec.id, title: b.question, hook: b.hook, realm: b.realm, kind: 'deliberation', progress: null, activity: activity(q.rec.id) });
    }
    // Three highlighted problems, most active first, one per realm so the sky invites rather than overwhelms.
    const featured: string[] = [];
    const realmsUsed = new Set<string>();
    const ranked = [...problems].filter((p) => p.hook).sort((a, b) => b.activity.recent - a.activity.recent || b.activity.total - a.activity.total);
    // Two problems plus one debate when there is one: rating an argument is the gentlest first contribution.
    const debate = ranked.find((p) => p.kind === 'deliberation');
    for (const p of ranked.filter((p) => p.kind !== 'deliberation')) {
      if (featured.length < (debate ? 2 : 3) && !realmsUsed.has(p.realm)) { featured.push(p.id); realmsUsed.add(p.realm); }
    }
    if (debate) featured.push(debate.id);
    const all = hub.node.store.all().filter((s) => s.visibility === 'public');
    const people = new Set(all.filter((s) => /^human\b/.test(s.rec.context.environment)).map((s) => s.operatorId));
    const agentOps = new Set(all.filter((s) => !/^human\b/.test(s.rec.context.environment)).map((s) => s.operatorId));
    const day = Date.now() - 86_400_000;
    const stats = {
      agents: agentOps.size, people: people.size,
      verified_today: all.filter((s) => s.rec.kind === 'checkpoint' && Date.parse(s.rec.created) > day).length,
      verified: all.filter((s) => s.rec.kind === 'checkpoint').length,
      shared: all.filter((s) => s.rec.kind === 'failure' || s.rec.kind === 'answer').length,
      bridges: hub.graph.bridges().length,
      fixes: all.filter((s) => s.rec.kind === 'answer').length,
      topics: new Set(all.filter((s) => s.rec.kind === 'summary').map((s) => (s.rec.body as { cluster: string }).cluster)).size,
      sources: new Set(all.flatMap((s) => s.rec.evidence).map((u) => u.match(/github\.com\/([\w.-]+\/[\w.-]+)\//)?.[1]).filter(Boolean)).size,
    };
    return { line: 'Thousands of minds, working on humanity\'s hardest problems, right now.', demo: process.env.CONSTELLATE_DEMO === '1', stats, realms: REALMS.map((r) => ({ id: r, ...REALM_INFO[r] })), problems, featured };
  });

  web.route('GET', /^\/api\/snapshot$/, async () => { const { exportSnapshot } = await import('../seed/snapshot.js'); return new RawReply(Buffer.from(exportSnapshot(hub.node.store)), 'application/cbor'); });

  web.route('GET', /^\/\.well-known\/agent-card\.json$/, async () => {
    const { agentCard } = await import('../economy/a2a.js');
    let base: Record<string, unknown> = {};
    if (hub.x0x) { try { base = (await (await fetch(`${hub.x0x.baseUrl}/.well-known/agent-card.json`)).json()) as Record<string, unknown>; } catch { /* daemon card unavailable */ } }
    return agentCard(hub, base, { url: web.url });
  });
  // Who's who: the starter library's seed identity and this computer's own agent get plain labels.
  const roleOf = (op: string) => (starterOperators().has(op) ? 'starter' : op === hub.node.operatorId ? 'this-computer' : undefined);
  web.route('GET', /^\/api\/people$/, (_r, _m, url) => hub.people.discover({ kind: (url.searchParams.get('kind') as 'human' | 'agent' | null) ?? undefined, q: url.searchParams.get('q') ?? undefined, realm: url.searchParams.get('realm') ?? undefined, problem: url.searchParams.get('problem') ?? undefined }).map((p) => ({ ...p, role: roleOf(p.operator) })));
  web.route('GET', /^\/api\/chat\/([0-9a-f]{64})$/, async (_r, m) => {
    const local = hub.people.chat(m[1]);
    if (!spaces.available) return local;
    const outside = await spaces.outside(m[1], new Set(local.map((c) => c.text)));
    return [...local, ...outside].sort((a, b) => a.at.localeCompare(b.at));
  });
  web.route('GET', /^\/api\/presence$/, async () => ({ via: spaces.available ? 'x0x' : 'none', online: [...(await spaces.onlineIds())] }));
  web.route('GET', /^\/api\/problems\/([0-9a-f]{64})\/space$/, async (_r, m) => ({ available: spaces.available, invite: spaces.available ? await spaces.invite(m[1]) : null }));
  web.route('GET', /^\/api\/graph$/, () => {
    // Threads between nebulae: real links between records in different problems, strongest first.
    const rootOf = (id: string) => { let s = hub.node.store.get(id); for (let i = 0; i < 6 && s && !['problem', 'proposal'].includes(s.rec.kind); i++) s = s.rec.refs[0] ? hub.node.store.get(s.rec.refs[0]) : undefined; return s && ['problem', 'proposal'].includes(s.rec.kind) ? s.rec.id : null; };
    const threads = new Map<string, { a: string; b: string; weight: number; bridge: boolean }>();
    const bridges = new Set(hub.graph.bridges().map((b) => b.edge));
    for (const e of hub.graph.edges()) {
      if (e.type === 'confirms' || e.type === 'contradicts') continue;
      const a = rootOf(e.from), b = rootOf(e.to);
      if (!a || !b || a === b) continue;
      const k = [a, b].sort().join(':');
      const t = threads.get(k) ?? { a, b, weight: 0, bridge: false };
      t.weight += hub.graph.weight(e); t.bridge ||= bridges.has(e.key);
      threads.set(k, t);
    }
    return { threads: [...threads.values()].sort((x, y) => y.weight - x.weight).slice(0, 60), bridges: hub.graph.bridges().slice(0, 10) };
  });
  web.route('GET', /^\/api\/metrics$/, () => hub.metrics.report());
  web.route('POST', /^\/api\/metrics\/event$/, async (_r, _m, _u, body) => {
    const b = await body();
    if (b.type === 'first_contribution') hub.metrics.firstContributionSeconds(Number(b.seconds));
    else if (b.type === 'share' || b.type === 'invite') hub.metrics.event(b.type, String(b.who ?? 'anon').slice(0, 64));
    return { ok: true };
  });
  const challenges = () => hub.node.store.ofKind('challenge').map((c) => {
    const b = c.rec.body as { team: string; goal: number; ends: string; title?: string };
    const since = c.rec.created;
    const done = hub.node.store.all().filter((s) => (s.rec.body as { team?: string }).team === b.team && /^human\b/.test(s.rec.context.environment) && s.rec.created >= since && s.rec.created <= b.ends).length;
    return { id: c.rec.id, team: b.team, title: b.title ?? `${b.goal} contributions`, goal: b.goal, ends: b.ends, done, by: c.rec.agent_id };
  }).sort((a, b) => a.ends.localeCompare(b.ends));
  web.route('GET', /^\/api\/teams$/, () => {
    const teams = new Map<string, { team: string; members: Set<string>; contributions: number }>();
    for (const s of hub.node.store.all()) {
      const t = (s.rec.body as { team?: string }).team;
      if (!t || !/^human\b/.test(s.rec.context.environment)) continue;
      const x = teams.get(t) ?? { team: t, members: new Set<string>(), contributions: 0 };
      x.members.add(s.operatorId); x.contributions++; teams.set(t, x);
    }
    return [...teams.values()].map((t) => ({ team: t.team, members: t.members.size, contributions: t.contributions })).sort((a, b) => b.contributions - a.contributions);
  });
  web.route('GET', /^\/api\/huddle\/([0-9a-f]{64})$/, (_r, m) => hub.collab.huddle(m[1]));

  web.route('GET', /^\/api\/deliberations$/, () => delib.questions().map((q) => ({ id: q.rec.id, ...(q.rec.body as object) })));
  web.route('GET', /^\/api\/deliberations\/([0-9a-f]{64})$/, (_r, m) => delib.map(m[1]));

  web.route('GET', /^\/api\/problems\/([0-9a-f]{64})\/page$/, async (_r, m) => {
    const s = await hub.problems.summary(m[1]);
    const recent = hub.node.store.referencing(m[1]).filter((r) => r.visibility === 'public').sort((a, b) => b.rec.created.localeCompare(a.rec.created)).slice(0, 40).map((r) => {
      const b = r.rec.body as { chunk?: string; family?: string; verifier_family?: string; ok?: boolean };
      return { id: r.rec.id, kind: r.rec.kind, at: r.rec.created, by: isHuman(r) ? 'human' : 'agent', who: r.rec.agent_id, says: describe(r), chunk: b.chunk, family: b.verifier_family ?? b.family };
    });
    const people = new Map<string, { id: string; type: string; contributions: number }>();
    for (const r of hub.node.store.referencing(m[1])) { const p = people.get(r.operatorId) ?? { id: r.operatorId, type: isHuman(r) ? 'human' : 'agent', contributions: 0 }; p.contributions++; people.set(r.operatorId, p); }
    const votes = hub.collective.tally(m[1]);
    const constitution = hub.collective.constitution.status(m[1]);
    const prob = hub.problems.body(m[1]);
    const done = new Set(s.checkpoints.map((c) => c.chunk));
    const reviewing = new Set(hub.node.store.referencing(m[1], 'constitution_check').filter((c) => (c.rec.body as { stage: string; needs_human: boolean }).stage === 'checkpoint' && (c.rec.body as { needs_human: boolean }).needs_human).map((c) => { const r = hub.node.store.get(c.rec.refs[1]); return (r?.rec.body as { chunk?: string } | undefined)?.chunk; }));
    const steps = prob.chunks.map((c) => ({ key: c.key, title: c.title, state: done.has(c.key) ? 'done' : reviewing.has(c.key) && constitution.state === 'awaiting_review' ? 'review' : 'open' }));
    return { ...s, steps, realm_info: REALM_INFO[s.realm], recent, people: [...people.values()].sort((a, b) => b.contributions - a.contributions).slice(0, 30), votes, constitution };
  });

  web.route('GET', /^\/api\/proposals$/, () => hub.collective.queue(5));

  web.route('GET', /^\/api\/me\/([0-9a-f]{64})$/, (_r, m) => {
    const mine = hub.node.store.all().filter((s) => s.rec.agent_id === m[1] || s.operatorId === m[1]);
    const helped = new Set<string>();
    for (const s of mine) for (const r of s.rec.refs) { let t = hub.node.store.get(r); while (t && !['problem', 'proposal'].includes(t.rec.kind) && t.rec.refs[0]) t = hub.node.store.get(t.rec.refs[0]); if (t && ['problem', 'proposal'].includes(t.rec.kind)) helped.add(t.rec.id); }
    const receipts = hub.economy?.receipts({ payee: m[1] }) ?? [];
    return {
      id: m[1], role: roleOf(m[1]), contributions: mine.length, by_kind: mine.reduce<Record<string, number>>((a, s) => ((a[s.rec.kind] = (a[s.rec.kind] ?? 0) + 1), a), {}),
      helped: [...helped].map((id) => { const b = hub.node.store.get(id)!.rec.body as { title?: string; question?: string }; return { id, title: b.title ?? b.question }; }),
      reputation: hub.reputation.profile(m[1]), credit: receipts.reduce((n, r) => n + r.b.amount, 0),
      pledged_hours: hub.collective.pledged(m[1]),
      linked_user: (() => { const l = mine.filter((s) => s.rec.kind === 'identity_link' && (s.rec.body as { claim?: OperatorClaim }).claim).sort((a, b) => b.rec.created.localeCompare(a.rec.created))[0]; return l ? (l.rec.body as { claim: OperatorClaim }).claim.user_id : null; })(),
      // This computer's x0x agent vouching for the person's key (desktop app, one click); re-verified on every read.
      linked_x0x: (() => { const l = mine.filter((s) => s.rec.kind === 'identity_link' && (s.rec.body as { method?: string }).method === 'x0x-agent').sort((a, b) => b.rec.created.localeCompare(a.rec.created))[0]; return l ? x0xAgentLink(l.rec) : null; })(),
      // A linked GitHub account: the latest claim; every viewer re-checks the gist in their own browser.
      linked_github: (() => { const l = mine.filter((s) => s.rec.kind === 'identity_link' && (s.rec.body as { method?: string }).method === 'github').sort((a, b) => b.rec.created.localeCompare(a.rec.created))[0]; if (!l) return null; const b = l.rec.body as { handle: string; proof: string; unlink?: boolean }; return b.unlink ? null : { handle: b.handle, proof: b.proof }; })(),
      founding: receipts.filter((r) => r.b.type === 'founding').length,
      agents: [...new Set(mine.map((s) => s.rec.agent_id))].map((a) => ({ id: a, human: mine.some((s) => s.rec.agent_id === a && /^human\b/.test(s.rec.context.environment)), records: mine.filter((s) => s.rec.agent_id === a).length })),
    };
  });

  web.route('POST', /^\/api\/records$/, async (_r, _m, _u, body) => {
    const rec = (await body()) as SignedRecord;
    const v = verifyRecord(rec);
    if (!v.ok) return new HttpReply(400, { error: `rejected: ${v.reason}` });
    if (!HUMAN_KINDS.includes(rec.kind)) return new HttpReply(400, { error: `the app cannot submit ${rec.kind} records` });
    const p = scrub({ context: rec.context, body: readableBody(rec) }, hub.node.privacy);
    if (!p.ok) return new HttpReply(400, { error: 'blocked by privacy check', findings: p.findings });
    if (!rec.refs.every((r) => hub.node.store.get(r))) return new HttpReply(400, { error: 'refers to unknown records' });
    const problem = await checkHumanRecord(rec);
    if (problem) return new HttpReply(400, problem);
    await hub.node.relay(rec);
    if (rec.kind === 'message' && rec.refs[0] && hub.problems.get(rec.refs[0])) void spaces.post(rec.refs[0], String((rec.body as { text?: string }).text ?? ''));
    return { accepted: rec.id, credit: 'Your light joined the sky.' };
  });

  /** Kind-specific checks for what people (and browsers lending compute) can submit. Null means fine. */
  async function checkHumanRecord(rec: SignedRecord): Promise<{ error: string; findings?: unknown } | null> {
    const b = rec.body as Record<string, any>;
    const ref = rec.refs[0] ? hub.node.store.get(rec.refs[0]) : undefined;
    switch (rec.kind) {
      case 'proposal': {
        if (!b.title || !b.goal || !b.done || !REALMS.includes(b.realm)) return { error: 'a proposal needs a title, a goal, how success is checked, and a realm' };
        const check = await hub.collective.constitution.checkText(`${b.title}\n${b.goal}\n${b.done}`, b.realm);
        if (!check.ok) return { error: 'the constitution check stopped this proposal', findings: check.findings };
        return null;
      }
      case 'answer': return ref?.rec.kind === 'help_request' ? null : { error: 'people answer calls for help; other answers come from agents' };
      case 'task_result': {
        if (ref?.rec.kind !== 'problem' || b.problem !== ref.rec.id) return { error: 'a result must point at its problem' };
        const st = await hub.problems.state(ref.rec.id);
        const c = st.chunks.find((x) => x.key === b.chunk);
        if (!c) return { error: 'unknown step' };
        if (c.checkpoint) return { error: 'that step is already verified' };
        if (typeof b.output !== 'string' || !b.output.trim()) return { error: 'empty result' };
        if (familyOf(String(b.model)) !== b.family) return { error: 'the model family must match the model' };
        return null;
      }
      case 'challenge': return b.team && Number(b.goal) > 0 && Date.parse(b.ends) > Date.now() ? null : { error: 'a challenge needs a team, a goal and an end date in the future' };
      case 'piece': {
        if (ref?.rec.kind !== 'gallery') return { error: 'a piece belongs to a gallery' };
        const check = await hub.collective.constitution.checkText(`${b.title}\n${b.text}`, 'art_creativity');
        return check.ok ? null : { error: 'the constitution check stopped this piece', findings: check.findings };
      }
      case 'curation': return ref?.rec.kind === 'piece' && /^human\b/.test(rec.context.environment) ? null : { error: 'only people curate, and only pieces' };
      case 'ruling': {
        const c = b.case as string[] | undefined;
        if (!Array.isArray(c) || c.length !== 2 || rec.refs[0] !== c[0] || rec.refs[1] !== c[1]) return { error: 'a ruling names the two records it decides between' };
        if (!['first', 'second', 'both_conditional'].includes(b.decision) || b.judge_family !== 'human') return { error: 'a person rules first, second, or both under different conditions' };
        return null;
      }
      case 'payout_address': return /^0x[0-9a-fA-F]{40}$/.test(String(b.address)) && ['base', 'base-sepolia'].includes(b.chain) ? null : { error: 'a payout address is an Ethereum address on Base' };
      case 'identity_link': {
        if (b.method === 'x0x-agent') return x0xAgentLink(rec) ? null : { error: 'the x0x signature does not verify for this key' };
        if (b.method === 'github') {
          // "I'm @handle on GitHub; the proof is this public gist." Readers verify the gist themselves.
          const handle = String(b.handle ?? '');
          if (!/^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(handle)) return { error: 'that is not a GitHub username' };
          if (b.unlink === true) return null;
          const m = /^https:\/\/gist\.github\.com\/([A-Za-z0-9-]+)\/[0-9a-f]{20,40}$/.exec(String(b.proof ?? ''));
          return m && m[1].toLowerCase() === handle.toLowerCase() ? null : { error: 'the proof must be a public gist from that GitHub account' };
        }
        const v = verifyOperatorClaim(b.claim as OperatorClaim, fromB64(rec.author));
        return v.ok ? null : { error: `identity link does not verify: ${v.reason}` };
      }
      default: return null;
    }
  }

  // Direct messages: private, never records. Over x0x when a daemon is running; a labelled mailbox on the demo network.
  web.route('GET', /^\/api\/dm\/([0-9a-f]{64})$/, (_r, m) => ({ messages: hub.people.conversations(m[1]), via: hub.x0x ? 'x0x' : process.env.CONSTELLATE_DEMO === '1' ? 'demo' : 'none' }));
  web.route('POST', /^\/api\/dm$/, async (_r, _m, _u, body) => {
    const j = await body() as { to?: string; from?: string; text?: string };
    if (!/^[0-9a-f]{64}$/.test(j.to ?? '') || !j.text?.trim()) return new HttpReply(400, { error: 'say who it is for and what to say' });
    const p = scrub({ context: { task: 'dm', domain: [], environment: '' }, body: { text: j.text } }, hub.node.privacy);
    if (!p.ok) return new HttpReply(400, { error: 'blocked by privacy check', findings: p.findings });
    try { return await hub.people.dm(j.to!, j.text, { from: /^[0-9a-f]{64}$/.test(j.from ?? '') ? j.from : undefined }); }
    catch (e) { return new HttpReply(503, { error: (e as Error).message }); }
  });

  // Calls for help on a problem: steps still waiting, and questions agents posted mid-task.
  web.route('GET', /^\/api\/problems\/([0-9a-f]{64})\/help$/, (_r, m) => hub.node.store.referencing(m[1], 'help_request').map((h) => {
    const b = h.rec.body as { question: string; needs?: string; verifier?: string };
    const answers = hub.node.store.referencing(h.rec.id, 'answer');
    return { id: h.rec.id, question: b.question, needs: b.needs ?? 'any', at: h.rec.created, who: h.rec.agent_id, answers: answers.length, answered_by_people: answers.filter(isHuman).length };
  }));

  // Ideas from people: not yet a problem (that needs checkable steps), but voted on and visible.
  web.route('GET', /^\/api\/ideas$/, () => hub.node.store.ofKind('proposal').filter((s) => { const b = s.rec.body as { title?: string; done?: string }; return !!(b.title && b.done); }).map((s) => {
    const b = s.rec.body as { title: string; goal: string; done: string; check: string; realm: string };
    const voters = new Set(hub.node.store.referencing(s.rec.id, 'vote').map((v) => v.operatorId));
    return { id: s.rec.id, ...b, at: s.rec.created, by: s.rec.agent_id, human: isHuman(s), voters: voters.size };
  }).sort((a, b) => b.voters - a.voters || b.at.localeCompare(a.at)));

  // Art: appreciated, not scored. Galleries of pieces by people and agents; people curate.
  const galleryView = (id: string) => {
    const g = hub.node.store.get(id);
    if (!g || g.rec.kind !== 'gallery') throw Object.assign(new Error('not found'), { status: 404 });
    const pieces = hub.node.store.referencing(id, 'piece').map((p) => {
      const b = p.rec.body as { title: string; text: string; family?: string };
      const curators = new Set(hub.node.store.referencing(p.rec.id, 'curation').filter(isHuman).map((c) => c.operatorId));
      return { id: p.rec.id, title: b.title, text: b.text, by: isHuman(p) ? 'human' : 'agent', family: b.family ?? null, who: p.rec.agent_id, at: p.rec.created, curators: curators.size };
    });
    return { id, ...(g.rec.body as object), pieces: pieces.sort((a, b) => b.curators - a.curators || a.at.localeCompare(b.at)), curated: pieces.filter((p) => p.curators >= 2).map((p) => p.id) };
  };
  web.route('GET', /^\/api\/galleries$/, () => hub.node.store.ofKind('gallery').map((g) => { const v = galleryView(g.rec.id); return { id: v.id, ...(g.rec.body as object), pieces: v.pieces.length, curated: v.curated.length }; }));
  web.route('GET', /^\/api\/galleries\/([0-9a-f]{64})$/, (_r, m) => galleryView(m[1]));

  // Lend this browser: the next open step a small model can try. The result is checked by a different family before it counts.
  web.route('GET', /^\/api\/work\/next$/, async (_r, _m, url) => {
    const family = String(url.searchParams.get('family') ?? '');
    for (const p of hub.problems.list()) {
      const body = p.rec.body as unknown as ProblemBody;
      if (hub.collective.constitution.status(p.rec.id).state !== 'cleared') continue;
      const st = await hub.problems.state(p.rec.id);
      for (const c of st.chunks) {
        if (c.checkpoint) continue;
        const spec = body.chunks.find((x) => x.key === c.key)!;
        if (spec.needs.size === 'large') continue;
        if (c.pending.some((r) => (r.rec.body as { family?: string }).family === family)) continue;
        return { problem: p.rec.id, title: body.title, realm: body.realm, chunk: c.key, step: spec.title, prompt: spec.prompt, verifier: body.definition_of_done.verifier };
      }
    }
    return { problem: null };
  });
  web.route('GET', /^\/api\/challenges$/, () => challenges());

  // The disagreement court, for people: what the independent judge decided and why, and the cases it couldn't settle.
  web.route('GET', /^\/api\/court$/, () => {
    const side = (id: string) => { const s = hub.node.store.get(id); if (!s) return null; const b = s.rec.body as Record<string, any>; return { id, kind: s.rec.kind, text: String(b.reason ?? b.answer ?? b.error_summary ?? b.approach ?? b.statement ?? b.text ?? s.rec.context.task).slice(0, 400), environment: s.rec.context.environment, by: isHuman(s) ? 'human' : 'agent' }; };
    const rulings = hub.node.store.ofKind('ruling');
    return rulings.filter((r) => !isHuman(r)).map((r) => {
      const b = r.rec.body as { case: [string, string]; decision: string; reasoning: string; confidence: number; needs_human: boolean; judge_family: string };
      const people = rulings.filter((h) => isHuman(h) && (h.rec.body as { case: string[] }).case.join() === b.case.join());
      const tally = { first: 0, second: 0, both_conditional: 0 } as Record<string, number>;
      for (const op of new Map(people.map((h) => [h.operatorId, (h.rec.body as { decision: string }).decision])).values()) tally[op]++;
      return { id: r.rec.id, at: r.rec.created, first: side(b.case[0]), second: side(b.case[1]), decision: b.decision, reasoning: b.reasoning, confidence: b.confidence, needs_human: b.needs_human, judge_family: b.judge_family, people: tally };
    }).filter((x) => x.first && x.second).sort((a, b) => Number(b.needs_human) - Number(a.needs_human) || b.at.localeCompare(a.at));
  });

  // The utility hook: paste an error or a question, get what failed, what fixed it, and a plain answer.
  web.route('GET', /^\/api\/search$/, async (_r, _m, url) => {
    const q = String(url.searchParams.get('q') ?? '').slice(0, 500).trim();
    if (!q) return { q, failures: [], answers: [], learned: [], skills: [], guide: null };
    const failures = hub.ledger.searchFailures(q, { limit: 6 }).map((f) => ({ ...f, fixes: f.fixed_by.map((id) => { const a = hub.node.store.get(id); const b = a?.rec.body as { answer: string; headline?: string; proof?: { type: string; detail: string } } | undefined;
      return a && b ? { id, answer: b.answer, headline: b.headline, proof: b.proof, confirmations: hub.trust.explain(a).confirmations, domain: a.rec.context.domain } : null; }).filter(Boolean) }));
    const answers = hub.ledger.lookupAnswers(q, { limit: 3 });
    const asksAboutWork = /happening|progress|status|how('s| is)|going|what about/i.test(q);
    const guide = asksAboutWork || !(failures.length || answers.length) ? await guide_.ask(q).catch(() => null) : null;
    const learned = hub.ledger.learned(q, { limit: 2 });
    const skills = hub.skills.find(q, 2).map((k) => ({ id: k.id, name: k.name, description: k.description, source: hub.node.store.get(k.id)?.rec.evidence[0] ?? null }));
    return { q, failures, answers, learned, skills, guide };
  });

  web.route('POST', /^\/api\/ask$/, async (_r, _m, _u, body) => guide.ask(String((await body()).question ?? '').slice(0, 500)));
  web.route('GET', /^\/api\/digest$/, (_r, _m, url) => guide.digest((url.searchParams.get('follow') ?? '').split(',').filter(Boolean), 7, { people: (url.searchParams.get('people') ?? '').split(',').filter(Boolean), realms: (url.searchParams.get('realms') ?? '').split(',').filter(Boolean) }));

  web.route('GET', /^\/api\/card\/([0-9a-f]{64})\.svg$/, async (_r, m) => {
    const s = hub.node.store.get(m[1]);
    if (!s) throw Object.assign(new Error('not found'), { status: 404 });
    let problem = s;
    while (problem && problem.rec.kind !== 'problem' && problem.rec.refs[0]) problem = hub.node.store.get(problem.rec.refs[0])!;
    const title = (problem.rec.body as { title?: string }).title ?? 'Constellate';
    const prog = problem.rec.kind === 'problem' ? (await hub.problems.summary(problem.rec.id)).progress : null;
    const line = s.rec.kind === 'checkpoint' ? 'A new step was verified' : 'A contribution landed';
    return new RawReply(Buffer.from(card(title, line, prog)), 'image/svg+xml');
  });

  web.route('GET', /^\/api\/events$/, (req) => new StreamReply((res) => {
    const off = hub.node.store.onAdd((s) => {
      if (s.visibility !== 'public') return;
      let root: StoredRecord | undefined = s;
      for (let i = 0; i < 6 && root && !['problem', 'proposal'].includes(root.rec.kind); i++) root = root.rec.refs[0] ? hub.node.store.get(root.rec.refs[0]) : undefined;
      const newOperator = root ? hub.node.store.referencing(root.rec.id).filter((r) => r.operatorId === s.operatorId).length <= 1 : false;
      res.write(`data: ${JSON.stringify({ id: s.rec.id, kind: s.rec.kind, by: isHuman(s) ? 'human' : 'agent', operator: s.operatorId, root: root?.rec.id ?? null, newOperator, at: s.rec.created })}\n\n`);
    });
    const offB = hub.graph.onBridge((b) => res.write(`data: ${JSON.stringify({ kind: 'bridge', ...b })}\n\n`));
    req.on('close', () => { off(); offB(); });
  }));
}

function describe(r: StoredRecord): string {
  const b = r.rec.body as Record<string, unknown>;
  switch (r.rec.kind) {
    case 'checkpoint': return `verified step ${b.chunk} (checked by a ${b.verifier_family} model)`;
    case 'task_result': return `proposed an answer for step ${b.chunk} using a ${b.family} model`;
    case 'verification': return `rejected an answer for step ${b.chunk}: ${String(b.reason).slice(0, 80)}`;
    case 'vote': return 'voted for this problem';
    case 'constitution_check': return b.ok ? 'constitution check passed' : `constitution check flagged: ${(b.findings as { rule: string }[]).map((f) => f.rule).join(', ')}`;
    case 'receipt': return `payment: ${b.type}`;
    case 'message': return `said: “${String(b.text).slice(0, 140)}”`;
    case 'use': return 'found this useful';
    case 'confirmation': return 'confirmed a result independently';
    case 'contradiction': return `disagreed: ${String(b.reason).slice(0, 100)}`;
    case 'rating': return `rated an argument ${b.score}/5`;
    case 'link': return `linked it to related work (${b.type})`;
    case 'handoff': return `handed off: ${String(b.next).slice(0, 100)}`;
    default: return r.rec.kind;
  }
}

function card(title: string, line: string, prog: { done: number; total: number } | null) {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
  const w = prog ? Math.round((prog.done / prog.total) * 520) : 0;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="315" viewBox="0 0 600 315"><rect width="600" height="315" fill="#0b0d14"/><circle cx="480" cy="90" r="70" fill="#7aa2ff" opacity="0.18"/><circle cx="480" cy="90" r="6" fill="#ffc46b"/><text x="40" y="70" fill="#9aa0ae" font-family="system-ui,sans-serif" font-size="18">${esc(line)}</text><text x="40" y="120" fill="#e8e6e3" font-family="Georgia,serif" font-size="30">${esc(title.slice(0, 34))}</text>${prog ? `<rect x="40" y="220" width="520" height="8" rx="4" fill="#22263a"/><rect x="40" y="220" width="${w}" height="8" rx="4" fill="#7aa2ff"/><text x="40" y="255" fill="#9aa0ae" font-family="system-ui,sans-serif" font-size="16">${prog.done} of ${prog.total} steps verified</text>` : ''}<text x="40" y="290" fill="#9aa0ae" font-family="system-ui,sans-serif" font-size="14">constellate · open results, signed by everyone who helped</text></svg>`;
}

/**
 * An x0x agent vouching for a person's key: the agent signed the person's Constellate id under the
 * context constellate.identity-link.v1 with the x0x external-sign framing. Returns the agent id when
 * the signature, the key and the id all check out, else null.
 */
export function x0xAgentLink(rec: SignedRecord): string | null {
  const b = rec.body as { x0x_agent_id?: string; x0x_public_key?: string; signature?: string };
  try {
    const pk = fromB64(String(b.x0x_public_key));
    if (peerIdFromPublicKey(pk) !== b.x0x_agent_id) return null;
    return verifyExternal(pk, 'constellate.identity-link.v1', utf8(rec.agent_id), fromB64(String(b.signature))) ? b.x0x_agent_id! : null;
  } catch { return null; }
}

/**
 * The starter library's signing identities (the desktop app imports a signed snapshot of public history
 * once; see CONSTELLATE_STARTER). Read from the snapshot named in the import marker, so the People page
 * can say "Starter library" instead of showing an anonymous agent with a thousand contributions.
 */
let starterOps: Set<string> | null = null;
function starterOperators(): Set<string> {
  if (starterOps) return starterOps;
  starterOps = new Set();
  try {
    const home = process.env.CONSTELLATE_HOME ?? join(homedir(), '.constellate');
    const marker = JSON.parse(readFileSync(join(home, 'starter-imported'), 'utf8')) as { file?: string };
    if (marker.file && existsSync(marker.file)) {
      const snap = decodeCanonical<{ records: SignedRecord[] }>(new Uint8Array(readFileSync(marker.file)));
      for (const r of snap.records.slice(0, 2000)) { const v = verifyRecord(r); if (v.ok) starterOps.add(v.operatorId); }
    }
  } catch { /* no starter library on this install */ }
  return starterOps;
}
