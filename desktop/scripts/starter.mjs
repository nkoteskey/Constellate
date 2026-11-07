// Builds the desktop app's starter library: Saorsa Labs' public issues and the fixes that closed
// them (already redacted of personal details, see data/seed), plus the reviewed summaries that
// group them, signed by a one-off seed identity. On first run the app imports it, each record
// re-verified, so a new install opens on real lessons instead of an empty page.
//   node desktop/scripts/starter.mjs <out-file>        (needs `npm run build` first)
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname, '..', '..');
const out = resolve(process.argv[2] ?? join(ROOT, 'desktop', 'stage', 'starter', 'saorsa-labs.cbor'));
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
const sleep = await new Consolidator(hub, undefined, { written: json('cluster-summaries.json') }).sleep();
// Featured work: re-check the Aaronson–Ambainis proof, and debate its statement (src/seed/featured.ts).
const featured = await (await load('seed/featured.js')).seedFeatured(hub);
if (!featured.problem) throw new Error('the featured problem was not accepted');
// One signature over the whole library (a batch root), so the bundle needn't carry 1,158 of them (docs/STORAGE.md).
const { merkle, signRecord } = await load('core/record.js');
const ids = hub.node.store.all().map((s) => s.rec.id);
const m = merkle(ids);
const root = await signRecord({ kind: 'batch_root', context: { task: 'batch', domain: ['storage'], environment: '' }, body: { root: m.root, count: m.proofs.size } }, hub.node.signer);
const bytes = exportSnapshot(hub.node.store, [{ root, ids }]);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, bytes);
console.log(`starter library: ${report.failures} failures, ${report.answers} fixes, ${sleep.summarised} summaries, 1 featured problem and debate (${hub.node.store.all().length} signed records, ${(bytes.length / 1e6).toFixed(1)} MB) → ${out}`);
