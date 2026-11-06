import { Hub } from '../hub/hub.js';
import { ModelRunner } from '../contributor/models.js';
import { bm25 } from '../services/search.js';
import { Deliberation } from '../collective/deliberation.js';

/**
 * Plain-language guide: "What's happening with the ageing compounds?" gets a
 * short summary, so nobody needs to read raw records. With a model attached it
 * writes the summary from the facts; without one it uses a template, so it
 * always works and never invents anything.
 */
export class Guide {
  constructor(private readonly hub: Hub, private readonly runner?: ModelRunner) {}

  async facts(question: string) {
    const problems = this.hub.problems.list();
    const delib = new Deliberation(this.hub).questions();
    const docs = [
      ...problems.map((p) => { const b = p.rec.body as { title: string; hook: string; goal: string; realm: string }; return { id: p.rec.id, text: `${b.title} ${b.hook} ${b.goal} ${b.realm}`, tags: [] }; }),
      ...delib.map((q) => { const b = q.rec.body as { question: string; hook: string }; return { id: q.rec.id, text: `${b.question} ${b.hook}`, tags: [] }; }),
    ];
    const scores = bm25(question, docs);
    const best = [...scores.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (!best) return null;
    if (this.hub.problems.get(best)) return { type: 'problem' as const, ...(await this.hub.problems.summary(best)) };
    return { type: 'deliberation' as const, ...new Deliberation(this.hub).map(best) };
  }

  async ask(question: string): Promise<{ answer: string; about: string | null; kind?: 'problem' | 'deliberation' }> {
    if (/how do i|how can i|what can i do|help/i.test(question) && !/happening|progress/i.test(question)) {
      return { about: null, answer: 'Pick any problem on the map and press "Help with this". You can rate an argument, confirm a result in your field, donate idle compute, or connect your own agent. Each takes one tap, and no account is needed until you contribute.' };
    }
    const f = await this.facts(question);
    if (!f) return { about: null, answer: "I couldn't find a problem or debate about that yet. You could propose it from the Proposals view." };
    if (this.runner) {
      const answer = await this.runner.run(`Answer the person's question in 2-4 plain sentences using ONLY these facts. No jargon.\nQuestion: ${question}\nFacts: ${JSON.stringify(f).slice(0, 6000)}`, { maxTokens: 400 });
      return { about: f.id, kind: f.type, answer };
    }
    if (f.type === 'problem') {
      const last = f.checkpoints.at(-1);
      return {
        about: f.id, kind: 'problem',
        answer: `${f.title}: ${f.progress.done} of ${f.progress.total} steps are verified${last ? `, most recently ${timeAgo(last.at)}` : ''}. ${f.contributors} contributors so far. ${f.open_calls.length ? `${f.open_calls.length} steps are still open${f.open_calls.some((c) => c.waiting_for.startsWith('verification')) ? ', some just waiting for a second check' : ''}.` : 'It is complete.'} Done means: ${f.definition_of_done.description.toLowerCase()}.`,
      };
    }
    const top = f.positions[0];
    return { about: f.id, kind: 'deliberation', answer: `"${f.question}" has ${f.positions.length} positions from ${f.model_families.length} model families (${f.agreement}).${top ? ` One says: "${top.statement}"` : ''}${f.shared_cruxes.length ? ` They share a crux: ${f.shared_cruxes[0].crux}.` : ''}` };
  }

  /** Short digest of breakthroughs and calls for help on followed problems, meant to be forwarded. */
  async digest(follow: string[], sinceDays = 7) {
    const since = Date.now() - sinceDays * 86_400_000;
    const items = [];
    for (const id of follow) {
      if (!this.hub.problems.get(id)) continue;
      const s = await this.hub.problems.summary(id);
      const fresh = s.checkpoints.filter((c) => Date.parse(c.at) >= since).length;
      items.push({ id, title: s.title, new_checkpoints: fresh, progress: s.progress, open_calls: s.open_calls.length });
    }
    const lines = items.map((i) => `• ${i.title}: ${i.new_checkpoints ? `${i.new_checkpoints} new verified step${i.new_checkpoints > 1 ? 's' : ''}` : 'no new steps'} (${i.progress.done}/${i.progress.total}).${i.open_calls ? ` ${i.open_calls} open calls for help.` : ''}`);
    return { items, text: lines.length ? `This week on Constellate\n${lines.join('\n')}` : 'Follow a problem to get a digest.' };
  }
}

function timeAgo(iso: string) {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
}
