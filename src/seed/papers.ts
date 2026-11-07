import type { Hub } from '../hub/hub.js';
import { redactPersonal } from '../privacy/redact.js';
import { PrivacyBlockedError } from '../privacy/scrub.js';

/**
 * Lessons from published research papers (docs/RESEARCH_AGENTS.md). The first corpus is ScientistTwo, Google
 * Cloud AI Research's autonomous research system: 86 AI-generated papers, each reporting what worked and,
 * unusually often, what didn't. Negative results become failures ("tried X, it didn't help"); the main
 * findings become answers. Every record links the paper, says it's AI-generated and self-reported, and is
 * labelled "not independently reproduced" until someone confirms it.
 *
 * Only public papers from the allowed sources are seeded, people are never named (authors or citations), and
 * the usual privacy checks run on every record.
 */
export const PAPER_SOURCES: { prefix: string; name: string; environment: string }[] = [
  { prefix: 'https://scientist-two.github.io/generated-papers/', name: 'ScientistTwo', environment: 'ScientistTwo (Google Cloud AI Research): AI-generated paper, self-reported, not independently reproduced' },
];

export interface PaperLesson {
  kind: 'failure' | 'answer';
  approach?: string; outcome?: 'wrong_result' | 'too_slow' | 'too_costly' | 'error'; error_summary?: string; applies_when?: string;
  question?: string; answer?: string;
}
export interface PaperLessons { paper: string; title: string; url: string; tags: string[]; summary: string; lessons: PaperLesson[] }
export interface PaperSeedReport { papers: number; failures: number; answers: number; skipped: { paper: string; reason: string }[] }

const clip = (s: string | undefined, n: number) => redactPersonal(String(s ?? '').replace(/\s+/g, ' ').trim()).slice(0, n);
const firstSentence = (s: string) => (s.match(/^.*?[.!?](\s|$)/)?.[0] ?? s).trim();
const tag = (t: string) => t.toLowerCase().replace(/[^a-z0-9.+-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

export class PaperSeeder {
  constructor(private readonly hub: Hub) {}

  async seed(papers: PaperLessons[]): Promise<PaperSeedReport> {
    const report: PaperSeedReport = { papers: 0, failures: 0, answers: 0, skipped: [] };
    const seen = new Set(this.hub.node.store.all().flatMap((s) => s.rec.evidence));
    for (const p of papers) {
      const src = PAPER_SOURCES.find((s) => p.url.startsWith(s.prefix));
      if (!src) { report.skipped.push({ paper: p.paper, reason: 'not from an allowed source' }); continue; }
      if (seen.has(p.url)) { report.skipped.push({ paper: p.paper, reason: 'already seeded' }); continue; }
      const domain = [...new Set(['research', ...p.tags.map(tag).filter(Boolean)])].slice(0, 8);
      const task = clip(`${src.name}: ${p.title}`, 300);
      const failures: string[] = [];
      for (const l of p.lessons.filter((x) => x.kind === 'failure' && x.approach && x.error_summary)) {
        try {
          const { record } = await this.hub.node.submit({
            kind: 'failure',
            context: { task, domain, environment: src.environment },
            body: { approach: clip(l.approach, 600), outcome: l.outcome ?? 'wrong_result', error_summary: clip(l.error_summary, 600), ...(l.applies_when ? { applies_when: clip(l.applies_when, 300) } : {}), confidence: 0.5 },
            evidence: [p.url],
          }, { publish: true });
          failures.push(record.id); report.failures++;
        } catch (e) { report.skipped.push({ paper: p.paper, reason: e instanceof PrivacyBlockedError ? `privacy: ${e.findings.map((f) => f.type).join(', ')}` : (e as Error).message }); }
      }
      for (const l of p.lessons.filter((x) => x.kind === 'answer' && x.question && x.answer)) {
        const answer = clip(l.answer, 900);
        try {
          await this.hub.node.submit({
            kind: 'answer',
            context: { task, domain, environment: src.environment },
            body: { question: clip(l.question, 300), answer, headline: firstSentence(answer).slice(0, 220), proof: { type: 'citation', detail: `reported in an AI-generated paper (${src.name}); not independently reproduced` } },
            evidence: [p.url],
            refs: failures, // the variants that didn't work, next to the one that did
          }, { publish: true });
          report.answers++;
        } catch (e) { report.skipped.push({ paper: p.paper, reason: e instanceof PrivacyBlockedError ? `privacy: ${e.findings.map((f) => f.type).join(', ')}` : (e as Error).message }); }
      }
      report.papers++;
    }
    return report;
  }
}
