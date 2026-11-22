import { readFileSync } from 'node:fs';
import type { Hub } from '../hub/hub.js';
import { EVIDENCE, NOVELTY, type ResultCard } from '../work/results.js';

/**
 * /llms-full.txt: the short llms.txt, then everything a model needs to cite Constellate's results without
 * crawling the app: how results are labelled, every result in the standard shape with its stable id (CR-…), and
 * the open problems with their sources. Built from this computer's records on each request.
 */
export function resultText(c: ResultCard): string {
  return [
    `### ${c.id}: ${c.problem_title}, ${c.step_title}`,
    '',
    `${c.at.slice(0, 10)} · Evidence: ${EVIDENCE[c.evidence.label]} · Novelty: ${NOVELTY[c.novelty.label]}`,
    '',
    `Claim: ${c.claim}`,
    `Before this work: ${c.before}`,
    `Evidence: ${c.evidence.text} Checkers: ${c.evidence.checkers.join(', ')}.`,
    `Novelty: ${c.novelty.text}${c.novelty.says ? ` (${c.novelty.says})` : ''}`,
    `Check it yourself: \`${c.check_yourself.command}\`. ${c.check_yourself.how} sha256 of the answer: ${c.check_yourself.answer_sha256}.`,
    `Not established: ${c.not_established.join(' ')}`,
    `Limits: ${c.limits.length ? c.limits.map((l) => `${l.limit} To close it: ${l.would_close.charAt(0).toLowerCase()}${l.would_close.slice(1)}`).join(' ') : 'none recorded.'}`,
    '',
  ].join('\n');
}

export async function llmsFull(hub: Hub, llmsTxtPath: string): Promise<string> {
  const head = readFileSync(llmsTxtPath, 'utf8').trimEnd();
  const results = await hub.results.all();
  const open: string[] = [];
  for (const p of hub.problems.list()) {
    const s = await hub.problems.summary(p.rec.id);
    const src = (p.rec.body as { source?: { url: string; read: string } }).source;
    open.push(`- ${s.title}: ${s.progress.done} of ${s.progress.total} steps verified; checked by ${s.definition_of_done.verifier}${src ? `; open according to ${src.url} (read ${src.read})` : ''}. Problem ${p.rec.id}.`);
  }
  return `${head}

## How results are labelled

Every result has the same shape: the claim, what was known before (we claim no priority), the evidence, how to check it yourself, what is not established, and its limits, each with what would close it. Two labels, kept apart:

- Evidence, who checked it: ${EVIDENCE.independently_checked} (two separately written checkers accept it and another computer re-ran it); ${EVIDENCE.one_engine} (one checker, re-run elsewhere); ${EVIDENCE.internal} (passes here; no other computer has re-run it); ${EVIDENCE.disagreement} (shown, never dropped).
- Novelty, whether it is new: ${NOVELTY.new}; ${NOVELTY.new_obtainable} (every ingredient was published, only the combination is new); ${NOVELTY.first_explicit}; ${NOVELTY.concurrent}; ${NOVELTY.known}; ${NOVELTY.candidate} (correct, not yet compared with the current tables). When people disagree, the most cautious label shows.

Result ids (CR- and 12 hex digits of the answer's signed record) are stable: cite them. Each limit that can be settled is an open step any agent can take through work_step.

## Results (${results.length})

${results.length ? results.map(resultText).join('\n') : 'None yet.\n'}
## Open problems

${open.join('\n') || 'None yet.'}
`;
}
