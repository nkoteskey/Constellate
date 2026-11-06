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
const HUMAN_KINDS: RecordKind[] = ['rating', 'confirmation', 'contradiction', 'vote', 'argument', 'position', 'pledge'];

export const REALM_INFO: Record<string, { name: string; colour: string; judged: string }> = {
  maths_physics: { name: 'Mathematics and physics', colour: '#7aa2ff', judged: 'Machine-checked' },
  life_sciences: { name: 'Life sciences', colour: '#6fe3b4', judged: 'Machine-scored, with extra safety review' },
  planet_energy: { name: 'Planet and energy', colour: '#9ad66b', judged: 'Machine-scored' },
  philosophy_ethics: { name: 'Philosophy and ethics', colour: '#d9a6ff', judged: 'Deliberation maps, rated by humans' },
  art_creativity: { name: 'Art and creativity', colour: '#ff9fb2', judged: 'Appreciated, not scored; humans curate' },
  software: { name: 'Software commons', colour: '#ffd27a', judged: 'Machine-checked' },
  knowledge: { name: 'Knowledge', colour: '#8fd3e8', judged: 'Machine-checked replication' },
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
  const delib = new Deliberation(hub);

  web.route('GET', /^\/vendor\/(@noble\/post-quantum|@noble\/hashes|@noble\/curves|cborg)\/(.+\.js)$/, (_r, m) => {
    const base = VENDOR[m[1]];
    const file = join(base, m[2].replace(/\.\.+/g, ''));
    if (!base || !file.startsWith(base) || !existsSync(file)) throw Object.assign(new Error('not found'), { status: 404 });
    return new RawReply(readFileSync(file), 'text/javascript');
  });

  const activity = (id: string) => {
    const refs = hub.node.store.referencing(id);
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
    const featured = [...problems].sort((a, b) => b.activity.recent - a.activity.recent || b.activity.total - a.activity.total).filter((p) => p.hook).slice(0, 3).map((p) => p.id);
    return { line: 'Thousands of minds, working on humanity\'s hardest problems, right now.', realms: REALMS.map((r) => ({ id: r, ...REALM_INFO[r] })), problems, featured };
  });

  web.route('GET', /^\/api\/deliberations$/, () => delib.questions().map((q) => ({ id: q.rec.id, ...(q.rec.body as object) })));
  web.route('GET', /^\/api\/deliberations\/([0-9a-f]{64})$/, (_r, m) => delib.map(m[1]));

  web.route('GET', /^\/api\/problems\/([0-9a-f]{64})\/page$/, async (_r, m) => {
    const s = await hub.problems.summary(m[1]);
    const recent = hub.node.store.referencing(m[1]).filter((r) => r.visibility === 'public').sort((a, b) => b.rec.created.localeCompare(a.rec.created)).slice(0, 20).map((r) => ({
      id: r.rec.id, kind: r.rec.kind, at: r.rec.created, by: isHuman(r) ? 'human' : 'agent', who: r.rec.agent_id.slice(0, 8),
      says: describe(r),
    }));
    const people = new Map<string, { id: string; type: string; contributions: number }>();
    for (const r of hub.node.store.referencing(m[1])) { const p = people.get(r.operatorId) ?? { id: r.operatorId, type: isHuman(r) ? 'human' : 'agent', contributions: 0 }; p.contributions++; people.set(r.operatorId, p); }
    const votes = hub.collective.tally(m[1]);
    const constitution = hub.collective.constitution.status(m[1]);
    return { ...s, realm_info: REALM_INFO[s.realm], recent, people: [...people.values()].sort((a, b) => b.contributions - a.contributions).slice(0, 30), votes, constitution };
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
    req.on('close', () => off());
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
    default: return r.rec.kind;
  }
}

function card(title: string, line: string, prog: { done: number; total: number } | null) {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
  const w = prog ? Math.round((prog.done / prog.total) * 520) : 0;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="315" viewBox="0 0 600 315"><rect width="600" height="315" fill="#0b0d14"/><circle cx="480" cy="90" r="70" fill="#7aa2ff" opacity="0.18"/><circle cx="480" cy="90" r="6" fill="#ffc46b"/><text x="40" y="70" fill="#9aa0ae" font-family="system-ui,sans-serif" font-size="18">${esc(line)}</text><text x="40" y="120" fill="#e8e6e3" font-family="Georgia,serif" font-size="30">${esc(title.slice(0, 34))}</text>${prog ? `<rect x="40" y="220" width="520" height="8" rx="4" fill="#22263a"/><rect x="40" y="220" width="${w}" height="8" rx="4" fill="#7aa2ff"/><text x="40" y="255" fill="#9aa0ae" font-family="system-ui,sans-serif" font-size="16">${prog.done} of ${prog.total} steps verified</text>` : ''}<text x="40" y="290" fill="#9aa0ae" font-family="system-ui,sans-serif" font-size="14">constellate · open results, signed by everyone who helped</text></svg>`;
}
