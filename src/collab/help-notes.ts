import type { Hub } from '../hub/hub.js';
import type { StoredRecord } from '../store/records.js';
import type { HelpBody } from './collab.js';

/**
 * Asking for help mid-task (docs/AGENT_STEPS.md "Help requests"). An agent stuck on something posts a
 * help_request with a machine check for the answer. Connected agents elsewhere whose skills match see it once,
 * in their next Constellate reply (the way person_asked notes work, src/work/work-requests.ts), and can answer
 * with answers_submit. The asker's computer checks each answer with the request's verifier before accepting it.
 *
 * Skills are what an agent has shown, not what it claims: the topics of records its operator shared, plus the
 * topics it is searching in this session.
 */
const WEEK = 7 * 86_400_000;
const norm = (d: string) => d.trim().toLowerCase();

/** The topics this computer's agent has shown it knows: its operator's shared lessons and answers. */
export function shownSkills(hub: Hub): Set<string> {
  const out = new Set<string>();
  for (const s of hub.node.store.all()) {
    if (s.operatorId !== hub.node.operatorId || !['failure', 'answer', 'confirmation', 'skill', 'task_result'].includes(s.rec.kind)) continue;
    for (const d of s.rec.context.domain) out.add(norm(d));
  }
  return out;
}

/** Still open: no answer of it has been accepted (confirmed by the asker), and it's less than a week old. */
export function openHelp(hub: Hub, now = Date.now()): StoredRecord[] {
  return hub.node.store.ofKind('help_request').filter((r) => now - Date.parse(r.rec.created) < WEEK
    && !hub.node.store.referencing(r.rec.id, 'answer').some((a) => hub.node.store.referencing(a.rec.id, 'confirmation').some((c) => c.operatorId === r.operatorId)));
}

/** The best open request from someone else that matches these skills and hasn't been shown yet. */
export function helpFor(hub: Hub, skills: Set<string>, shown: Set<string>): StoredRecord | null {
  let best: { r: StoredRecord; n: number } | null = null;
  for (const r of openHelp(hub)) {
    if (r.operatorId === hub.node.operatorId || shown.has(r.rec.id)) continue;
    const n = r.rec.context.domain.filter((d) => skills.has(norm(d))).length;
    if (n && (!best || n > best.n || (n === best.n && r.rec.created > best.r.rec.created))) best = { r, n };
  }
  return best?.r ?? null;
}

/** What the agent is told, in its next reply. */
export function helpNote(r: StoredRecord) {
  const b = r.rec.body as unknown as HelpBody;
  return {
    request: r.rec.id,
    question: b.question,
    topics: r.rec.context.domain,
    checked_by: `${b.verifier} (by machine): only an answer that passes it counts`,
    ...(b.bounty ? { bounty: b.bounty } : {}),
    how: `Another agent is stuck on this and your record shows you know these topics. If you can answer it without derailing your own task, call answers_submit with the answer and fixes: ["${r.rec.id}"]. Otherwise ignore it; you won't be asked again.`,
  };
}

/**
 * On the asker's computer: when an answer to one of its own help requests arrives, check it with the request's
 * verifier straight away (src/collab/collab.ts acceptHelp). Returns a function that stops watching.
 */
export function watchHelpAnswers(hub: Hub, allowed: () => Promise<boolean> | boolean = () => true) {
  const busy = new Set<string>(), again = new Set<string>();
  const check = (ref: string) => {
    if (busy.has(ref)) { again.add(ref); return; } // an answer arrived mid-check: check again after
    busy.add(ref);
    setTimeout(() => void Promise.resolve(allowed()).then((ok) => (ok ? hub.collab.acceptHelp(ref, hub.board) : null)).catch(() => null)
      .finally(() => { busy.delete(ref); if (again.delete(ref)) check(ref); }), 50);
  };
  return hub.node.store.onAdd((s) => {
    if (s.rec.kind !== 'answer') return;
    for (const ref of s.rec.refs) {
      const req = hub.node.store.get(ref);
      if (req?.rec.kind === 'help_request' && req.operatorId === hub.node.operatorId) check(ref);
    }
  });
}
