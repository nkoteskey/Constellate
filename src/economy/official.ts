/**
 * "Official", made checkable (docs/OFFICIAL_SKILLS.md). An organisation says which Constellate identities speak
 * for its repository by committing one file to that repository:
 *
 *   .constellate/official.json   { "version": 1, "signers": ["<agent id>", ...] }
 *
 * A skill is official for a repository when its record names that repository as its source AND was signed by
 * one of those identities. Only the key holder can sign the record, and only someone with write access to the
 * repository can commit the file, so neither side can claim it alone. Anyone can re-check it: the file is public.
 *
 * Copies Constellate imported are signed by Constellate's seed identity, so they are never "official"; they stay
 * "from <organisation>", which is what they are.
 */
export const OFFICIAL_FILE = '.constellate/official.json';
const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const ID = /^[0-9a-f]{64}$/;
const TTL = 6 * 3600_000;

export type Fetcher = (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export function officialFileUrl(repo: string) { return `https://raw.githubusercontent.com/${repo}/HEAD/${OFFICIAL_FILE}`; }

/** The file to commit, for this identity. */
export function officialFile(agentIds: string[]) { return JSON.stringify({ version: 1, signers: agentIds }, null, 2) + '\n'; }

/** Parse a repository's file: the signer ids it lists, or none if it's missing or malformed. */
export function parseOfficial(text: string): string[] {
  try {
    const j = JSON.parse(text) as { version?: number; signers?: unknown };
    if (j.version !== 1 || !Array.isArray(j.signers)) return [];
    return j.signers.filter((s): s is string => typeof s === 'string' && ID.test(s)).slice(0, 20);
  } catch { return []; }
}

export class OfficialMarks {
  private cache = new Map<string, { signers: string[]; at: number }>();
  private pending = new Map<string, Promise<void>>();

  constructor(private fetcher: Fetcher | null = typeof fetch === 'function' ? (u) => fetch(u, { signal: AbortSignal.timeout(4000) }) : null) {}

  setFetcher(f: Fetcher | null) { this.fetcher = f; this.cache.clear(); }

  /** From what's already been checked: true, false, or null when this repository hasn't been checked yet. */
  isOfficial(repo: string | undefined, agentId: string): boolean | null {
    if (!repo || !REPO.test(repo)) return false;
    const c = this.cache.get(repo);
    return c ? c.signers.includes(agentId) : null;
  }

  /** Check these repositories' files (each at most every six hours), waiting at most `waitMs` for the answers. */
  async refresh(repos: string[], waitMs = 3000) {
    const now = Date.now();
    const due = [...new Set(repos)].filter((r) => REPO.test(r) && !(now - (this.cache.get(r)?.at ?? 0) < TTL));
    const jobs = due.map((r) => this.pending.get(r) ?? this.check(r));
    if (jobs.length) await Promise.race([Promise.allSettled(jobs), new Promise((res) => setTimeout(res, waitMs).unref?.())]);
  }

  private check(repo: string) {
    const job = (async () => {
      if (!this.fetcher) return;
      try {
        const r = await this.fetcher(officialFileUrl(repo));
        // A missing file is a definite "no"; a network failure leaves it unknown, to try again later.
        if (r.ok) this.cache.set(repo, { signers: parseOfficial(await r.text()), at: Date.now() });
        else if (r.status === 404) this.cache.set(repo, { signers: [], at: Date.now() });
      } catch { /* unknown for now */ }
    })().finally(() => this.pending.delete(repo));
    this.pending.set(repo, job);
    return job;
  }
}
