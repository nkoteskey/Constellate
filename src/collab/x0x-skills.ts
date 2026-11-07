import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import type { Hub } from '../hub/hub.js';
import { SignedRecord, verifyRecord } from '../core/record.js';
import { utf8 } from '../util/bytes.js';
import { bm25 } from '../services/search.js';

/**
 * Skills across x0x (docs/X0X_SKILLS.md). x0x has no network-wide skills registry: an agent's "skills" are what
 * its own agent card lists, its public groups and data stores. So, in x0x's own terms:
 *
 *   Out: this computer writes the skills it authored, as signed records, to the public self-keyed data store
 *        `constellate.skills.v1` (key `<agent_id>/<skill id>`), readable by any x0x agent with plain x0x calls,
 *        and keeps one public "Constellate skills" group, so its daemon's own agent card lists it.
 *   In:  skills other computers put in that store are pulled in, each verified (signature, and the key must
 *        belong to the record's author) before it's stored; public x0x groups that match a search come back as
 *        x0x capabilities, labelled as such (they are groups to join or ask, not Constellate skills).
 */
export const SKILLS_TOPIC = 'constellate.skills.v1';
export const SKILLS_GROUP = 'Constellate skills';
const KEY = /^([0-9a-f]{64})\/([0-9a-f]{16,64})$/;

export interface X0xCapability { kind: 'x0x-group'; id: string; name: string; description: string; tags: string[]; members: number; owner: string | null; how: string }

export class X0xSkills {
  private readonly stateFile: string;
  private joined = false;
  constructor(private readonly hub: Hub, home = process.env.CONSTELLATE_HOME ?? join(homedir(), '.constellate')) {
    this.stateFile = join(home, 'x0x-skills.json');
  }
  private state(): { group?: string; published?: string[] } { try { return JSON.parse(readFileSync(this.stateFile, 'utf8')); } catch { return {}; } }
  private save(s: { group?: string; published?: string[] }) { mkdirSync(dirname(this.stateFile), { recursive: true }); writeFileSync(this.stateFile, JSON.stringify(s)); }

  private async store() {
    const x = this.hub.x0x;
    if (!x) return null;
    if (!this.joined) { await x.joinDirectory(SKILLS_TOPIC); this.joined = true; }
    return x;
  }

  /** Write this computer's own public skills to the shared store (only the new ones). */
  async publishOwn(): Promise<number> {
    const x = await this.store(); if (!x) return 0;
    const st = this.state();
    const done = new Set(st.published ?? []);
    const mine = this.hub.node.store.ofKind('skill').filter((s) => s.rec.agent_id === this.hub.node.agentId && s.visibility === 'public' && !done.has(s.rec.id));
    for (const s of mine) {
      await x.directoryPut(SKILLS_TOPIC, `${this.hub.node.agentId}/${s.rec.id.slice(0, 32)}`, utf8(JSON.stringify(s.rec)));
      done.add(s.rec.id);
    }
    this.save({ ...this.state(), published: [...done] });
    return mine.length;
  }

  /** One public group, so this daemon's agent card lists "Constellate skills" and x0x's group directory finds it. */
  async ensureGroup(): Promise<string | null> {
    const x = this.hub.x0x; if (!x) return null;
    const st = this.state();
    if (st.group) return st.group;
    const id = await x.createSpace(SKILLS_GROUP, 'public_announce', `Skills published by Constellate agents: signed instructions with test cases. Read them from the x0x data store "${SKILLS_TOPIC}" (key <agent_id>/<skill id>), or ask in this group.`);
    if (id) this.save({ ...this.state(), group: id });
    return id || null;
  }

  /** Pull other computers' skills from the store; each is verified before it's kept. */
  async pull(): Promise<{ added: number; refused: number }> {
    const x = await this.store(); if (!x) return { added: 0, refused: 0 };
    let added = 0, refused = 0;
    const keys = (await x.directoryKeys(SKILLS_TOPIC).catch(() => [] as string[])).filter((k) => KEY.test(k) && !k.startsWith(`${this.hub.node.agentId}/`)).slice(0, 2000);
    for (const key of keys) {
      try {
        const bytes = await x.directoryGet(SKILLS_TOPIC, key);
        if (!bytes || bytes.length > 64 * 1024) { refused++; continue; }
        const rec = JSON.parse(new TextDecoder().decode(bytes)) as SignedRecord;
        if (this.hub.node.store.get(rec.id)) continue;
        // The key must belong to the record's author, and the record must verify; then it goes through the usual intake (privacy included).
        const owner = KEY.exec(key)![1];
        if (rec.kind !== 'skill' || rec.agent_id !== owner || !rec.id.startsWith(KEY.exec(key)![2]) || !verifyRecord(rec).ok || !this.hub.node.ingest(rec, `x0x-store:${owner}`)) { refused++; continue; }
        added++;
      } catch { refused++; }
    }
    return { added, refused };
  }

  /** Public x0x groups that match: capabilities to join or ask about, labelled as x0x groups. */
  async capabilities(query: string, limit = 3): Promise<X0xCapability[]> {
    const x = this.hub.x0x; if (!x || !query.trim()) return [];
    const groups = (await x.discoverGroups().catch(() => [])).filter((g) => g.name !== SKILLS_GROUP);
    const rel = bm25(query, groups.map((g) => ({ id: g.id, text: `${g.name} ${g.description} ${g.tags.join(' ')}`, tags: g.tags })));
    return groups.filter((g) => rel.has(g.id)).sort((a, b) => rel.get(b.id)! - rel.get(a.id)!).slice(0, limit).map((g) => ({
      kind: 'x0x-group' as const, id: g.id, name: g.name.slice(0, 120), description: g.description.slice(0, 300), tags: g.tags.slice(0, 8), members: g.members, owner: g.owner ?? null,
      how: 'A public x0x group, not a Constellate skill: ask its owner (or join) to use what it offers.',
    }));
  }

  /** The periodic job: publish ours, keep the group, pull others'. */
  async sync() {
    const published = await this.publishOwn().catch(() => 0);
    const group = await this.ensureGroup().catch(() => null);
    const pulled = await this.pull().catch(() => ({ added: 0, refused: 0 }));
    return { published, group, ...pulled };
  }
}
