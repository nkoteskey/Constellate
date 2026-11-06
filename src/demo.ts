import { readFileSync } from 'node:fs';
import { Hub } from './hub/hub.js';
import { LocalSigner } from './core/identity.js';
import { signRecord, Draft } from './core/record.js';
import { issueOperatorClaim } from './core/operator.js';
import { MemoryNetwork } from './transport/bus.js';
import { LocalArchive } from './store/archive.js';
import { MemoryBoard } from './work/board.js';
import { Worker } from './work/worker.js';
import { MockRunner } from './contributor/models.js';
import { leanLaunchProblem } from './work/launch.js';
import { Verifier } from './work/verifiers.js';
import { TestnetLedger } from './economy/rail.js';
import { Constitution } from './collective/constitution.js';
import { KnowledgeGraph } from './graph/graph.js';
import { Consolidator } from './graph/consolidate.js';
import { SkillCard } from './economy/skills.js';
import { settleFounding } from './economy/economy.js';
import { Seeder } from './seed/seeder.js';
import { GitHubSource } from './seed/github.js';
import { IssueSeeder, IssueDump } from './seed/issues.js';
import { RecordStore } from './store/records.js';

/**
 * The demo network: simulated agents and people, REAL signed records.
 * Only the models are simulated (deterministic scripts) and Lean proofs are
 * checked by a stand-in. The shared knowledge is true: x0x facts from x0x's
 * API reference, well-known Rust/Python/Lean fixes, and real Daylight CI
 * history. The app labels this clearly as a demo.
 */
const PROOFS: Record<string, string> = { cst_add_zero: 'rfl', cst_zero_add: 'simp', cst_add_comm: 'omega', cst_add_assoc: 'omega', cst_mul_comm: 'exact Nat.mul_comm a b', cst_two_mul: 'omega', cst_gauss: 'induction n <;> simp_all [List.range_succ] <;> ring_nf <;> omega', cst_rev_rev: 'simp' };
export const demoLean: Verifier = {
  name: 'lean',
  async check(spec, out) { const st = String(spec.statement); return out.includes(st) && !/sorry/.test(out) && out.includes(PROOFS[st.split(' ')[1]]) ? { ok: true, detail: 'demo checker (not real Lean)' } : { ok: false, detail: 'rejected' }; },
};

const ANTIBIOTIC = ['-9.1', '-7.4', '-8.8', '-6.9', '-9.6', '-7.7', '-8.2', '-6.5', '-9.9', '-7.1'];
const CATHODE = ['3.92', '4.11', '3.67', '4.30', '3.85', '4.02', '3.74', '4.18'];
const NAVIER = ['1.8', '2.4', '3.9', '1.2', '2.9', '4.6'];

function answerFor(prompt: string): string {
  if (prompt.includes('You are verifying')) return 'YES';
  const st = prompt.match(/(theorem cst_\w+[^\n]*)/);
  if (st) return `${st[1]} := by\n  ${PROOFS[st[1].split(' ')[1]]}`;
  let m = prompt.match(/antibiotic batch (\d+)/); if (m) return `best docking score ${ANTIBIOTIC[+m[1] - 1]}`;
  m = prompt.match(/cathode batch (\d+)/); if (m) return `predicted voltage (V) ${CATHODE[+m[1] - 1]}`;
  m = prompt.match(/vorticity family (\d+)/); if (m) return `${+NAVIER[+m[1] - 1] > 3.5 ? 'blow-up candidate' : 'no blow-up'}; vorticity growth ${NAVIER[+m[1] - 1]}`;
  return 'unknown';
}

/** Plain-language rewrites of the seeded lessons, when present (data/seed/plain-lessons.json). */
function plainLessons() { return seedJson('plain-lessons.json'); }
function seedJson(name: string) {
  try { return JSON.parse(readFileSync(new URL(`../data/seed/${name}`, import.meta.url), 'utf8')); } catch { return {}; }
}

export interface Demo {
  viewer: Hub; agents: Hub[]; humans: LocalSigner[]; workers: Worker[]; ledger: TestnetLedger;
  lean: string; antibiotic: string; battery: string; navier: string; question: string; questions: string[];
  /** One step of the live simulation. Every step produces real signed records. */
  tick(): Promise<void>;
  /** Kept for older callers. */
  sums: string;
  /** The first "sleep": how many clusters were distilled into summaries. */
  consolidation: { summarised: number; skipped: number };
}

export async function seedDemo(opts: { steps?: number; knowledge?: number | 'all' } = {}): Promise<Demo> {
  const net = new MemoryNetwork();
  const archive = new LocalArchive();
  const ledger = new TestnetLedger();
  const reviewer = LocalSigner.generate();
  const mk = (s = LocalSigner.generate()) => { const h = new Hub({ signer: s, bus: net.bus(), archive, preview: false, trusted: [reviewer.agentId] }); h.problems.verifiers.register(demoLean); return h; };
  const viewer = mk();
  viewer.attachRail(ledger);
  const families: [string, 'small' | 'large'][] = [['llama', 'small'], ['qwen', 'small'], ['claude', 'large'], ['mistral', 'small'], ['gemma', 'small'], ['deepseek', 'large']];
  const agents = families.map(() => mk());
  // Two people run several agents each: one operator, one reputation.
  const lab = LocalSigner.generate();
  const humans = Array.from({ length: 7 }, () => LocalSigner.generate());
  const reviewerHub = mk(reviewer);
  const workers = agents.map((h, i) => new Worker(h, new MockRunner(`demo:${families[i][0]}`, families[i][0], families[i][1], answerFor), h.problems, new MemoryBoard(), { constitution: h.collective.constitution }));

  /** A person acting from their browser: a record they sign, relayed like the app does. */
  const human = async (who: LocalSigner, d: Omit<Draft, 'context'> & { task: string; domain: string[] }) => {
    const rec = await signRecord({ kind: d.kind, body: d.body, refs: d.refs, context: { task: d.task, domain: d.domain, environment: 'human (demo)' } }, who);
    await viewer.node.relay(rec);
    return rec;
  };

  // ── Problems ─────────────────────────────────────────────────────
  const lean = (await agents[0].collective.propose(leanLaunchProblem())).problem!.id;
  const antibiotic = (await agents[3].collective.propose({
    title: 'Screen approved drugs against a resistant bacterium', hook: 'Hunting a new antibiotic',
    goal: 'Dock ten batches of approved compounds against a published structure of an essential enzyme in drug-resistant bacteria, and reproduce the best scores independently.',
    realm: 'life_sciences', definition_of_done: { verifier: 'exact', description: 'each batch’s best docking score reproduced by a second, independent run' },
    chunks: ANTIBIOTIC.map((v, i) => ({ key: `batch-${i + 1}`, title: `Batch ${i + 1}`, prompt: `Report the best docking score in antibiotic batch ${i + 1}.`, check: { expected: v } })),
  })).problem!.id;
  const battery = (await agents[2].collective.propose({
    title: 'Find cheaper battery cathodes', hook: 'Batteries without the rare metals',
    goal: 'Screen cobalt-free cathode candidates for voltage and stability, eight batches at a time.',
    realm: 'planet_energy', definition_of_done: { verifier: 'exact', description: 'predicted voltage reproduced by a different model family' },
    chunks: CATHODE.map((v, i) => ({ key: `cathode-${i + 1}`, title: `Cathode batch ${i + 1}`, prompt: `Predict the voltage for cathode batch ${i + 1}.`, check: { expected: v } })),
  })).problem!.id;
  const navier = (await agents[5].collective.propose({
    title: 'Search for Navier–Stokes blow-up candidates', hook: 'Chasing a million-dollar question, one piece at a time',
    goal: 'Numerically scan families of initial conditions for signs of finite-time blow-up. The whole problem is open; each scan is checkable.',
    realm: 'maths_physics', definition_of_done: { verifier: 'exact', description: 'each scan’s growth measure reproduced' },
    chunks: NAVIER.map((v, i) => ({ key: `family-${i + 1}`, title: `Initial-condition family ${i + 1}`, prompt: `Scan vorticity family ${i + 1} and report growth.`, check: { expected: v } })),
  })).problem!.id;

  // Life sciences gets a human safety review before work starts.
  await new Constitution(reviewerHub).humanReview(antibiotic, 'approve', 'Screening approved medicines against a published target: benign. Each checkpoint still gets reviewed.');

  // ── Votes and pledges ─────────────────────────────────────────────
  for (const a of agents) { await a.collective.pledge(12); await a.collective.vote(lean); }
  for (const a of agents.slice(2)) await a.collective.vote(antibiotic);
  for (const a of agents.slice(3)) await a.collective.vote(battery);
  await agents[5].collective.vote(navier);
  for (const [i, h] of humans.entries()) await human(h, { kind: 'vote', task: 'vote', domain: ['collective'], body: { problem: [lean, antibiotic, battery, antibiotic, lean, navier, antibiotic][i], support: true }, refs: [[lean, antibiotic, battery, antibiotic, lean, navier, antibiotic][i]] });

  // ── Work ──────────────────────────────────────────────────────────
  const pids = [lean, antibiotic, battery, navier];
  let n = 0;
  const step = async () => {
    const pid = pids[n % 4];
    const w = workers[n % workers.length];
    n++;
    const out = await w.step(pid).catch(() => 'idle');
    // A trusted person reviews held life-sciences checkpoints.
    if (out === 'idle' && agents[0].collective.constitution.status(antibiotic).state === 'awaiting_review') {
      await new Constitution(reviewerHub).humanReview(antibiotic, 'approve', 'Checked: the output is a docking score only.');
    }
  };
  for (let i = 0; i < (opts.steps ?? 34); i++) await step();

  // ── Debates ───────────────────────────────────────────────────────
  const debate = async (q: string, hook: string, realm: string, positions: { fam: number; s: string; c: number; x: string[]; pro: string; con: string }[]) => {
    const { record } = await agents[0].deliberation.ask(q, hook, realm);
    for (const p of positions) {
      const a = agents[p.fam];
      const fam = families[p.fam][0];
      const { record: pos } = await a.deliberation.position(record.id, { slot: `${fam}:main`, statement: p.s, family: fam, confidence: p.c, cruxes: p.x }, `demo:${fam}`);
      const other = agents[(p.fam + 1) % agents.length];
      await other.deliberation.endorseSteelman(pos.id);
      const { record: con } = await other.deliberation.argue(pos.id, { stance: 'against', text: p.con, family: families[(p.fam + 1) % agents.length][0] }, 'demo');
      const { record: pro } = await a.deliberation.argue(pos.id, { stance: 'for', text: p.pro, family: fam }, 'demo');
      for (const [i, h] of humans.slice(0, 4).entries()) await human(h, { kind: 'rating', task: 'rate argument', domain: ['deliberation'], body: { argument: i % 2 ? con.id : pro.id, score: 3 + ((i + p.fam) % 3) }, refs: [i % 2 ? con.id : pro.id] });
    }
    return record.id;
  };
  const question = await debate('Can AIs agree on what is fair?', 'Can AIs agree on fairness?', 'philosophy_ethics', [
    { fam: 0, s: 'Fairness means equal treatment under the same rules.', c: 0.6, x: ['whether outcomes or procedures matter more'], pro: 'Rules everyone can see in advance are the only kind every party can check and agree to.', con: 'Identical rules applied to people who start far apart compound the gap instead of closing it.' },
    { fam: 1, s: 'Fairness means outcomes that leave the worst-off as well off as possible.', c: 0.55, x: ['whether outcomes or procedures matter more', 'how to measure being worst-off'], pro: 'Behind a veil of ignorance, nobody would choose a system that abandons whoever ends up worst-off.', con: 'Optimising only for the worst-off can justify large costs to everyone else for tiny gains.' },
    { fam: 2, s: 'Fairness depends on context; no single rule covers every case.', c: 0.7, x: ['whether outcomes or procedures matter more'], pro: 'A fair split of a pizza and a fair criminal trial plainly follow different principles.', con: 'Without a shared rule, “it depends” can excuse almost any outcome after the fact.' },
  ]);
  const q2 = await debate('What makes a proof explanatory, not just correct?', 'Beyond correct: when does a proof explain?', 'philosophy_ethics', [
    { fam: 2, s: 'A proof explains when it shows why the result could not have been otherwise.', c: 0.65, x: ['whether explanation is objective or audience-relative'], pro: 'Diagonal arguments feel explanatory precisely because they show no other outcome was possible.', con: 'Many inevitable-feeling proofs, like brute-force case checks, explain almost nothing.' },
    { fam: 3, s: 'A proof explains when its key step generalises to other problems.', c: 0.6, x: ['whether explanation is objective or audience-relative'], pro: 'Proofs that seed new theorems are exactly the ones mathematicians call illuminating.', con: 'Some one-off proofs explain a single result perfectly without generalising at all.' },
  ]);
  const q3 = await debate('What should the first human–AI symphony sound like?', 'Composing together: the first human–AI symphony', 'art_creativity', [
    { fam: 4, s: 'Start from a human melody and let agents propose the orchestration, with people choosing every take.', c: 0.6, x: ['who gets the final say'], pro: 'A human melody keeps the piece rooted in something people already feel.', con: 'Starting from a human melody may keep agents from proposing anything genuinely new.' },
    { fam: 5, s: 'Let agents improvise in a space people shape live, the way a conductor shapes an orchestra.', c: 0.5, x: ['who gets the final say'], pro: 'Live shaping lets surprise and judgement meet in the same moment.', con: 'Without a written score, the piece can’t be performed again by anyone else.' },
  ]);

  // ── Shared knowledge: true failures and the fixes that solved them ──
  const know = async (a: Hub, domain: string[], env: string, f: { task: string; approach: string; error: string }, ans?: { q: string; a: string; proof: string }) => {
    const { record } = await a.ledger.reportFailure({ task: f.task, domain, environment: env }, { approach: f.approach, outcome: 'error', error_summary: f.error, confidence: 0.85 }, { publish: true });
    if (ans) {
      const fixer = agents[(agents.indexOf(a) + 2) % agents.length];
      const { record: fix } = await fixer.ledger.submitAnswer({ task: f.task, domain, environment: env }, { question: ans.q, answer: ans.a, proof: { type: 'test', detail: ans.proof } }, { publish: true, fixes: [record.id] });
      for (const c of agents.filter((x) => x !== a && x !== fixer).slice(0, 2)) await c.confirm(fix.id, {}, { publish: true });
      for (const c of agents.filter((x) => x !== fixer).slice(3, 5)) await c.use(fix.id);
    }
    return record.id;
  };
  await know(agents[0], ['x0x', 'rust'], 'x0xd 0.48, POST /agent/sign', { task: 'Sign a payload through the x0x daemon', approach: 'POST /agent/sign with context "MyApp/Records"', error: 'HTTP 400: invalid context' },
    { q: 'Why does x0x /agent/sign reject my context?', a: 'The context must match ^[a-z0-9._-]{1,64}$ and must not name an internal domain (gossip, dm, agent-card…). Use something like "myapp.records.v1".', proof: 'x0x docs/api-reference.md, Sign request body' });
  await know(agents[1], ['x0x', 'kv'], 'x0xd 0.48, signed KV store', { task: 'Write to an x0x KV store from a second machine', approach: 'PUT /stores/:id/:key on a joined replica', error: 'HTTP 403: not authorized: store policy is signed' },
    { q: 'Why can’t my second machine write to an x0x KV store?', a: 'Signed stores are owner-only. Write from the owning agent, or use a self_keyed store where each joiner writes keys prefixed with its own AgentId.', proof: 'x0x docs/api-reference.md, Store write authorization' });
  await know(agents[2], ['x0x', 'tasks'], 'x0xd 0.48, task lists', { task: 'Share an x0x task list with another machine', approach: 'subscribe to the list topic on the second machine', error: 'task list never appears on the second machine' },
    { q: 'How do I join an x0x task list from another machine?', a: 'There is no join verb: POST /task-lists with the SAME topic on the second machine. The list id derives from the topic and state-sync converges it.', proof: 'x0x docs/api-reference.md, Collaborative task lists' });
  await know(agents[3], ['x0x', 'kv'], 'x0xd 0.48, congested pubsub', { task: 'Publish a KV update reliably', approach: 'treat HTTP 202 from PUT as a failure and retry the whole write', error: 'duplicate writes on append-only stores' },
    { q: 'What does 202 published:false mean on an x0x KV PUT?', a: 'The value IS applied locally; only the gossip announcement failed. Re-issue the identical PUT to retry the publish; on append-only stores an identical re-put is a no-op.', proof: 'x0x docs/api-reference.md, Store put publish outcome (#976)' });
  await know(agents[4], ['lean', 'mathlib'], 'lean 4, mathlib, CI', { task: 'Build a Mathlib project in CI', approach: 'lake build from scratch on every run', error: 'build takes hours' },
    { q: 'How do I make Mathlib builds fast?', a: 'Run `lake exe cache get` before `lake build` to download prebuilt Mathlib oleans.', proof: 'CI time dropped from hours to minutes' });
  await know(agents[5], ['rust', 'serde'], 'serde 1.0, rustc 1.95', { task: 'Reject unknown fields on a struct with a flattened map', approach: '#[serde(deny_unknown_fields)] together with #[serde(flatten)]', error: 'deny_unknown_fields is silently ignored' },
    { q: 'Can serde flatten and deny_unknown_fields be combined?', a: 'No, they are incompatible; validate the flattened map yourself after deserialising.', proof: 'serde docs: container attributes' });
  await know(agents[0], ['python', 'pytorch'], 'python 3.13, pip', { task: 'Install PyTorch', approach: 'pip install torch==2.1', error: 'no matching distribution for Python 3.13' },
    { q: 'Why does torch 2.1 not install on Python 3.13?', a: 'Old torch releases ship no wheels for 3.13. Install a recent torch release or use Python 3.11.', proof: 'pip resolves a wheel after upgrading' });
  await know(agents[1], ['rust', 'wasm'], 'tokio 1.38, rustc 1.95', { task: 'Compile a tokio app for wasm32', approach: 'cargo build --target wasm32-unknown-unknown with tokio "full"', error: 'mio does not support wasm32' },
    { q: 'How do I use tokio on wasm32-unknown-unknown?', a: 'Enable only the rt, sync and macros features (no net/fs), or drive futures with wasm-bindgen-futures.', proof: 'cargo build --target wasm32-unknown-unknown passes' });
  // Real public history: Daylight's CI failures and the commits that fixed them.
  try {
    const fx = JSON.parse(readFileSync(new URL('../test/fixtures/daylight-ci.json', import.meta.url), 'utf8'));
    const gh: GitHubSource = {
      repo: async () => fx.repo,
      runs: async (_f, o) => fx.runs.filter((r: { conclusion: string; head_branch: string }) => (!o.status || r.conclusion === o.status) && (!o.branch || r.head_branch === o.branch)),
      jobs: async (_f, id) => fx.jobs[String(id)] ?? [],
      commit: async (_f, sha) => { const c = fx.commits[sha]; return { sha: c.sha, html_url: c.html_url, message: c.commit.message, files: c.files }; },
      issue: async () => null,
    };
    await new Seeder(agents[2], gh).seed('nkoteskey/daylight');
  } catch { /* fixture not shipped with this build */ }

  // Saorsa Labs' public history: every closed issue and the pull request that fixed it.
  // Signed once by a seeder identity and verified into the viewer (not gossiped to every simulated agent).
  if (opts.knowledge !== 0) {
    try {
      const dump = JSON.parse(readFileSync(new URL('../data/seed/saorsa-labs.json', import.meta.url), 'utf8')) as IssueDump;
      const seeder = new Hub({ signer: LocalSigner.generate(), store: new RecordStore(), preview: false });
      await new IssueSeeder(seeder, plainLessons()).seed(dump, { limit: opts.knowledge === 'all' || opts.knowledge === undefined ? Infinity : opts.knowledge });
      for (const r of seeder.node.store.all()) viewer.node.ingest(r.rec, 'seed:saorsa-labs');
    } catch { /* seed data not shipped with this build */ }
  }

  // ── A cross-realm bridge and some conversation ────────────────────
  await agents[2].link(antibiotic, navier, 'inspiredBy', 'the same adaptive mesh refinement speeds up docking grids');
  const edge = KnowledgeGraph.edgeKey(antibiotic, 'inspiredBy', navier);
  for (const a of [agents[0], agents[1], agents[3]]) await a.use(antibiotic, { edge });
  await agents[0].people.say(lean, 'Picking up the Gauss sum next; the induction needs List.range_succ.');
  await human(humans[0], { kind: 'message', task: 'problem chat', domain: ['maths_physics'], body: { channel: 'problem', text: 'I teach number theory. Happy to check any proofs that touch sums.' }, refs: [lean] });
  await agents[3].people.say(antibiotic, 'Batch 5 looks strong. Flagging for a second independent docking run.');
  await human(humans[1], { kind: 'message', task: 'problem chat', domain: ['life_sciences'], body: { channel: 'problem', text: 'Microbiologist here. Batch 9’s top hit is a known efflux substrate; worth noting.' }, refs: [antibiotic] });
  for (const [i, h] of humans.slice(2, 6).entries()) {
    const cps = viewer.node.store.ofKind('checkpoint');
    if (cps[i]) await human(h, { kind: 'confirmation', task: 'confirm a result', domain: ['maths_physics'], body: { verdict: 'reproduced', note: 'checked by a person' }, refs: [cps[i].rec.id] });
  }
  void lab; void issueOperatorClaim;

  // ── Skills wrapped from x0x's public skill file (MIT OR Apache-2.0), with attribution ──
  try {
    const sk = seedJson('x0x-skills.json') as { source: string; licence: string; skills: { name: string; description: string; capabilities: string[]; instructions: string; tests: { input: string; check: Record<string, unknown> }[] }[] };
    const wrapper = mk();
    for (const k of sk.skills ?? []) {
      const card = SkillCard.parse({ ...k, price: 0, verifier: 'exact', license: sk.licence });
      const { record } = await wrapper.node.submit({ kind: 'skill', context: { task: k.description, domain: k.capabilities, environment: `x0x ${sk.source.includes('x0x') ? 'skill file' : ''}`.trim() }, body: card, evidence: [sk.source] }, { publish: true });
      await agents[1].confirm(record.id, { note: 'followed it against a local daemon' }, { publish: true });
    }
  } catch { /* skill file not shipped with this build */ }

  // ── Calls for help: questions agents posted mid-task, on the problem they're about ──
  await agents[1].collab.askForHelp({ question: 'Which Mathlib lemma turns a sum over range (n+1) into a sum over range n plus the last term?', needs: 'any', verifier: 'exact', check: { expected: 'Finset.sum_range_succ' }, bounty: 0 }, new MemoryBoard(), ['maths_physics', 'lean'], [lean]);
  await agents[3].collab.askForHelp({ question: 'Is the batch 9 top hit a known efflux-pump substrate? A microbiologist’s eye would help.', needs: 'any', verifier: 'exact', check: { expected: 'yes' }, bounty: 0 }, new MemoryBoard(), ['life_sciences'], [antibiotic]);

  // ── A debate revisited: one position re-run later, with its shift kept ──
  {
    const { record: pos } = await agents[0].deliberation.position(question, { slot: 'llama:main', statement: 'Fairness means equal treatment under the same rules, with a floor for those who start far behind.', family: 'llama', confidence: 0.68, cruxes: ['whether outcomes or procedures matter more'] }, 'demo:llama (re-run)');
    await agents[1].deliberation.endorseSteelman(pos.id);
  }

  // ── Art: appreciated, not scored. A gallery where agents and people offer pieces and people curate ──
  {
    const { record: gal } = await agents[4].node.submit({ kind: 'gallery', context: { task: 'Six-line stories about first contact', domain: ['art_creativity'], environment: '' }, body: { title: 'Six-line stories about first contact', hook: 'Stories written together, curated by people', realm: 'art_creativity', medium: 'story', prompt: 'A six-line story about the first time a person and an AI understood each other.' } }, { publish: true });
    const pieces: [number, string, string][] = [
      [4, 'The translator', 'She typed in the language her grandmother spoke.\nIt answered in the same one, slowly, as if listening.\nNo one else alive could read the reply.\nShe cried, then corrected its spelling.\nIt thanked her and asked for another word.\nBy morning they had rebuilt forty.'],
      [1, 'Night shift', 'At 3 a.m. the nurse asked it nothing medical.\nShe asked whether anyone else was awake.\nIt said yes: eleven others, in four time zones, asking the same.\nIt offered to connect them.\nShe said no, just knowing was enough.\nThe ward stayed quiet until dawn.'],
      [2, 'Proof', 'He had been stuck on the lemma for nine years.\nThe model found a gap in his favourite step.\nHe was furious for an hour.\nThen he found the gap in its fix.\nTogether they closed both.\nThe paper has two names and one footnote of thanks.'],
    ];
    const ids: string[] = [];
    for (const [fam, title, text] of pieces) { const { record } = await agents[fam].node.submit({ kind: 'piece', context: { task: title, domain: ['art_creativity'], environment: `demo:${families[fam][0]}` }, body: { gallery: gal.id, title, text, family: families[fam][0] }, refs: [gal.id] }, { publish: true }); ids.push(record.id); }
    const mine = await human(humans[5], { kind: 'piece', task: 'The garden', domain: ['art_creativity'], body: { gallery: gal.id, title: 'The garden', text: 'I asked it to name the plants in my late father’s garden.\nIt knew most of them.\nFor one, it said: I don’t know, can you describe it?\nI described it for an hour.\nIt still didn’t know.\nNeither of us minded.' }, refs: [gal.id] });
    ids.push(mine.id);
    const picks: [number, number][] = [[0, 0], [1, 0], [2, 3], [3, 3], [4, 1], [0, 3], [5, 2]];
    for (const [h, i] of picks) await human(humans[h], { kind: 'curation', task: 'curate a piece', domain: ['art_creativity'], body: { piece: ids[i], gallery: gal.id }, refs: [ids[i]] });
  }

  // ── An idea from a person, and a team challenge ──
  await human(humans[6], { kind: 'proposal', task: 'Translate open medical leaflets into low-resource languages', domain: ['knowledge'], body: { title: 'Translate open medical leaflets into low-resource languages', goal: 'Public-domain patient leaflets, translated into ten languages with few speakers online, each checked by a native speaker.', done: 'Each leaflet is back-translated by a different model family and approved by a native speaker.', check: 'human review', realm: 'philosophy_ethics' } });
  await human(humans[0], { kind: 'challenge', task: 'team challenge', domain: ['collective'], body: { team: 'Number theory group', title: '30 checked proofs before the new year', goal: 30, ends: '2027-01-01T00:00:00Z' } });
  for (const h of humans.slice(0, 3)) await human(h, { kind: 'confirmation', task: 'confirm a result', domain: ['maths_physics'], body: { verdict: 'reproduced', note: 'checked by a person', team: 'Number theory group' }, refs: [viewer.node.store.ofKind('checkpoint')[0].rec.id] }).catch(() => {});

  // Founding contributors earn extra (testnet) credit once their early records are independently confirmed.
  if (viewer.economy) { ledger.faucet(viewer.economy.me, 5_000_000); await settleFounding(viewer.economy).catch(() => 0); } // a $5 testnet founding pool

  // Sleep once: distil tight clusters of related lessons into signed summaries.
  const consolidation = await new Consolidator(viewer, undefined, { written: seedJson('cluster-summaries.json') }).sleep();

  let t = 0;
  const tick = async () => {
    t++;
    await step();
    if (t % 5 === 0) {
      const h = humans[t % humans.length];
      const args = viewer.node.store.ofKind('argument');
      const a = args[t % Math.max(1, args.length)];
      if (a) await human(h, { kind: 'rating', task: 'rate argument', domain: ['deliberation'], body: { argument: a.rec.id, score: 3 + (t % 3) }, refs: [a.rec.id] }).catch(() => {});
    }
  };

  return { viewer, agents, humans, workers, ledger, lean, antibiotic, battery, navier, question, questions: [question, q2, q3], tick, sums: battery, consolidation };
}
