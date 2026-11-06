/** Small, dependency-free ranked text search (BM25-style) used by every lookup tool. */
const STOP = new Set('a an the and or of to in on for with without is was are be by at from it this that as not no into via when then than'.split(' '));

export function tokens(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9.+#_-]+/g, ' ').split(' ').map((t) => t.replace(/^[.-]+|[.-]+$/g, '')).filter((t) => t.length > 1 && !STOP.has(t));
}

export interface Doc { id: string; text: string; tags: string[] }

export function bm25(query: string, docs: Doc[], opts: { tags?: string[] } = {}): Map<string, number> {
  const q = [...new Set(tokens(query))];
  const N = docs.length || 1;
  const toks = docs.map((d) => tokens(d.text));
  const avg = toks.reduce((n, t) => n + t.length, 0) / N || 1;
  const df = new Map<string, number>();
  for (const t of toks) for (const w of new Set(t)) df.set(w, (df.get(w) ?? 0) + 1);
  const out = new Map<string, number>();
  const wantTags = new Set((opts.tags ?? []).map((t) => t.toLowerCase()));
  docs.forEach((d, i) => {
    const tf = new Map<string, number>();
    for (const w of toks[i]) tf.set(w, (tf.get(w) ?? 0) + 1);
    let s = 0;
    for (const w of q) {
      const f = tf.get(w); if (!f) continue;
      const idf = Math.log(1 + (N - (df.get(w) ?? 0) + 0.5) / ((df.get(w) ?? 0) + 0.5));
      s += idf * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * toks[i].length / avg));
    }
    const tagHits = d.tags.filter((t) => wantTags.has(t.toLowerCase())).length;
    if (wantTags.size && tagHits === 0 && s === 0) return;
    s += tagHits * 0.75;
    if (s > 0) out.set(d.id, s);
  });
  return out;
}

/** Overlap of version-ish tokens between two environment strings, 0..1. */
export function envSimilarity(a: string, b: string): number {
  const ta = new Set(tokens(a)), tb = new Set(tokens(b));
  if (!ta.size || !tb.size) return 0;
  let n = 0; for (const t of ta) if (tb.has(t)) n++;
  return n / Math.max(ta.size, tb.size);
}
