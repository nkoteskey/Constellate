// Builds the desktop app's starter library, signed by a one-off seed identity:
//   - Saorsa Labs' public issues and the fixes that closed them (redacted of personal details, see data/seed);
//   - negative results and findings from ScientistTwo's AI-generated research papers (Google Cloud AI Research);
//   - openly licensed public agent skills (Anthropic, Hugging Face, OpenAI, x0x, Autonomi, Research Loop), with credit,
//     and x0x's wrapped how-tos, which carry test cases;
//   - command usage from tldr-pages (CC BY 4.0), with credit;
//   - the topic pages that group them, and the featured problem and debate.
// On first run the app imports it, each record re-verified, so a new install opens on real lessons.
//   node desktop/scripts/starter.mjs <out-file>        (needs `npm run build` first)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname, '..', '..');
const out = resolve(process.argv[2] ?? join(ROOT, 'desktop', 'stage', 'starter', 'starter.cbor'));
const load = (p) => import(pathToFileURL(join(ROOT, 'dist', p)).href);
const json = (f) => JSON.parse(readFileSync(join(ROOT, 'data', 'seed', f), 'utf8'));

const { Hub } = await load('hub/hub.js');
const { LocalSigner } = await load('core/identity.js');
const { RecordStore } = await load('store/records.js');
const { IssueSeeder } = await load('seed/issues.js');
const { Consolidator } = await load('graph/consolidate.js');
const { exportSnapshot } = await load('seed/snapshot.js');

const hub = new Hub({ signer: LocalSigner.generate(), store: new RecordStore(), preview: false });
const report = await new IssueSeeder(hub, json('plain-lessons.json')).seed(json('saorsa-labs.json'));
// Research memory: negative results and findings from ScientistTwo's AI-generated papers (src/seed/papers.ts).
const { PaperSeeder } = await load('seed/papers.js');
const research = await new PaperSeeder(hub).seed(json('scientist-two.json'));
// Openly licensed public agent skills, credited and pinned to their source (src/seed/agent-skills.ts).
const skillSeed = await load('seed/agent-skills.js');
const skills = await skillSeed.seedAgentSkills(hub, json('agent-skills.json'), json('skill-tests.json'));
// x0x's wrapped how-tos, each with a test case, so they can be trialled (data/seed/x0x-skills.json).
const x0xSkills = await skillSeed.seedX0xSkills(hub, json('x0x-skills.json'));
// Command usage from tldr-pages (CC BY 4.0), the licence kept on every record (src/seed/tldr.ts).
const tldr = await (await load('seed/tldr.js')).seedTldr(hub, json('tldr-pages.json'));
const sleep = await new Consolidator(hub, undefined, { written: json('cluster-summaries.json') }).sleep();
// Featured work: re-check the Aaronson–Ambainis proof, and debate its statement (src/seed/featured.ts).
const featured = await (await load('seed/featured.js')).seedFeatured(hub);
if (!featured.problem) throw new Error('the featured problem was not accepted');
// Open problems from mathematics with machine-checkable answers, each with its public source (src/seed/open-problems.ts).
const openProblems = await (await load('seed/open-problems.js')).seedOpenProblems(hub);
if (openProblems.length !== 4) throw new Error(`open problems: ${openProblems.length} of 4 accepted`);
// One signature over the whole library (a batch root), so the bundle needn't carry 1,158 of them (docs/STORAGE.md).
const { merkle, signRecord } = await load('core/record.js');
const ids = hub.node.store.all().map((s) => s.rec.id);
const m = merkle(ids);
const root = await signRecord({ kind: 'batch_root', context: { task: 'batch', domain: ['storage'], environment: '' }, body: { root: m.root, count: m.proofs.size } }, hub.node.signer);
const bytes = exportSnapshot(hub.node.store, [{ root, ids }]);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, bytes);
console.log(`starter library: ${report.failures} failures, ${report.answers} fixes, ${research.failures + research.answers} research lessons from ${research.papers} papers, ${skills.added} public skills, ${x0xSkills.length} x0x skills with tests, ${tldr.added} tldr-pages commands, ${sleep.summarised} summaries, 1 featured problem and debate, ${openProblems.length} open problems (${hub.node.store.all().length} signed records, ${(bytes.length / 1e6).toFixed(1)} MB) → ${out}`);
