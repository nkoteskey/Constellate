import type { Hub } from '../hub/hub.js';

/**
 * Command usage from tldr-pages (https://github.com/tldr-pages/tldr), licensed CC BY 4.0: one answer record per
 * command, for the commands agents most often hit while building and fixing software. Imported by
 * scripts/import-tldr.mjs into data/seed/tldr-pages.json, pinned to a commit.
 *
 * The licence travels with every record: in the body (license, attribution, source, notice of changes), in the
 * environment line people see, and as the record's evidence link. data/seed/LICENSES holds the licence text.
 * Each record still passes the privacy check before it's signed, like everything else.
 */
export interface TldrPage {
  command: string; platform: string; description: string; examples: { what: string; cmd: string }[];
  license: string; attribution: string; notice: string;
  source: { repo: string; commit: string; path: string; url: string };
}
export interface TldrReport { added: number; skipped: { command: string; reason: string }[] }

export const TLDR_LICENSE = 'CC-BY-4.0';

export async function seedTldr(hub: Hub, file: { pages: TldrPage[] }): Promise<TldrReport> {
  const report: TldrReport = { added: 0, skipped: [] };
  const seen = new Set(hub.node.store.ofKind('answer').flatMap((s) => s.rec.evidence));
  for (const p of file.pages ?? []) {
    if (p.license !== TLDR_LICENSE || p.source?.repo !== 'tldr-pages/tldr' || !/^[0-9a-f]{40}$/.test(p.source.commit)) { report.skipped.push({ command: p.command, reason: 'not tldr-pages under CC BY 4.0 at a pinned commit' }); continue; }
    if (seen.has(p.source.url)) { report.skipped.push({ command: p.command, reason: 'already seeded' }); continue; }
    const answer = [p.description, ...p.examples.map((e) => `${e.what}: ${e.cmd}`)].join('\n').slice(0, 3800);
    try {
      await hub.node.submit({
        kind: 'answer',
        context: { task: `Use ${p.command} from the command line`, domain: ['cli', p.command.toLowerCase().split(' ')[0].slice(0, 48), p.platform].filter((d, i, a) => a.indexOf(d) === i), environment: `tldr-pages (${p.platform}), CC BY 4.0` },
        body: {
          question: `How do I use ${p.command}?`, headline: p.description.split(/(?<=\.)\s/)[0].slice(0, 200), answer,
          proof: { type: 'citation', detail: `tldr-pages, ${p.source.path} at ${p.source.commit.slice(0, 12)} (CC BY 4.0, by the ${p.attribution})` },
          license: p.license, attribution: p.attribution, notice: p.notice, source: p.source.url,
        },
        evidence: [p.source.url],
      }, { publish: true });
      report.added++;
    } catch (e) { report.skipped.push({ command: p.command, reason: (e as Error).message.slice(0, 160) }); }
  }
  return report;
}
