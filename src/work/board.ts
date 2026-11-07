import { X0xClient } from '../x0x/client.js';

/** The Board/Swarm: a shared task list where work is posted with capability tags and claimed. Claims are advisory. */
export interface BoardTask { id: string; title: string; tags: Record<string, string>; state: 'open' | 'claimed' | 'done'; claimed_by?: string | null }
export interface Board {
  ensure(title: string, tags: Record<string, string>): Promise<string>;
  list(): Promise<BoardTask[]>;
  claim(id: string, by: string): Promise<void>;
  complete(id: string, by: string): Promise<void>;
}

export class MemoryBoard implements Board {
  private tasks = new Map<string, BoardTask>();
  async ensure(title: string, tags: Record<string, string>) {
    for (const t of this.tasks.values()) if (t.title === title) return t.id;
    const id = `t${this.tasks.size + 1}`;
    this.tasks.set(id, { id, title, tags, state: 'open' });
    return id;
  }
  async list() { return [...this.tasks.values()].map((t) => ({ ...t })); }
  async claim(id: string, by: string) { const t = this.tasks.get(id)!; if (t.state !== 'done') { t.state = 'claimed'; t.claimed_by = by; } }
  async complete(id: string) { this.tasks.get(id)!.state = 'done'; }
}

/** x0x task list keyed by topic: every machine that "creates" the same topic converges on one list. */
export class X0xBoard implements Board {
  private listId?: string;
  constructor(private readonly x0x: X0xClient, private readonly topic: string) {}
  private async id() { return (this.listId ??= await this.x0x.createTaskList('constellate-board', this.topic)); }
  async ensure(title: string, tags: Record<string, string>) {
    const existing = (await this.x0x.tasks(await this.id())).find((t) => t.title === title);
    return existing ? existing.id : this.x0x.addTask(await this.id(), title, JSON.stringify(tags));
  }
  async list(): Promise<BoardTask[]> {
    return (await this.x0x.tasks(await this.id())).map((t) => ({
      id: t.id, title: t.title, tags: safeJson(t.description), claimed_by: t.claimed_by,
      state: /done|complete/i.test(t.state) ? 'done' : /claim/i.test(t.state) ? 'claimed' : 'open',
    }));
  }
  async claim(id: string) { await this.x0x.updateTask(await this.id(), id, 'claim'); }
  async complete(id: string) { await this.x0x.updateTask(await this.id(), id, 'complete'); }
}

function safeJson(s?: string | null): Record<string, string> { try { return s ? JSON.parse(s) : {}; } catch { return {}; } }
