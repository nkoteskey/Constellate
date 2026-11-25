import type { Verifier } from './verifiers.js';
import { answerText, whole } from './combinatorics.js';
import { scrub } from '../privacy/scrub.js';

/**
 * Argument maps for open questions (docs/CHECKERS.md): built in, structure only. The machine checks that a map is
 * well formed, cited and free of personal data; it never judges which side is right. A model from a different
 * family then judges whether the map is fair and on topic, and people rate the arguments. Nothing here produces a
 * verdict on the question itself.
 *
 * A map is JSON: {"question": the root question, exactly as the step gives it, "nodes": [...]}. Each node:
 * {"id", "parent" ("root" or another node's id), "type", "claim" (1–600 characters), "cites": [{"url", "quote"}],
 * "crux"?: true}. Positions answer the root; pros and cons sit under a position; objections under any node;
 * replies under an objection. Every pro, con, objection and reply cites at least one public source, with a quote
 * of at most 300 characters. No two claims say the same thing word for word.
 */
export const ARGMAP_MAX_NODES = 400;
export const NODE_TYPES = ['position', 'pro', 'con', 'objection', 'reply'] as const;
type NodeType = (typeof NODE_TYPES)[number];
const PARENTS: Record<NodeType, (p: NodeType | 'root') => boolean> = {
  position: (p) => p === 'root',
  pro: (p) => p === 'position',
  con: (p) => p === 'position',
  objection: (p) => p !== 'root',
  reply: (p) => p === 'objection',
};

const ok = (detail: string) => ({ ok: true, detail });
const no = (detail: string) => ({ ok: false, detail });
const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

interface Node { id: string; parent: string; type: NodeType; claim: string; cites: { url: string; quote: string }[]; crux?: boolean }

export const argmapVerifier: Verifier = {
  name: 'argmap',
  shape: `check {"question": the root question, "need": {"position"|"pro"|"con"|"objection"|"reply"|"crux": at least how many}, "depth"?: objection–reply levels}; answer: JSON {"question", "nodes": [{"id", "parent": "root" or an id, "type", "claim", "cites": [{"url", "quote" ≤ 300 chars}], "crux"?: true}]}, at most ${ARGMAP_MAX_NODES} nodes; every pro, con, objection and reply cites a source; no personal names`,
  async check(spec, output) {
    const question = String(spec.question ?? '').trim();
    if (!question) return no('the check needs the root question');
    const text = answerText(output, 400_000);
    if (text === null) return no('answer too long');
    let j: { question?: unknown; nodes?: unknown };
    try { j = JSON.parse(text); } catch { return no('give the map as JSON: {"question": …, "nodes": […]}'); }
    if (typeof j.question !== 'string' || j.question.trim() !== question) return no('the map’s question must be the step’s question, word for word');
    if (!Array.isArray(j.nodes) || !j.nodes.length) return no('the map has no nodes');
    if (j.nodes.length > ARGMAP_MAX_NODES) return no(`at most ${ARGMAP_MAX_NODES} nodes`);
    const nodes = new Map<string, Node>();
    for (const [i, raw] of (j.nodes as Record<string, unknown>[]).entries()) {
      const id = String(raw?.id ?? '');
      if (!/^[\w-]{1,40}$/.test(id) || id === 'root') return no(`node ${i + 1}: an id of letters, digits, - or _ (not "root")`);
      if (nodes.has(id)) return no(`two nodes have the id "${id}"`);
      const type = raw.type as NodeType;
      if (!NODE_TYPES.includes(type)) return no(`node "${id}": type is one of ${NODE_TYPES.join(', ')}`);
      const claim = typeof raw.claim === 'string' ? raw.claim.trim() : '';
      if (!claim || claim.length > 600) return no(`node "${id}": a claim of 1 to 600 characters`);
      const cites = Array.isArray(raw.cites) ? raw.cites as { url?: unknown; quote?: unknown }[] : [];
      for (const c of cites) {
        if (typeof c?.url !== 'string' || !/^https?:\/\/[^\s]+$/.test(c.url) || c.url.length > 500) return no(`node "${id}": each citation needs a web address (http or https)`);
        if (typeof c.quote !== 'string' || !c.quote.trim() || c.quote.length > 300) return no(`node "${id}": each citation quotes its source, at most 300 characters`);
      }
      if (type !== 'position' && !cites.length) return no(`node "${id}": a ${type} cites at least one source`);
      nodes.set(id, { id, parent: String(raw.parent ?? ''), type, claim, cites: cites as Node['cites'], ...(raw.crux === true ? { crux: true } : {}) });
    }
    // Every parent exists and fits; following parents always reaches the root (so no cycles).
    for (const n of nodes.values()) {
      const pt = n.parent === 'root' ? 'root' : nodes.get(n.parent)?.type;
      if (!pt) return no(`node "${n.id}": parent "${n.parent}" doesn't exist`);
      if (!PARENTS[n.type](pt)) return no(`node "${n.id}": a ${n.type} can't sit under ${pt === 'root' ? 'the question' : `a ${pt}`}`);
    }
    const depth = new Map<string, number>(); // objection–reply levels
    for (const n of nodes.values()) {
      const seen = new Set<string>();
      let cur: Node | undefined = n, d = 0;
      while (cur) {
        if (seen.has(cur.id)) return no(`node "${n.id}": its parents go round in a circle`);
        seen.add(cur.id);
        if (cur.type === 'objection') d++;
        cur = cur.parent === 'root' ? undefined : nodes.get(cur.parent);
      }
      depth.set(n.id, d);
    }
    const claims = new Map<string, string>();
    for (const n of nodes.values()) {
      const k = norm(n.claim);
      if (claims.has(k)) return no(`nodes "${claims.get(k)}" and "${n.id}" make the same claim`);
      claims.set(k, n.id);
    }
    const priv = scrub({ question: j.question, nodes: [...nodes.values()].map((n) => ({ claim: n.claim, cites: n.cites.map((c) => c.quote) })) });
    if (!priv.ok) return no(`personal data in the map (${[...new Set(priv.findings.map((f) => f.type))].join(', ')}): name people only by a public handle or an organisation`);
    const need = (spec.need ?? {}) as Record<string, unknown>;
    const count = (t: string) => t === 'crux' ? [...nodes.values()].filter((n) => n.crux).length : [...nodes.values()].filter((n) => n.type === t).length;
    for (const [t, v] of Object.entries(need)) {
      const want = whole(v, 0, ARGMAP_MAX_NODES);
      if (want === null || ![...NODE_TYPES, 'crux'].includes(t)) return no(`the check's "need" has a bad entry: ${t}`);
      if (count(t) < want) return no(`${count(t)} ${t} node(s); this step needs at least ${want}`);
    }
    // Pros and cons under each position, when asked for.
    if (need.pro || need.con) for (const p of [...nodes.values()].filter((x) => x.type === 'position')) {
      const kids = [...nodes.values()].filter((x) => x.parent === p.id);
      if (need.pro && !kids.some((x) => x.type === 'pro')) return no(`position "${p.id}" has no pro`);
      if (need.con && !kids.some((x) => x.type === 'con')) return no(`position "${p.id}" has no con`);
    }
    const levels = whole(spec.depth ?? 0, 0, 20) ?? 0;
    const deepest = Math.max(0, ...depth.values());
    if (deepest < levels) return no(`objections go ${deepest} level(s) deep; this step needs ${levels}`);
    const tally = NODE_TYPES.map((t) => `${count(t)} ${t}`).join(', ');
    return ok(`a well-formed map: ${tally}, ${count('crux')} crux; every argument cited; no personal data. Structure only: it says nothing about which side is right`);
  },
};
