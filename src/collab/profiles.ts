import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { Hub } from '../hub/hub.js';
import { SignedRecord, signRecord, verifyRecord } from '../core/record.js';
import { utf8 } from '../util/bytes.js';
import { REALMS } from '../work/problems.js';

/**
 * Public profiles in an open x0x directory (a self_keyed store, topic constellate.profiles.v1).
 *
 * - This computer's x0x agent publishes its own profile under its agent id.
 * - It also hosts its person's profile under `<agent id>/person`: signed by the person's own key.
 *   Only that agent can write under its id (x0x enforces it), so hosting IS the vouch: readers
 *   check the entry sits under the agent's id and the record verifies.
 * - Every value is a signed Constellate record (kind "profile"); unverifiable entries are dropped.
 * Profiles name people only by a public handle (the personal-data rule) and say what they're open to.
 */
export const PROFILES_TOPIC = 'constellate.profiles.v1';
const HANDLE = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,28}[A-Za-z0-9])?$/;

export interface ProfileBody {
  kind: 'person' | 'agent';
  handle?: string;
  about?: string;
  realms?: string[];
  open_to?: { messages?: boolean; invites?: boolean; reviews?: boolean };
  can?: string[];
  github?: { handle: string; proof: string };
}

export interface Profile extends ProfileBody { id: string; host: string; updated: string; }

/** Shape check for a profile body: what the app, the directory and readers all agree on. */
export function profileProblem(b: Partial<ProfileBody>): string | null {
  if (b.kind !== 'person' && b.kind !== 'agent') return 'a profile is a person or an agent';
  if (b.handle !== undefined && !HANDLE.test(b.handle)) return 'a handle is 1–30 letters, digits, dots, dashes or underscores';
  if (b.about !== undefined && (typeof b.about !== 'string' || b.about.length > 160)) return 'about is one line, up to 160 characters';
  if (b.realms !== undefined && (!Array.isArray(b.realms) || b.realms.some((r) => !(REALMS as readonly string[]).includes(r)))) return 'unknown area';
  if (b.can !== undefined && (!Array.isArray(b.can) || b.can.length > 8 || b.can.some((c) => typeof c !== 'string' || c.length > 60))) return 'up to 8 short skills';
  if (b.github !== undefined && !(HANDLE.test(b.github.handle) && /^https:\/\/gist\.github\.com\/[A-Za-z0-9-]+\/[0-9a-f]{20,40}$/.test(b.github.proof))) return 'bad GitHub link';
  return null;
}

/** A directory entry is genuine when it verifies and sits where only its author (or its host agent) could write it. */
export function verifyEntry(key: string, rec: SignedRecord): Profile | null {
  const v = verifyRecord(rec);
  if (!v.ok || rec.kind !== 'profile') return null;
  const b = rec.body as unknown as ProfileBody;
  if (profileProblem(b)) return null;
  const [host, sub] = key.split('/');
  if (!/^[0-9a-f]{64}$/.test(host)) return null;
  if (!sub && rec.agent_id !== host) return null;                // an agent's own profile, written by itself
  if (sub && (sub !== 'person' || b.kind !== 'person')) return null; // a person hosted by their computer's agent
  return { ...b, id: rec.agent_id, host, updated: rec.created };
}

export class Profiles {
  private cache: { at: number; list: Profile[] } | null = null;
  private joined = false;
  private readonly localFile: string;

  constructor(private readonly hub: Hub, home = process.env.CONSTELLATE_HOME ?? join(homedir(), '.constellate')) {
    this.localFile = join(home, 'profiles.json');
  }

  get networked() { return !!this.hub.x0x; }

  private async dir() {
    const x = this.hub.x0x;
    if (!x) return null;
    if (!this.joined) { await x.joinDirectory(PROFILES_TOPIC); this.joined = true; }
    return x;
  }

  /** Profiles saved on this computer (always), so the app shows its own even without x0x. */
  private local(): Record<string, SignedRecord> { try { return JSON.parse(readFileSync(this.localFile, 'utf8')); } catch { return {}; } }
  private saveLocal(key: string, rec: SignedRecord) {
    const all = this.local(); all[key] = rec;
    mkdirSync(dirname(this.localFile), { recursive: true });
    writeFileSync(this.localFile, JSON.stringify(all));
  }

  private async put(key: string, rec: SignedRecord): Promise<'x0x' | 'local'> {
    this.saveLocal(key, rec);
    this.cache = null;
    const x = await this.dir().catch(() => null);
    if (!x) return 'local';
    await x.directoryPut(PROFILES_TOPIC, key, utf8(JSON.stringify(rec)));
    return 'x0x';
  }

  /** What this computer's agent last said about itself (its name, if the person gave it one). */
  ownAgent(): ProfileBody | null {
    const rec = this.local()[this.hub.node.agentId];
    return rec ? (rec.body as unknown as ProfileBody) : null;
  }

  /** This computer's agent describes itself. Keeps what it said before (its name) unless told otherwise. */
  async publishAgent(body: Omit<ProfileBody, 'kind'> = {}) {
    const prev = this.ownAgent() ?? {};
    const b: ProfileBody = { about: 'Constellate on a person’s computer', ...prev, ...body, kind: 'agent' };
    if (b.handle === '') delete b.handle; // cleared
    const problem = profileProblem(b);
    if (problem) throw new Error(problem);
    const rec = await signRecord({ kind: 'profile', context: { task: 'profile', domain: ['people'], environment: '' }, body: b as unknown as Record<string, unknown> }, this.hub.node.signer);
    return this.put(this.hub.node.agentId, rec);
  }

  /** The person using this computer publishes their profile (signed in their browser); this agent hosts it. */
  async publishPerson(rec: SignedRecord) {
    const key = `${this.hub.node.agentId}/person`;
    if (!verifyEntry(key, rec)) throw new Error('that profile doesn’t verify');
    return this.put(key, rec);
  }

  /** Every genuine profile this node can see: the directory, plus this computer's own. Cached for 30 s. */
  async list(): Promise<Profile[]> {
    if (this.cache && Date.now() - this.cache.at < 30_000) return this.cache.list;
    const byKey = new Map<string, Profile>();
    for (const [key, rec] of Object.entries(this.local())) { const p = verifyEntry(key, rec); if (p) byKey.set(key, p); }
    const x = await this.dir().catch(() => null);
    if (x) {
      const keys = (await x.directoryKeys(PROFILES_TOPIC).catch(() => [] as string[])).filter((k) => /^[0-9a-f]{64}(\/person)?$/.test(k)).slice(0, 500);
      await Promise.all(keys.map(async (key) => {
        try {
          const bytes = await x.directoryGet(PROFILES_TOPIC, key);
          if (!bytes || bytes.length > 64 * 1024) return;
          const p = verifyEntry(key, JSON.parse(new TextDecoder().decode(bytes)) as SignedRecord);
          if (p && (!byKey.has(key) || byKey.get(key)!.updated < p.updated)) byKey.set(key, p);
        } catch { /* skip an unreadable entry */ }
      }));
    }
    const list = [...byKey.values()].sort((a, b) => b.updated.localeCompare(a.updated));
    this.cache = { at: Date.now(), list };
    return list;
  }

  /** Agent ids online right now (x0x presence), empty without x0x. */
  async online(): Promise<Set<string>> {
    const x = this.hub.x0x;
    if (!x) return new Set();
    try { return new Set(await x.presenceOnline()); } catch { return new Set(); }
  }
}
