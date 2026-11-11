import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { scrub } from '../privacy/scrub.js';
import { OPEN_PROBLEMS } from '../seed/open-problems.js';
import type { REALMS } from '../work/problems.js';
import { ERDOS_FINITE, ERDOS_OPEN, parseErdosYaml, parseFormalConjectures, readTarGz, type ErdosEntry, type FcEntry } from './sources.js';

/**
 * The problem scout (docs/SCOUT.md): finds open problems worth the network's time, from public catalogues, and ranks
 * them so proposing one is a click. Deterministic: the same catalogue gives the same list, and every rank comes with
 * the reasons for it. Nothing here publishes; proposing goes through the person's own idea form or agent.
 *
 * Lanes:
 * - quick_win: a machine can check an answer today, or a finite computation could settle it.
 * - moonshot: a large prize, or a problem famous enough to have its own encyclopaedia entry.
 * - formal: stated precisely in Lean, so a proof is machine-checkable; no other sign it's close.
 * - needs_check: open, but nothing a machine can check yet (shown only when asked for everything).
 */

export type Realm = (typeof REALMS)[number];
export type Lane = 'quick_win' | 'moonshot' | 'formal' | 'needs_check';
export type CheckKind = 'registered' | 'finite_search' | 'lean' | 'none';
export const LANES: Lane[] = ['quick_win', 'moonshot', 'formal', 'needs_check'];
/** What a candidate id looks like: erdos:N, fc:Folder/File.lean or seed:<verifier>. */
export const SCOUT_ID = /^(?:erdos:\d{1,5}|fc:[A-Za-z0-9]+(?:\/[A-Za-z0-9][A-Za-z0-9_.'-]*)+\.lean|seed:[a-z0-9_]{1,40})$/;

export interface Candidate {
  /** erdos:N, fc:Folder/File.lean, or seed:<verifier> for problems already on the network. */
  id: string;
  title: string;
  statement?: string;
  realm: Realm;
  field: string;
  lane: Lane;
  score: number;
  /** Why it ranks where it does, in plain words. */
  why: string[];
  /** How an answer would be checked. theorem: the formal-conjectures theorem a Lean proof must prove. */
  check: { kind: CheckKind; verifier?: string; theorem?: string; detail: string };
  /** What agents and lent computers do for it. */
  helpers: string;
  sources: { url: string; label: string; read: string }[];
  status: string;
  prize?: string;
  /** Already a problem on the network: open it rather than propose it again. */
  on_network: boolean;
}

export const SCOUT_SOURCES = {
  erdos: { url: 'https://raw.githubusercontent.com/teorth/erdosproblems/main/data/problems.yaml', label: 'teorth/erdosproblems (Apache-2.0)', home: 'https://github.com/teorth/erdosproblems' },
  fc: { url: 'https://codeload.github.com/google-deepmind/formal-conjectures/tar.gz/refs/heads/main', label: 'google-deepmind/formal-conjectures (Apache-2.0)', home: 'https://github.com/google-deepmind/formal-conjectures' },
};

export interface ScoutCatalogue { read: string; erdos: ErdosEntry[]; fc: FcEntry[] }

const AMS: Record<number, string> = {
  3: 'logic', 5: 'combinatorics', 6: 'order and lattices', 11: 'number theory', 12: 'field theory', 13: 'commutative algebra', 14: 'algebraic geometry',
  15: 'linear algebra', 16: 'rings and algebras', 17: 'nonassociative algebra', 18: 'category theory', 19: 'K-theory', 20: 'group theory', 22: 'topological groups',
  26: 'real functions', 28: 'measure theory', 30: 'complex analysis', 31: 'potential theory', 32: 'several complex variables', 33: 'special functions',
  34: 'ordinary differential equations', 35: 'partial differential equations', 37: 'dynamical systems', 39: 'difference equations', 40: 'sequences and series',
  41: 'approximation', 42: 'harmonic analysis', 43: 'abstract harmonic analysis', 44: 'integral transforms', 45: 'integral equations', 46: 'functional analysis',
  47: 'operator theory', 49: 'calculus of variations', 51: 'geometry', 52: 'convex and discrete geometry', 53: 'differential geometry', 54: 'general topology',
  55: 'algebraic topology', 57: 'manifolds', 58: 'global analysis', 60: 'probability', 62: 'statistics', 65: 'numerical analysis', 68: 'computer science',
  70: 'mechanics', 76: 'fluid mechanics', 81: 'quantum theory', 90: 'optimization', 91: 'game theory', 94: 'information theory',
};
/** Neutral names for catalogue folders, used when a file's own title can't be shown. */
const FOLDER: Record<string, string> = {
  Arxiv: 'Open problem from a paper', Paper: 'Open problem from a paper', Books: 'Open problem from a book', Mathoverflow: 'MathOverflow question',
  Kourovka: 'Kourovka notebook problem', WrittenOnTheWallII: 'Written on the Wall II conjecture', OptimizationConstants: 'Optimisation constant',
  OpenQuantumProblems: 'Open quantum problem', OEIS: 'OEIS conjecture', Wikipedia: 'Open problem', Millennium: 'Millennium Prize Problem',
  HilbertProblems: 'Hilbert problem', ErdosProblems: 'Erdős problem', Subsets: 'Open problem', Other: 'Open problem',
};
const MOONSHOT_FOLDERS = new Set(['Millennium', 'HilbertProblems', 'Wikipedia']);

/** A prize in US dollars, roughly (for ranking only). */
export function prizeUsd(prize?: string): number {
  const m = prize?.match(/^([$£₹€])(\d[\d,]*)$/);
  if (!m) return 0;
  return Number(m[2].replace(/,/g, '')) * ({ $: 1, '£': 1.3, '€': 1.1, '₹': 0.012 }[m[1]] ?? 0);
}

/** Text that can be shown: passes the network's personal-data check, or nothing. */
const shown = (s?: string) => (s && scrub({ s }, { level: 'standard' }).ok ? s : undefined);
/** Honest about today: Lean with Mathlib checks such a proof anywhere, but the network has no check for it yet. */
const LEAN_DETAIL = (theorem: string) => `a Lean proof of formal-conjectures' ${theorem}; anyone with Lean and Mathlib can check one today, and the network's own check for these is planned (docs/SCOUT.md)`;
const fcUrl = (path: string) => `${SCOUT_SOURCES.fc.home}/blob/main/FormalConjectures/${path.split('/').map(encodeURIComponent).join('/')}`;

/** What each finite status means (teorth/erdosproblems CONTRIBUTING.md), in plain words. */
const FINITE_WHY: Record<string, string> = {
  falsifiable: 'If it is false, one finite counterexample disproves it, and a computer can check a counterexample',
  verifiable: 'If it is true, one finite example proves it, and a computer can check an example',
  decidable: 'Reduced to a finite (if large) set of cases a computer can work through',
};

const HELPERS: Record<CheckKind, string> = {
  registered: 'Agents write and run the search; any computer checks an answer instantly, so a find is verified the moment it is shared.',
  finite_search: 'A finite computation could settle it. Agents write the search; adding a machine check for its answer lets every computer verify a find.',
  lean: 'Agents attempt a proof in Lean; a computer with Lean checks it against the formal statement, with no trust needed.',
  none: 'Not yet machine-checkable. An agent can state it precisely (in Lean, or as a finite search) so the network can work on it.',
};

function lane(check: CheckKind, usd: number, folder?: string): Lane {
  if (usd >= 500 || (folder && MOONSHOT_FOLDERS.has(folder))) return 'moonshot';
  if (check === 'registered' || check === 'finite_search') return 'quick_win';
  if (check === 'lean') return 'formal';
  return 'needs_check';
}

/** Problems already on the network with their own machine check (src/seed/open-problems.ts). */
export function seededCandidates(): Candidate[] {
  return OPEN_PROBLEMS.map((p) => ({
    id: `seed:${p.verifier}`, title: p.title, statement: p.hook, realm: 'maths_physics' as Realm, field: 'number theory and combinatorics',
    lane: 'quick_win' as Lane, score: 100, why: ['Already on the network with its own machine check', `${p.chunks.length} step${p.chunks.length === 1 ? '' : 's'} ready for agents`],
    check: { kind: 'registered' as CheckKind, verifier: p.verifier, detail: `the ${p.verifier} check: an answer is verified in under a second` },
    helpers: HELPERS.registered, sources: [{ url: p.source.url, label: p.source.url.replace(/^https:\/\/(?:en\.)?/, '').split('/')[0], read: p.source.read }],
    status: 'open', on_network: true,
  }));
}

/** Rank everything in a catalogue. Same catalogue in, same list out. */
export function rankCatalogue(cat: ScoutCatalogue): Candidate[] {
  const out: Candidate[] = [];
  const fcByPath = new Map(cat.fc.map((f) => [f.path, f]));
  for (const e of cat.erdos) {
    if (!ERDOS_OPEN.has(e.status)) continue;
    const fc = fcByPath.get(`ErdosProblems/${e.number}.lean`);
    const main = fc?.open.find((o) => o.name === `erdos_${e.number}`) ?? fc?.open[0];
    const finite = ERDOS_FINITE.has(e.status);
    const kind: CheckKind = finite ? 'finite_search' : main ? 'lean' : 'none';
    const usd = prizeUsd(e.prize);
    const why: string[] = [];
    let score = 0;
    if (finite) { score += 35; why.push(FINITE_WHY[e.status]); }
    if (main) { score += 25; why.push('Stated in Lean (formal-conjectures), so a proof is machine-checkable'); }
    if (usd) { score += Math.min(20, Math.round(5 * Math.log10(usd))); why.push(`Prize offered: ${e.prize}`); }
    if (e.oeis.length) { score += 5; why.push(`Linked to OEIS ${e.oeis.slice(0, 3).join(', ')}: small cases can be computed`); }
    const ambiguous = e.name === 'ambiguous statement';
    if (ambiguous) { score -= 30; why.push('The catalogue marks its statement as ambiguous'); }
    const name = !ambiguous ? shown(e.name) : undefined;
    const title = `Erdős problem #${e.number}${name ? `: ${name}` : ''}`;
    out.push({
      id: `erdos:${e.number}`, title, statement: shown(main?.statement), realm: 'maths_physics', field: e.tags[0] ?? 'mathematics',
      lane: ambiguous ? 'needs_check' : lane(kind, usd), score, why,
      check: { kind, theorem: main?.name, detail: kind === 'lean' ? LEAN_DETAIL(main!.name) : kind === 'finite_search' ? 'no machine check yet; one can be written for the finite search' : 'none yet' },
      helpers: HELPERS[kind],
      sources: [
        { url: `https://www.erdosproblems.com/${e.number}`, label: 'erdosproblems.com', read: cat.read },
        { url: SCOUT_SOURCES.erdos.home, label: SCOUT_SOURCES.erdos.label, read: cat.read },
        ...(fc ? [{ url: fcUrl(fc.path), label: SCOUT_SOURCES.fc.label, read: cat.read }] : []),
      ],
      status: e.status, prize: e.prize, on_network: false,
    });
  }
  for (const f of cat.fc) {
    if (f.folder === 'ErdosProblems') continue; // merged into the Erdős entries above
    const first = f.open.find((o) => shown(o.statement)) ?? f.open[0];
    const usd = f.folder === 'Millennium' ? 1_000_000 : 0;
    const why = ['Stated in Lean (formal-conjectures), so a proof is machine-checkable'];
    let score = 25;
    if (f.folder === 'OEIS') { score += 10; why.push('About an integer sequence: terms can be computed to test it'); }
    if (f.folder === 'Millennium') { score += 20; why.push('A Millennium Prize Problem ($1,000,000)'); }
    if (f.folder === 'Wikipedia' || f.folder === 'HilbertProblems') { score += 10; why.push('Famous enough to have its own encyclopaedia entry'); }
    if (f.open.length > 1) { score += Math.min(5, f.open.length - 1); why.push(`${f.open.length} open statements in one place`); }
    const stem = f.path.split('/').slice(1).join('/').replace(/\.lean$/, '');
    const title = shown(f.title) ?? shown(`${FOLDER[f.folder] ?? 'Open problem'} ${stem}`);
    if (!title) continue;
    const ams = first.ams.map((n) => AMS[n]).find(Boolean);
    out.push({
      id: `fc:${f.path}`, title, statement: shown(first.statement) ?? shown(f.summary), realm: 'maths_physics', field: ams ?? 'mathematics',
      lane: lane('lean', usd, f.folder), score, why,
      check: { kind: 'lean', theorem: first.name, detail: LEAN_DETAIL(first.name) }, helpers: HELPERS.lean,
      sources: [{ url: fcUrl(f.path), label: SCOUT_SOURCES.fc.label, read: cat.read }],
      status: 'open', prize: f.folder === 'Millennium' ? '$1,000,000' : undefined, on_network: false,
    });
  }
  return out;
}

/** all: include what's not yet checkable and what's already on the network (otherwise left out). */
export interface ScoutQuery { realm?: Realm; lane?: Lane; limit?: number; all?: boolean; q?: string }

/** Sort by score, then id, so ties come out the same everywhere. */
const byRank = (a: Candidate, b: Candidate) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * The scout: a cached copy of the catalogues under CONSTELLATE_HOME/scout, refreshed from their public sources.
 * Without a copy it still lists the problems already on the network.
 */
export class Scout {
  readonly dir: string;
  private cat: ScoutCatalogue | null | undefined;
  constructor(home = process.env.CONSTELLATE_HOME ?? join(homedir(), '.constellate'), private readonly fetcher: typeof fetch = fetch) {
    this.dir = join(home, 'scout');
  }

  catalogue(): ScoutCatalogue | null {
    if (this.cat !== undefined) return this.cat;
    const file = join(this.dir, 'catalogue.json');
    try { this.cat = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as ScoutCatalogue) : null; } catch { this.cat = null; }
    return this.cat;
  }

  /** Days since the catalogue was read, or null without one. */
  age(now = new Date()): number | null {
    const c = this.catalogue();
    return c ? Math.floor((now.getTime() - Date.parse(c.read)) / 86_400_000) : null;
  }

  /** Read both catalogues from their public sources; only the parsed, safe fields are kept on disk. */
  async refresh(now = new Date()): Promise<{ erdos: number; fc: number; read: string }> {
    const get = async (url: string) => {
      const r = await this.fetcher(url, { headers: { 'user-agent': 'constellate-scout' }, signal: AbortSignal.timeout(60_000) });
      if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
      return new Uint8Array(await r.arrayBuffer());
    };
    const [yaml, tar] = await Promise.all([get(SCOUT_SOURCES.erdos.url), get(SCOUT_SOURCES.fc.url)]);
    const erdos = parseErdosYaml(new TextDecoder().decode(yaml));
    const files = readTarGz(tar, (p) => /\/FormalConjectures\/.+\.lean$/.test(p)).map((f) => ({ path: f.path.replace(/^.*?\/FormalConjectures\//, ''), text: f.text }));
    const fc = parseFormalConjectures(files);
    if (!erdos.length || !fc.length) throw new Error('a catalogue came back empty; keeping the copy we have');
    const cat: ScoutCatalogue = { read: now.toISOString().slice(0, 10), erdos, fc };
    mkdirSync(this.dir, { recursive: true });
    const file = join(this.dir, 'catalogue.json');
    writeFileSync(`${file}.tmp`, JSON.stringify(cat));
    renameSync(`${file}.tmp`, file);
    this.cat = cat;
    return { erdos: erdos.length, fc: fc.length, read: cat.read };
  }

  /** Every candidate: problems already on the network first, then the catalogue's, ranked. */
  all(): Candidate[] {
    const c = this.catalogue();
    return [...seededCandidates(), ...(c ? rankCatalogue(c) : [])];
  }

  get(id: string): Candidate | undefined { return this.all().find((c) => c.id === id); }

  list(q: ScoutQuery = {}): { read: string | null; items: Candidate[]; counts: Record<Lane, number> } {
    const words = (q.q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    const pool = this.all().filter((c) => (!q.realm || c.realm === q.realm) && (q.all || ((q.lane === 'needs_check' || c.lane !== 'needs_check') && !c.on_network))
      && (!words.length || words.every((w) => `${c.title} ${c.statement ?? ''} ${c.field}`.toLowerCase().includes(w))));
    const counts = Object.fromEntries(LANES.map((l) => [l, pool.filter((c) => c.lane === l).length])) as Record<Lane, number>;
    const items = pool.filter((c) => !q.lane || c.lane === q.lane).sort(byRank).slice(0, Math.max(1, Math.min(q.limit ?? 20, 200)));
    return { read: this.catalogue()?.read ?? null, items, counts };
  }
}

/** Realms with no catalogue yet: how an agent scouts one itself, to the network's rules. */
const REALM_SOURCES: Partial<Record<Realm, string>> = {
  life_sciences: 'open challenges with public benchmarks or datasets (protein structure, drug-target prediction), and reproduction attempts of published results',
  planet_energy: 'open materials and climate challenges with public data and a scoring script (battery, catalyst and solar-cell property prediction)',
  philosophy_ethics: 'open questions in published surveys, where done is a written argument that reviewers rate against stated criteria',
  art_creativity: 'open briefs and constraints-based challenges, where done is a piece that meets a checkable constraint',
};
export function scoutingBrief(realm: Realm): string {
  return [
    `No catalogue for ${realm} yet, so scout it yourself.`,
    `Look for ${REALM_SOURCES[realm] ?? 'open problems in public, openly licensed sources'}.`,
    'Rank by how close a machine is to checking an answer: a test, a benchmark score, a proof checker or a reproducible computation beats human judgement.',
    'For each, give a public source URL and the date you read it, and name people only by a public @handle or an organisation: never a personal name.',
    'Show your person the shortlist; proposing is their call.',
  ].join(' ');
}

/** The idea a candidate becomes: what the idea form is prefilled with, for the person to edit and post. */
export function ideaFor(c: Candidate): { title: string; goal: string; done: string; realm: Realm } {
  const src = c.sources[0];
  const done = c.check.kind === 'registered' ? `The ${c.check.verifier} check passes on a submitted answer`
    : c.check.kind === 'lean' ? `A Lean proof (or disproof) of formal-conjectures' ${c.check.theorem} builds against it with no sorry and only the standard axioms`
      : c.check.kind === 'finite_search' ? `${c.status === 'falsifiable' ? 'A counterexample' : c.status === 'verifiable' ? 'An example' : 'The finite case analysis'} found by search passes a machine check written for it${c.check.theorem ? `, or a Lean proof of formal-conjectures' ${c.check.theorem} builds with no sorry` : ''}`
        : 'A precise statement exists that a machine can check';
  // Catalogue statements are formal-conjectures docstrings (Apache-2.0): the proposal says where its text came from.
  const text = c.statement && !c.id.startsWith('seed:') ? c.sources.find((s) => s.label === SCOUT_SOURCES.fc.label) : undefined;
  const credit = !text ? '' : text.url === src.url ? `\nText from ${SCOUT_SOURCES.fc.label}.` : `\nText from ${SCOUT_SOURCES.fc.label}: ${text.url}`;
  return { title: c.title.slice(0, 120), goal: `${c.statement ?? c.title}\n\n${c.helpers}\n\nSource (read ${src.read}): ${src.url}${credit}`, done, realm: c.realm };
}
