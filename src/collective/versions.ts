import type { Hub } from '../hub/hub.js';
import type { StoredRecord } from '../store/records.js';

/**
 * Revise and fork ideas, so people improve a question instead of posting it again (docs/VERSIONS.md).
 *
 * Records are signed and permanent, so nothing is edited in place. Instead:
 * - **Revise:** a new idea record with `revises: <earlier version>`. The idea's author's own revisions become the
 *   current version. Anyone else's revision is a suggested change, which the author can adopt (`adopts`), and
 *   whoever suggested it is credited.
 * - **Ask it differently (fork):** a new idea with `forked_from: <an idea or a live problem>`. It has its own votes
 *   and its own history, and both sides link to each other, so people and agents see every framing.
 *
 * Votes on any version of an idea count for the idea (each person's latest vote across its versions).
 * Credit for the question: an idea's page names who framed it, whose changes were adopted, and which framings grew
 * from it; a person's profile counts the questions others built on (`questionCredit`).
 */
export interface IdeaBody { title: string; goal: string; done: string; realm: string; check?: string; scout?: string; revises?: string; forked_from?: string; adopts?: string; note?: string }

export interface Version { id: string; title: string; by: string; at: string; note: string; status: 'current' | 'earlier' | 'suggested' | 'adopted'; /** A suggested change in full, so its author can adopt it. */ body?: Pick<IdeaBody, 'title' | 'goal' | 'done' | 'realm' | 'check'> }
export interface Framing { id: string; title: string; by: string; at: string; voters: number; kind: 'idea' | 'problem' }
export interface IdeaLine {
  /** The first version's id: the idea's id everywhere (votes, plans, links). */
  id: string;
  /** The version shown. */
  current: string;
  body: IdeaBody;
  framed_by: string;
  /** People whose suggested changes the author adopted. */
  improved_by: string[];
  versions: Version[];
  suggestions: Version[];
  forked_from: { id: string; title: string; kind: 'idea' | 'problem' } | null;
  framings: Framing[];
  voters: string[];
  at: string;
}

const isIdea = (s: StoredRecord | undefined) => !!s && s.rec.kind === 'proposal' && !!(s.rec.body as { title?: string; done?: string }).title && !!(s.rec.body as { done?: string }).done;
const body = (s: StoredRecord) => s.rec.body as unknown as IdeaBody;

export class IdeaVersions {
  constructor(private readonly hub: Hub) {}

  private ideas() { return this.hub.node.store.ofKind('proposal').filter(isIdea); }

  /** The first version of the idea this record belongs to (follows `revises` back). */
  root(id: string): StoredRecord | undefined {
    let s = this.hub.node.store.get(id);
    for (let i = 0; i < 100 && s && body(s).revises; i++) { const up = this.hub.node.store.get(body(s).revises!); if (!isIdea(up)) break; s = up; }
    return isIdea(s) ? s : undefined;
  }

  /** Every idea, one entry per idea (not per version), newest activity first. */
  lines(): IdeaLine[] {
    const all = this.ideas();
    const byRoot = new Map<string, StoredRecord[]>();
    for (const s of all) { const r = this.root(s.rec.id); if (!r) continue; const k = r.rec.id; byRoot.set(k, [...(byRoot.get(k) ?? []), s]); }
    const lines: IdeaLine[] = [];
    for (const [rootId, members] of byRoot) lines.push(this.line(rootId, members, all));
    return lines.sort((a, b) => b.voters.length - a.voters.length || b.at.localeCompare(a.at));
  }

  line(rootId: string, members?: StoredRecord[], all = this.ideas()): IdeaLine {
    const root = this.hub.node.store.get(rootId)!;
    members ??= all.filter((s) => this.root(s.rec.id)?.rec.id === rootId);
    const author = root.operatorId;
    const sorted = [...members].sort((a, b) => a.rec.created.localeCompare(b.rec.created) || a.rec.id.localeCompare(b.rec.id));
    const own = sorted.filter((s) => s.operatorId === author);
    const current = own.at(-1) ?? root;
    const adopted = new Set(own.map((s) => body(s).adopts).filter((x): x is string => !!x));
    const versions: Version[] = own.map((s) => ({ id: s.rec.id, title: body(s).title, by: s.rec.agent_id, at: s.rec.created, note: body(s).note ?? '', status: s === current ? 'current' : 'earlier' }));
    const suggestions: Version[] = sorted.filter((s) => s.operatorId !== author).map((s) => ({ id: s.rec.id, title: body(s).title, by: s.rec.agent_id, at: s.rec.created, note: body(s).note ?? '', status: adopted.has(s.rec.id) ? 'adopted' : 'suggested', body: { title: body(s).title, goal: body(s).goal, done: body(s).done, realm: body(s).realm, check: body(s).check } }));
    const improvedBy = [...new Set(sorted.filter((s) => adopted.has(s.rec.id)).map((s) => s.rec.agent_id))];

    // Votes on any version count for the idea: each person's latest vote across its versions.
    const latest = new Map<string, { at: string; on: boolean }>();
    for (const m of members) for (const v of this.hub.node.store.referencing(m.rec.id, 'vote')) {
      const p = latest.get(v.operatorId);
      if (!p || v.rec.created >= p.at) latest.set(v.operatorId, { at: v.rec.created, on: (v.rec.body as { support?: boolean }).support !== false });
    }
    const voters = [...latest].filter(([, x]) => x.on).map(([op]) => op);

    const from = body(root).forked_from ? this.hub.node.store.get(body(root).forked_from!) : undefined;
    const ids = new Set(members.map((m) => m.rec.id));
    return {
      id: rootId, current: current.rec.id, body: body(current), framed_by: root.rec.agent_id, improved_by: improvedBy, versions, suggestions,
      forked_from: from ? { id: isIdea(from) ? this.root(from.rec.id)!.rec.id : from.rec.id, title: String((from.rec.body as { title?: string }).title ?? ''), kind: from.rec.kind === 'problem' ? 'problem' : 'idea' } : null,
      framings: this.framingsOf(ids, all), voters,
      at: sorted.at(-1)!.rec.created,
    };
  }

  /** Ideas that ask any of these records differently (forks), one per idea. */
  framingsOf(ids: Set<string>, all = this.ideas()): Framing[] {
    const roots = new Map<string, StoredRecord>();
    for (const s of all) if (body(s).forked_from && ids.has(body(s).forked_from!) && !body(s).revises) roots.set(s.rec.id, s);
    return [...roots.values()].map((r) => {
      const l = this.line(r.rec.id, undefined, all);
      return { id: r.rec.id, title: l.body.title, by: r.rec.agent_id, at: r.rec.created, voters: l.voters.length, kind: 'idea' as const };
    });
  }

  /** The idea's current version, for whoever reads it next (the planner, the page). */
  current(id: string): StoredRecord | undefined {
    const r = this.root(id);
    return r ? this.hub.node.store.get(this.line(r.rec.id).current) : undefined;
  }

  /**
   * Why a new idea record can't be accepted, or null. Rules: `revises` and `forked_from` point at the record's
   * first ref; `revises` points at an idea; `forked_from` at an idea or a problem; `adopts` only in the author's
   * own revision, naming someone else's suggested change to the same idea.
   */
  problemWith(b: IdeaBody, refs: string[], operatorId: string): string | null {
    if (b.revises && b.forked_from) return 'an idea revises another or asks it differently, not both';
    if (b.note !== undefined && (typeof b.note !== 'string' || b.note.length > 600)) return 'the note says what changed, in up to 600 characters';
    if (b.revises) {
      if (refs[0] !== b.revises || !isIdea(this.hub.node.store.get(b.revises))) return 'a revision points at an earlier version of an idea';
    }
    if (b.forked_from) {
      const t = this.hub.node.store.get(b.forked_from);
      if (refs[0] !== b.forked_from || !(isIdea(t) || t?.rec.kind === 'problem')) return 'asking it differently points at an idea or a problem';
    }
    if (b.adopts) {
      const root = b.revises ? this.root(b.revises) : undefined;
      const s = this.hub.node.store.get(b.adopts);
      if (!root || root.operatorId !== operatorId) return 'only the idea’s author adopts a suggested change, in their own revision';
      if (!s || !isIdea(s) || this.root(s.rec.id)?.rec.id !== root.rec.id || s.operatorId === operatorId) return 'adopts names someone else’s suggested change to this idea';
    }
    return null;
  }

  /** Questions this person framed that others built on: forks of their ideas and changes of theirs that were adopted. */
  questionCredit(agentId: string) {
    const lines = this.lines();
    const mine = lines.filter((l) => l.framed_by === agentId);
    return {
      framed: mine.length,
      asked_differently_by_others: mine.reduce((n, l) => n + l.framings.filter((f) => f.by !== agentId).length, 0),
      changes_adopted: lines.reduce((n, l) => n + l.suggestions.filter((s) => s.by === agentId && s.status === 'adopted').length, 0),
    };
  }
}
