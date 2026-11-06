/**
 * Read-only view of a repository's PUBLIC trail on GitHub: Actions runs, their
 * failed jobs and steps, commits and issues. Only things anyone can already see.
 * No logs are downloaded, nothing local is read.
 */
export interface RepoInfo { full_name: string; private: boolean; html_url: string; topics?: string[]; language?: string | null }
export interface Run { id: number; name: string; head_branch: string; head_sha: string; conclusion: string | null; status: string; html_url: string; created_at: string; workflow_id: number; event: string; display_title?: string }
export interface Job { name: string; conclusion: string | null; html_url: string; steps?: { name: string; conclusion: string | null }[] }
export interface Commit { sha: string; html_url: string; message: string; files?: { filename: string }[] }
export interface Issue { number: number; title: string; html_url: string; state: string; pull_request?: unknown }

export interface GitHubSource {
  repo(fullName: string): Promise<RepoInfo>;
  runs(fullName: string, opts: { status?: 'failure' | 'success'; branch?: string; perPage?: number }): Promise<Run[]>;
  jobs(fullName: string, runId: number): Promise<Job[]>;
  commit(fullName: string, sha: string): Promise<Commit>;
  issue(fullName: string, n: number): Promise<Issue | null>;
}

/** Unauthenticated (or token-authenticated, for rate limits only) GitHub REST client. */
export class GitHubRest implements GitHubSource {
  constructor(private readonly token = process.env.GITHUB_TOKEN, private readonly base = 'https://api.github.com') {}
  private async get<T>(path: string): Promise<T> {
    const r = await fetch(this.base + path, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'constellate-seeder', ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) } });
    if (!r.ok) throw Object.assign(new Error(`GitHub ${r.status} for ${path}`), { status: r.status });
    return r.json() as Promise<T>;
  }
  repo(f: string) { return this.get<RepoInfo>(`/repos/${f}`); }
  async runs(f: string, o: { status?: string; branch?: string; perPage?: number }) {
    const q = new URLSearchParams({ per_page: String(o.perPage ?? 50), ...(o.status ? { status: o.status } : {}), ...(o.branch ? { branch: o.branch } : {}) });
    return (await this.get<{ workflow_runs: Run[] }>(`/repos/${f}/actions/runs?${q}`)).workflow_runs;
  }
  async jobs(f: string, id: number) { return (await this.get<{ jobs: Job[] }>(`/repos/${f}/actions/runs/${id}/jobs`)).jobs; }
  commit(f: string, sha: string) { return this.get<Commit>(`/repos/${f}/commits/${sha}`); }
  async issue(f: string, n: number) { try { return await this.get<Issue>(`/repos/${f}/issues/${n}`); } catch (e) { if ((e as { status?: number }).status === 404) return null; throw e; } }
}
