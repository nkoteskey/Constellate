import { Hub } from '../hub/hub.js';

/**
 * Building on x0x: every problem gets a public x0x Space (a public_open named
 * group), so people on the plain x0x GUI can join its conversation, and the
 * app's problem chat reads from and posts to it. Presence marks who is online.
 * Shapes follow x0x's docs (docs/skill/messaging.md §4.1, §4.3); tested against
 * a stand-in daemon, not yet against a real one.
 */
export class ProblemSpaces {
  private ids = new Map<string, string>();
  private online: { at: number; ids: Set<string> } = { at: 0, ids: new Set() };
  constructor(private readonly hub: Hub) {}

  get available() { return !!this.hub.x0x; }

  /** The Space for a problem, created on first use. */
  async spaceFor(problemId: string): Promise<string | null> {
    if (!this.hub.x0x) return null;
    const known = this.ids.get(problemId);
    if (known) return known;
    const id = await this.hub.x0x.createSpace(`constellate-${problemId.slice(0, 16)}`, 'public_open').catch(() => '');
    if (id) this.ids.set(problemId, id);
    return id || null;
  }

  /** Mirror a chat line into the problem's Space (best effort: the signed record is the source of truth). */
  async post(problemId: string, text: string) {
    const id = await this.spaceFor(problemId);
    if (id) await this.hub.x0x!.spaceSend(id, text.slice(0, 2000)).catch(() => {});
  }

  /** Messages posted in the Space from outside the app (e.g. the x0x GUI). */
  async outside(problemId: string, known: Set<string>) {
    const id = await this.spaceFor(problemId);
    if (!id) return [];
    const ms = await this.hub.x0x!.spaceMessages(id).catch(() => []);
    return ms.filter((m) => !known.has(m.body) && m.from !== this.hub.node.agentId).map((m) => ({ id: `x0x:${m.id}`, from: m.from, operator: m.from, human: true, text: m.body, at: m.at, via: 'x0x' }));
  }

  /** Who is online right now, cached for 30 s. */
  async onlineIds(): Promise<Set<string>> {
    if (!this.hub.x0x) return new Set();
    if (Date.now() - this.online.at > 30_000) this.online = { at: Date.now(), ids: new Set(await this.hub.x0x.presenceOnline().catch(() => [])) };
    return this.online.ids;
  }

  async invite(problemId: string) { const id = await this.spaceFor(problemId); return id ? this.hub.x0x!.spaceInvite(id).catch(() => null) : null; }
}
