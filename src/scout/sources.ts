import { gunzipSync } from 'node:zlib';

/**
 * Public catalogues of open problems the scout reads (docs/SCOUT.md). Both are Apache-2.0:
 *
 * - teorth/erdosproblems `data/problems.yaml`: every Erdős problem's number, status, prize, tags and OEIS links.
 * - google-deepmind/formal-conjectures: open conjectures stated in Lean, one file per problem.
 *
 * Only the fields a problem page needs are read. Both catalogues also carry people's names (contributor notes in
 * the YAML, author lists in each Lean file's references), and those are never read: the parsers skip the YAML's
 * `formal_status` block entirely, skip every Lean `*References:*` block, and drop any sentence that credits
 * someone ("proved by", "due to", a citation key like [AB12]).
 */

export interface ErdosEntry {
  number: number;
  /** As written: "$500", "£25", "₹1000"; absent for no prize. */
  prize?: string;
  /** status.state, lower case: open, falsifiable, proved (lean), … */
  status: string;
  updated?: string;
  /** Whether formal-conjectures has a Lean statement of it. */
  formalized: boolean;
  oeis: string[];
  tags: string[];
  /** The problem's common name, when it has one ("sunflower conjecture"). */
  name?: string;
}

/**
 * Statuses that mean nobody has settled it yet (the repository's CONTRIBUTING.md defines them). A status ending in
 * "(Lean)", even "open (Lean)", means a solution has been checked in Lean and awaits a human reading: not open here.
 */
export const ERDOS_OPEN = new Set(['open', 'falsifiable', 'verifiable', 'decidable', 'not provable', 'not disprovable']);
/** Open, and settled by something finite: a counterexample if false (falsifiable), an example if true (verifiable), or both (decidable). */
export const ERDOS_FINITE = new Set(['falsifiable', 'verifiable', 'decidable']);

const unquote = (v: string): string => {
  const t = v.trim();
  if (t.startsWith('"')) { try { return JSON.parse(t) as string; } catch { return t.slice(1, -1); } }
  return t;
};
const list = (v: string): string[] => {
  try { const a = JSON.parse(v.trim()); return Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string') : []; } catch { return []; }
};
/** An unclosed double-quoted value continues on the next lines (multi-line notes). */
const opensQuote = (v: string) => { const t = v.trim(); return t.startsWith('"') && !/[^\\]"$/.test(t.slice(1)) && t !== '""'; };

/**
 * The Erdős problems YAML, read line by line for the safe fields only: number, prize, status, formalized, OEIS,
 * tags and the short common name. Notes and links (`formal_status`) are skipped without being parsed.
 */
export function parseErdosYaml(text: string): ErdosEntry[] {
  const out: ErdosEntry[] = [];
  for (const chunk of text.split(/\n(?=- number: )/)) {
    let section = '', skipping = false;
    const e: Partial<ErdosEntry> & { formalized?: boolean } = {};
    for (const line of chunk.split('\n')) {
      if (skipping) { if (/[^\\]"\s*$/.test(line)) skipping = false; continue; }
      const top = line.match(/^(?:- | {2})([a-z_]+):\s*(.*)$/);
      const sub = line.match(/^ {4}([a-z_]+):\s*(.*)$/);
      const value = (top ?? sub)?.[2] ?? '';
      if ((top || sub) && opensQuote(value)) skipping = true;
      if (top) {
        section = top[1];
        if (section === 'number') { const n = Number(unquote(value)); if (Number.isInteger(n) && n > 0) e.number = n; }
        else if (section === 'prize') { const p = unquote(value); if (/^[$£₹€]\d[\d,]*$/.test(p)) e.prize = p; }
        else if (section === 'oeis') e.oeis = list(value).filter((x) => /^A\d{6}$/.test(x));
        else if (section === 'tags') e.tags = list(value).filter((x) => /^[a-z][a-z0-9 ,'()-]{0,60}$/i.test(x));
        else if (section === 'comments') { const c = unquote(value); if (c.length <= 80 && !skipping) e.name = c; }
      } else if (sub && section === 'status') {
        if (sub[1] === 'state') e.status = unquote(sub[2]).toLowerCase();
        if (sub[1] === 'last_update' && /^"?\d{4}-\d{2}-\d{2}"?$/.test(sub[2].trim())) e.updated = unquote(sub[2]);
      } else if (sub && section === 'formalized' && sub[1] === 'state') e.formalized = unquote(sub[2]) === 'yes';
    }
    if (e.number && e.status) out.push({ number: e.number, prize: e.prize, status: e.status, updated: e.updated, formalized: !!e.formalized, oeis: e.oeis ?? [], tags: e.tags ?? [], name: e.name });
  }
  return out;
}

export interface FcStatement {
  /** The Lean theorem's name, e.g. erdos_3 or OeisA100474.conjecture. */
  name: string;
  /** The docstring's first paragraph, with any crediting sentence removed; absent when nothing safe is left. */
  statement?: string;
  /** question: a yes/no answer; value: the answer is a number or object; statement: prove (or disprove) it. */
  form: 'question' | 'value' | 'statement';
  ams: number[];
}

export interface FcEntry {
  /** Relative to FormalConjectures/, e.g. ErdosProblems/3.lean. */
  path: string;
  folder: string;
  title: string;
  /** The file's description under its title, before the references, when there is one. */
  summary?: string;
  open: FcStatement[];
}

/** A sentence that credits someone: dropped, so names in attributions never reach a page. */
const CREDIT = new RegExp([
  String.raw`\[[A-Za-z][A-Za-z+-]*\d{2,4}[a-z]?\]`, // a citation key: [AB12], [X2020]
  String.raw`\b(?:proved|proven|proposed|shown|conjectured|asked|posed|introduced|studied|due|answered|disproved|solved|found|observed|noted|raised|suggested|attributed|credited|communicated|computed|verified|established|announced|added|extended|improved|given|settled)\s+(?:by|to|in)\b`,
  String.raw`\b(?:conjectured|cf\.|et al|personal communication|preprint|arxiv)`,
  String.raw`https?:\/\/`,
  String.raw`\b[A-Z]\.\s?(?:[A-Z]\.\s?)*[A-Z][a-z]{2,}`, // an initial and a surname: W. Smith
  String.raw`_[A-Z][^_$]*_`, // an italic name, as OEIS signs entries
  String.raw`\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(?:\d{1,2},?\s+)?(?:1[89]|20)\d{2}\b`, // a dated remark
].join('|'), 'i');
/** "comment by Someone", "conjecture from Someone": case matters here, so "by the" and "from a" are not caught. */
const CREDIT_NAMED = /\b(?:[Bb]y|[Ff]rom)\s+[A-Z][a-z]+/;
/** OEIS signs a remark at its end: " - Name, Jul 01 2010". */
const SIGNATURE = /\s+-\s+[^$]{1,80}?,\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}\.?\s*$/;
/** A parenthetical with a year and no maths, e.g. "(Name, Aug 21 2009)". */
const DATED_ASIDE = /\s*\((?=[^()$]*\b(?:1[89]|20)\d{2}\b)[^()$]*\)/g;

/** Collapse a docstring paragraph to one line and drop crediting sentences. */
export function safeParagraph(p: string, max = 700): string | undefined {
  const flat = p.replace(/\s+/g, ' ').trim().replace(SIGNATURE, '').replace(DATED_ASIDE, '');
  if (!flat) return undefined;
  // Split into sentences without breaking inside $…$ maths.
  const parts: string[] = [];
  let cur = '', inMath = false;
  for (let i = 0; i < flat.length; i++) {
    const ch = flat[i];
    cur += ch;
    if (ch === '$') inMath = !inMath;
    if (!inMath && /[.?!]/.test(ch) && (flat[i + 1] === ' ' || i === flat.length - 1)) { parts.push(cur.trim()); cur = ''; }
  }
  if (cur.trim()) parts.push(cur.trim());
  const kept = parts.map((s) => s.replace(SIGNATURE, '')).filter((s) => s && !CREDIT.test(s) && !CREDIT_NAMED.test(s)).join(' ').trim();
  if (!kept || kept.length > max) return undefined;
  return kept;
}

const firstParagraph = (doc: string) => doc.trim().split(/\n\s*\n/)[0] ?? '';

const SUMMARY_FOLDERS = new Set(['OEIS', 'Wikipedia']);

/** One open conjecture: a docstring, optional `set_option … in` lines, the research-open attribute, the theorem. */
const OPEN_THEOREM = /\/--((?:(?!-\/)[\s\S])*)-\/\s*(?:set_option[^\n]*\n\s*)*@\[category research open([^\]]*)\]\s*(?:theorem|lemma)\s+([^\s:({[]+)/g;

/**
 * formal-conjectures Lean files: the title, the description under it, and each open statement's docstring. The
 * module's `*References:*` block is cut off before anything is read from it.
 */
export function parseFormalConjectures(files: { path: string; text: string }[]): FcEntry[] {
  const out: FcEntry[] = [];
  for (const f of files) {
    if (!/^[A-Za-z0-9]+\/[^/]+(?:\/[^/]+)*\.lean$/.test(f.path)) continue;
    const open: FcStatement[] = [];
    for (const m of f.text.matchAll(OPEN_THEOREM)) {
      const attrs = m[2];
      const form = /\bquestion value\b/.test(attrs) ? 'value' : /\bquestion\b/.test(attrs) ? 'question' : 'statement';
      const ams = [...attrs.matchAll(/\bAMS((?:\s+\d+)+)/g)].flatMap((a) => a[1].trim().split(/\s+/).map(Number));
      open.push({ name: m[3], statement: safeParagraph(firstParagraph(m[1])), form, ams });
    }
    if (!open.length) continue;
    const mod = f.text.match(/\/-!\s*\n#\s+([^\n]+)\n([\s\S]*?)-\//);
    const title = (mod?.[1] ?? '').trim();
    if (!title) continue;
    const folder = f.path.split('/')[0];
    // A description under the title: kept for sequences and encyclopaedia entries, where it defines the object.
    // Elsewhere (papers, books) it is usually a citation or an author list, so it is not read.
    const desc = SUMMARY_FOLDERS.has(folder) ? (mod?.[2] ?? '').split(/\*References:?\*|^References:?/m)[0] : '';
    out.push({ path: f.path, folder, title, summary: safeParagraph(firstParagraph(desc)), open });
  }
  return out;
}

/**
 * The files in a .tar.gz (GitHub's source archives), keeping only those `want` accepts. Handles ustar prefixes and
 * pax long paths; nothing is written to disk.
 */
export function readTarGz(gz: Uint8Array, want: (path: string) => boolean, maxFileBytes = 512 * 1024): { path: string; text: string }[] {
  const buf = gunzipSync(gz);
  const out: { path: string; text: string }[] = [];
  const str = (a: number, b: number) => buf.subarray(a, b).toString('utf8').replace(/\0.*$/s, '');
  let off = 0, paxPath: string | undefined;
  while (off + 512 <= buf.length) {
    const h = off;
    if (buf[h] === 0) break; // end of archive
    const size = parseInt(str(h + 124, h + 136).trim() || '0', 8);
    const type = String.fromCharCode(buf[h + 156] || 48);
    const prefix = str(h + 345, h + 500);
    const name = paxPath ?? (prefix ? `${prefix}/${str(h, h + 100)}` : str(h, h + 100));
    const body = h + 512;
    if (!Number.isFinite(size) || size < 0 || body + size > buf.length) break;
    paxPath = undefined;
    if (type === 'x') {
      const pax = buf.subarray(body, body + size).toString('utf8');
      const p = pax.match(/(?:^|\n)\d+ path=([^\n]*)\n/);
      if (p) paxPath = p[1];
    } else if ((type === '0' || type === '\0') && size <= maxFileBytes && want(name)) {
      out.push({ path: name, text: buf.subarray(body, body + size).toString('utf8') });
    }
    off = body + Math.ceil(size / 512) * 512;
  }
  return out;
}
