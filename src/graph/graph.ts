import { readFileSync } from 'node:fs';
import { RecordStore, StoredRecord } from '../store/records.js';
import { TrustModel } from '../services/trust.js';
import { sha256Hex, canonicalBytes } from '../core/canonical.js';

/**
 * The knowledge graph: a light, plastic, brain-like layer over signed records.
 * Every record is a node (its id is its content hash) and every link a synapse.
 * Links come from records' refs (typed by kind) and from explicit signed `link`
 * records. Each link has a weight that strengthens when agents use, confirm or
 * build on it and decays when unused. Weight only affects ranking; nothing is
 * ever deleted. Contradicts links inhibit their target, in context.
 * Exported as JSON-LD against the versioned Constellate context.
 */
export const LINK_TYPES = ['buildsOn', 'fixes', 'contradicts', 'confirms', 'inspiredBy', 'sameAs'] as const;
export type LinkType = (typeof LINK_TYPES)[number];
export const CONTEXT_URL = 'https://constellate.network/ns/v1';
export const VOCAB_VERSION = '1.0.0';

export interface Edge { key: string; from: string; to: string; type: LinkType; created: number; events: number[]; source: string }
export interface Bridge { edge: string; from: string; to: string; fromRealm: string; toRealm: string; weight: number }

const REALM_OF_DOMAIN: Record<string, string> = {
  maths_physics: 'maths_physics', maths: 'maths_physics', mathematics: 'maths_physics', physics: 'maths_physics', lean: 'maths_physics',
  life_sciences: 'life_sciences', biology: 'life_sciences', chemistry: 'life_sciences', medicine: 'life_sciences', drugs: 'life_sciences',
  planet_energy: 'planet_energy', climate: 'planet_energy', energy: 'planet_energy', materials: 'planet_energy',
  philosophy_ethics: 'philosophy_ethics', ethics: 'philosophy_ethics', philosophy: 'philosophy_ethics', deliberation: 'philosophy_ethics',
  art_creativity: 'art_creativity', art: 'art_creativity', music: 'art_creativity',
};

export interface GraphOptions { halfLifeDays?: number; bridgeThreshold?: number; now?: () => number }

export class KnowledgeGraph {
  private cache?: { size: number; at: number; edges: Map<string, Edge>; adj: Map<string, string[]> };
  private bridgesSeen = new Set<string>();
  private bridgeListeners = new Set<(b: Bridge) => void>();
  private readonly halfLife: number;
  private readonly threshold: number;
  private readonly now: () => number;

  constructor(private readonly store: RecordStore, private trust: TrustModel, o: GraphOptions = {}) {
    this.halfLife = o.halfLifeDays ?? 90;
    this.threshold = o.bridgeThreshold ?? 2;
    this.now = o.now ?? Date.now;
    store.onAdd(() => queueMicrotask(() => this.checkBridges()));
  }
  setTrust(t: TrustModel) { this.trust = t; }

  static edgeKey(from: string, type: LinkType, to: string) { return sha256Hex(canonicalBytes([from, type, to])).slice(0, 40); }

  private build() {
    if (this.cache && this.cache.size === this.store.size) return this.cache;
    const edges = new Map<string, Edge>();
    const t = (s: StoredRecord) => Date.parse(s.rec.created);
    const add = (from: string, type: LinkType, to: string, at: number, source: string) => {
      const key = KnowledgeGraph.edgeKey(from, type, to);
      const e = edges.get(key);
      if (e) e.events.push(at); else edges.set(key, { key, from, to, type, created: at, events: [at], source });
    };
    for (const s of this.store.all()) {
      if (s.visibility !== 'public') continue;
      const k = s.rec.kind;
      if (k === 'use' || k === 'memory') continue;
      if (k === 'link') {
        const b = s.rec.body as { from: string; to: string; type: LinkType };
        if (LINK_TYPES.includes(b.type)) add(b.from, b.type, b.to, t(s), s.rec.id);
        continue;
      }
      for (const r of s.rec.refs) {
        const target = this.store.get(r);
        const type: LinkType = k === 'confirmation' ? 'confirms' : k === 'contradiction' ? 'contradicts' : k === 'answer' && target?.rec.kind === 'failure' ? 'fixes' : k === 'summary' ? 'buildsOn' : 'buildsOn';
        add(s.rec.id, type, r, t(s), s.rec.id);
      }
    }
    // Plasticity: use records and building-on strengthen links.
    for (const u of this.store.ofKind('use')) {
      const b = u.rec.body as { edge?: string; target?: string; helpful?: boolean };
      if (b.helpful === false) continue;
      if (b.edge && edges.has(b.edge)) edges.get(b.edge)!.events.push(t(u));
      else if (b.target) for (const e of edges.values()) if (e.to === b.target || e.from === b.target) e.events.push(t(u));
    }
    for (const e of edges.values()) {
      if (e.type === 'confirms' || e.type === 'contradicts') continue;
      for (const c of this.store.referencing(e.from)) if (c.rec.kind === 'confirmation' || (c.rec.kind !== 'contradiction' && c.rec.kind !== 'use')) e.events.push(t(c));
    }
    const adj = new Map<string, string[]>();
    for (const e of edges.values()) for (const n of [e.from, e.to]) { if (!adj.has(n)) adj.set(n, []); adj.get(n)!.push(e.key); }
    this.cache = { size: this.store.size, at: this.now(), edges, adj };
    return this.cache;
  }

  /** Link weight: each event adds strength that decays with its age. Never below zero, never deleted. */
  weight(e: Edge): number {
    const now = this.now();
    let w = 0;
    for (const at of e.events) w += Math.pow(0.5, Math.max(0, now - at) / 86_400_000 / this.halfLife);
    return w;
  }

  edges() { return [...this.build().edges.values()]; }
  edge(key: string) { return this.build().edges.get(key); }

  /**
   * Graph factor for ranking a node: how strongly the network relies on it.
   * Incoming fixes/confirms/buildsOn/inspiredBy/sameAs raise it; contradicts inhibits it.
   */
  nodeFactor(id: string): number {
    const g = this.build();
    let excite = 0, inhibit = 0;
    for (const k of g.adj.get(id) ?? []) {
      const e = g.edges.get(k)!;
      const w = this.weight(e);
      if (e.type === 'contradicts' && e.to === id) inhibit += w * Math.max(0.2, this.trust.weight(this.store.get(e.from) ?? ({} as StoredRecord)) || 0.2);
      else if (e.type !== 'contradicts') excite += w;
    }
    return Math.max(0.05, (1 + Math.log1p(excite)) / (1 + inhibit));
  }

  /** Association recall: the strongest few neighbours of a node, small and ranked. */
  neighbours(id: string, k = 3) {
    const g = this.build();
    return (g.adj.get(id) ?? []).map((key) => g.edges.get(key)!).filter((e) => e.type !== 'confirms')
      .map((e) => {
        const other = e.from === id ? e.to : e.from;
        const s = this.store.get(other);
        return { id: other, link: e.type, direction: e.from === id ? 'out' : 'in', weight: Math.round(this.weight(e) * 100) / 100, kind: s?.rec.kind ?? 'unknown', title: s ? titleOf(s) : '' };
      })
      .filter((n) => !['unknown', 'receipt', 'constitution_check', 'memory'].includes(n.kind)) // knowledge links, not bookkeeping
      .sort((a, b) => b.weight - a.weight).slice(0, k);
  }

  realmOf(id: string, depth = 0): string {
    const s = this.store.get(id);
    if (!s || depth > 6) return 'unknown';
    const b = s.rec.body as { realm?: string };
    if ((s.rec.kind === 'problem' || s.rec.kind === 'proposal') && b.realm) return b.realm;
    for (const d of s.rec.context.domain) if (REALM_OF_DOMAIN[d.toLowerCase()]) return REALM_OF_DOMAIN[d.toLowerCase()];
    for (const r of s.rec.refs) { const x = this.realmOf(r, depth + 1); if (x !== 'unknown') return x; }
    return 'unknown';
  }

  /** Bridges: strong links between different realms, the possible breakthroughs. */
  bridges(): Bridge[] {
    const out: Bridge[] = [];
    for (const e of this.edges()) {
      if (e.type === 'contradicts' || e.type === 'confirms') continue;
      const a = this.realmOf(e.from), b = this.realmOf(e.to);
      if (a === 'unknown' || b === 'unknown' || a === b) continue;
      const w = this.weight(e);
      if (w >= this.threshold) out.push({ edge: e.key, from: e.from, to: e.to, fromRealm: a, toRealm: b, weight: Math.round(w * 100) / 100 });
    }
    return out.sort((x, y) => y.weight - x.weight);
  }

  /** Notified only of bridges that form after the first listener attaches; existing bridges are not re-announced. */
  onBridge(cb: (b: Bridge) => void) {
    if (!this.bridgeListeners.size) for (const b of this.bridges()) this.bridgesSeen.add(b.edge);
    this.bridgeListeners.add(cb);
    return () => this.bridgeListeners.delete(cb);
  }
  checkBridges() {
    if (!this.bridgeListeners.size) return;
    for (const b of this.bridges()) if (!this.bridgesSeen.has(b.edge)) { this.bridgesSeen.add(b.edge); for (const l of this.bridgeListeners) l(b); }
  }

  /** Dense clusters for consolidation: connected components over strong links. */
  clusters(minSize = 4, minWeight = 0.5) {
    const g = this.build();
    const seen = new Set<string>();
    const out: string[][] = [];
    for (const start of g.adj.keys()) {
      if (seen.has(start)) continue;
      const comp: string[] = [];
      const stack = [start];
      seen.add(start);
      while (stack.length) {
        const n = stack.pop()!;
        if (this.store.get(n)?.rec.kind === 'summary') continue;
        comp.push(n);
        for (const k of g.adj.get(n) ?? []) {
          const e = g.edges.get(k)!;
          if (this.weight(e) < minWeight || e.type === 'contradicts') continue;
          const o = e.from === n ? e.to : e.from;
          if (!seen.has(o) && this.store.get(o)) { seen.add(o); stack.push(o); }
        }
      }
      const content = comp.filter((id) => !['confirmation', 'use', 'link'].includes(this.store.get(id)?.rec.kind ?? ''));
      if (content.length >= minSize) out.push(content.sort());
    }
    return out;
  }

  /** JSON-LD view of a node and its links, for interchange. */
  jsonld(id: string) {
    const s = this.store.get(id);
    if (!s) return null;
    const links: Record<string, { '@id': string; weight: number }[]> = {};
    for (const k of this.build().adj.get(id) ?? []) {
      const e = this.build().edges.get(k)!;
      if (e.from !== id) continue;
      (links[e.type] ??= []).push({ '@id': `urn:cst:${e.to}`, weight: Math.round(this.weight(e) * 100) / 100 });
    }
    return { '@context': CONTEXT_URL, id: `urn:cst:${s.rec.id}`, kind: s.rec.kind, created: s.rec.created, author: s.rec.agent_id, realm: this.realmOf(id), body: s.rec.body, ...links };
  }
}

export function titleOf(s: StoredRecord): string {
  const b = s.rec.body as Record<string, unknown>;
  return String(b.title ?? b.headline ?? b.question ?? b.approach ?? b.statement ?? b.name ?? s.rec.context.task).slice(0, 120);
}

export function loadContext(): unknown {
  return JSON.parse(readFileSync(new URL('./context.jsonld', import.meta.url), 'utf8'));
}
