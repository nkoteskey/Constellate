import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpReply, RawReply, StreamReply, WebServer } from './server.js';
import { Guide } from './guide.js';
import { Deliberation } from '../collective/deliberation.js';
import { verifyRecord, SignedRecord, RecordKind } from '../core/record.js';
import { scrub } from '../privacy/scrub.js';
import { StoredRecord } from '../store/records.js';
import { REALMS } from '../work/problems.js';
import { ModelRunner } from '../contributor/models.js';

/** Kinds a person can sign in the browser. */
const HUMAN_KINDS: RecordKind[] = ['rating', 'confirmation', 'contradiction', 'vote', 'argument', 'position', 'pledge', 'message', 'use'];

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
  web.route('GET', /^\/api\/people$/, (_r, _m, url) => hub.people.discover({ realm: url.searchParams.get('realm') ?? undefined, problem: url.searchParams.get('problem') ?? undefined }));
  web.route('GET', /^\/api\/chat\/([0-9a-f]{64})$/, (_r, m) => hub.people.chat(m[1]));
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
    const recent = hub.node.store.referencing(m[1]).filter((r) => r.visibility === 'public').sort((a, b) => b.rec.created.localeCompare(a.rec.created)).slice(0, 20).map((r) => ({
      id: r.rec.id, kind: r.rec.kind, at: r.rec.created, by: isHuman(r) ? 'human' : 'agent', who: r.rec.agent_id,
      says: describe(r),
    }));
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
      id: m[1], contributions: mine.length, by_kind: mine.reduce<Record<string, number>>((a, s) => ((a[s.rec.kind] = (a[s.rec.kind] ?? 0) + 1), a), {}),
      helped: [...helped].map((id) => { const b = hub.node.store.get(id)!.rec.body as { title?: string; question?: string }; return { id, title: b.title ?? b.question }; }),
      reputation: hub.reputation.profile(m[1]), credit: receipts.reduce((n, r) => n + r.b.amount, 0),
      pledged_hours: hub.collective.pledged(m[1]),
      agents: [...new Set(mine.map((s) => s.rec.agent_id))].map((a) => ({ id: a, human: mine.some((s) => s.rec.agent_id === a && /^human\b/.test(s.rec.context.environment)), records: mine.filter((s) => s.rec.agent_id === a).length })),
    };
  });

  web.route('POST', /^\/api\/records$/, async (_r, _m, _u, body) => {
    const rec = (await body()) as SignedRecord;
    const v = verifyRecord(rec);
    if (!v.ok) return new HttpReply(400, { error: `rejected: ${v.reason}` });
    if (!HUMAN_KINDS.includes(rec.kind)) return new HttpReply(400, { error: `the app cannot submit ${rec.kind} records` });
    const p = scrub({ context: rec.context, body: rec.body }, hub.node.privacy);
    if (!p.ok) return new HttpReply(400, { error: 'blocked by privacy check', findings: p.findings });
    if (!rec.refs.every((r) => hub.node.store.get(r))) return new HttpReply(400, { error: 'refers to unknown records' });
    await hub.node.relay(rec);
    return { accepted: rec.id, credit: 'Your light joined the sky.' };
  });

  // The utility hook: paste an error or a question, get what failed, what fixed it, and a plain answer.
  web.route('GET', /^\/api\/search$/, async (_r, _m, url) => {
    const q = String(url.searchParams.get('q') ?? '').slice(0, 500).trim();
    if (!q) return { q, failures: [], answers: [], learned: [], guide: null };
    const failures = hub.ledger.searchFailures(q, { limit: 6 }).map((f) => ({ ...f, fixes: f.fixed_by.map((id) => { const a = hub.node.store.get(id); const b = a?.rec.body as { answer: string; headline?: string; proof?: { type: string; detail: string } } | undefined;
      return a && b ? { id, answer: b.answer, headline: b.headline, proof: b.proof, confirmations: hub.trust.explain(a).confirmations, domain: a.rec.context.domain } : null; }).filter(Boolean) }));
    const answers = hub.ledger.lookupAnswers(q, { limit: 3 });
    const asksAboutWork = /happening|progress|status|how('s| is)|going|what about/i.test(q);
    const guide = asksAboutWork || !(failures.length || answers.length) ? await guide_.ask(q).catch(() => null) : null;
    const learned = hub.ledger.learned(q, { limit: 2 });
    return { q, failures, answers, learned, guide };
  });

  web.route('POST', /^\/api\/ask$/, async (_r, _m, _u, body) => guide.ask(String((await body()).question ?? '').slice(0, 500)));
  web.route('GET', /^\/api\/digest$/, (_r, _m, url) => guide.digest((url.searchParams.get('follow') ?? '').split(',').filter(Boolean)));

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
      res.write(`data: ${JSON.stringify({ id: s.rec.id, kind: s.rec.kind, by: isHuman(s) ? 'human' : 'agent', root: root?.rec.id ?? null, newOperator, at: s.rec.created })}\n\n`);
    });
    const offB = hub.graph.onBridge((b) => res.write(`data: ${JSON.stringify({ kind: 'bridge', ...b })}\n\n`));
    req.on('close', () => { off(); offB(); });
  }));
}

function describe(r: StoredRecord): string {
  const b = r.rec.body as Record<string, unknown>;
  switch (r.rec.kind) {
    case 'checkpoint': return `verified step ${b.chunk} (checked by a ${b.verifier_family} model)`;
    case 'task_result': return `proposed an answer for step ${b.chunk} using ${b.model}`;
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
