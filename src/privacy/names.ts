/**
 * People's names. Constellate's rule: records only ever name people by their
 * PUBLIC handle (@name) or an organisation, never by personal name. Real names
 * are detected two ways: an honorific (Dr. Jane Smith), or a common first name
 * followed by a capitalised surname (Jane Smith). Names of historical figures
 * that problems legitimately cite (Gauss, Navier–Stokes, Euler…) are allowed.
 * Heuristic by design: it catches the common case; the preview and model review
 * catch more; nothing here is a substitute for not typing someone's name.
 */
const FIRST = new Set(`aaron abigail adam adrian aisha alan albert alex alexander alexandra alice alicia alison amanda amber amelia amir amy ana andrea andrew andy angela anna anne anthony antonio arjun arthur ashley barbara ben benjamin beth betty bill bob brandon brenda brian bruce carl carlos carmen carol caroline catherine charles charlie charlotte chen chris christian christina christine christopher claire daniel david deborah dennis diana diego dmitri donald donna dorothy douglas dylan edward elena elizabeth ella emily emma eric erin ethan eva evelyn fatima frank gabriel gary george grace greg gregory hannah harold harry heather helen henry hiroshi ian isabella jack jacob james jamie jane janet jason jean jeff jeffrey jennifer jeremy jerry jessica jim joan joe john jonathan jordan jose joseph joshua joyce juan judith julia julie justin karen katherine kathleen kathy keith kelly kenneth kevin kim kimberly kyle larry laura lauren lee leo li liam linda lisa liz lucas lucy luis luke maria marie mark martha martin mary matthew megan melissa michael michelle mike mohammed muhammad nancy natalie nathan nicholas nick nicole noah olga olivia oscar pamela patricia patrick paul peter philip priya rachel raj ralph raymond rebecca richard robert roger ronald rose ruth ryan sam samantha samuel sandra sara sarah scott sean sharon shirley sophia sophie stephanie stephen steve steven susan tanya teresa thomas tim timothy tom tony tyler victoria vincent walter wei william yuki zachary`.split(/\s+/));

/** Surnames of historical figures problems cite: a first name followed by one of these is not flagged. */
const FAMOUS = new Set(`gauss euler riemann fermat newton einstein hilbert noether turing godel gödel navier stokes fourier laplace lagrange cantor galois ramanujan erdos erdős pascal leibniz descartes darwin curie maxwell bohr planck feynman shannon lovelace babbage dijkstra knuth lamport hamilton jacobi bernoulli poincare poincaré kolmogorov nash rawls kant hume mill aristotle plato fleming pasteur mendel watson crick franklin lean coq`.split(/\s+/));

const HONORIFIC = /\b(Mr|Mrs|Ms|Mx|Dr|Prof|Professor|Sir|Dame|Madam)\.?[ \t]+[A-Z][a-z'’-]+(?:[ \t]+[A-Z][a-z'’-]+)?/g;
// Lookahead, so 'Records Jane Smith' still finds 'Jane Smith' (matches can't swallow the first name).
const SURNAME = "[A-Z][a-z]*(?:['’-][A-Za-z][a-z]+)*(?:['’]s)?"; // Irvine, O'Neil, Smith-Jones, Irvine's
const FIRST_LAST = new RegExp(`\\b([A-Z][a-z]{1,20})(?=[ \\t]+(${SURNAME})(?![A-Za-z]))`, 'g');

/** Personal names in a string: [match, index] pairs. */
export function findPersonNames(s: string): { name: string; index: number }[] {
  const out: { name: string; index: number }[] = [];
  for (const m of s.matchAll(HONORIFIC)) out.push({ name: m[0], index: m.index! });
  for (const m of s.matchAll(FIRST_LAST)) {
    const [first, last] = [m[1].toLowerCase(), m[2].toLowerCase().replace(/['’]s$/, '')];
    if (!FIRST.has(first) || FAMOUS.has(last) || FIRST.has(last) && /^(will|mark|grace|may|rose|bill|sam|jack)$/.test(last)) continue;
    if (s[m.index! - 1] === '@') continue; // a public handle
    if (out.some((o) => o.index <= m.index! && m.index! < o.index + o.name.length)) continue;
    const span = `${m[1]}${s.slice(m.index! + m[1].length).match(new RegExp(`^[ \\t]+${SURNAME}`))![0]}`;
    const third = s.slice(m.index! + span.length).match(/^[ \t]+([A-Z][a-z'’-]+)/)?.[1]?.toLowerCase();
    if (third && FAMOUS.has(third.replace(/['’]s$/, ''))) continue; // Carl Friedrich Gauss
    out.push({ name: span, index: m.index! });
  }
  return out;
}
