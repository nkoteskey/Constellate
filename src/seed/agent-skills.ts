import type { Hub } from '../hub/hub.js';
import { SkillCard } from '../economy/skills.js';

/**
 * Openly licensed public agent skills (docs/AGENT_SKILLS.md): SKILL.md files from Anthropic's, Hugging Face's
 * and OpenAI's public skill repositories, plus x0x's and Autonomi's own, imported by scripts/import-skills.mjs
 * into data/seed/agent-skills.json. Only skills under Apache-2.0 or MIT are taken; each record keeps its source
 * (pinned to a commit), its licence and a notice of what was changed, and passes the usual privacy check.
 *
 * They arrive with no test cases (the originals have none), so they're labelled "no tests yet" and can't be
 * trialled until someone adds tests; they can be found and used.
 */
export const SKILL_SOURCES = ['anthropics/skills', 'huggingface/skills', 'openai/skills', 'saorsa-labs/x0x', 'WithAutonomi/ant-sdk'];

export interface ImportedSkill {
  name: string; description: string; capabilities: string[]; instructions: string; license: string; notice: string;
  source: { org: string; repo: string; path: string; commit: string; url: string };
}
export interface SkillSeedReport { added: number; skipped: { name: string; reason: string }[] }

export async function seedAgentSkills(hub: Hub, file: { skills: ImportedSkill[] }): Promise<SkillSeedReport> {
  const report: SkillSeedReport = { added: 0, skipped: [] };
  const seen = new Set(hub.node.store.ofKind('skill').flatMap((s) => s.rec.evidence));
  for (const k of file.skills ?? []) {
    if (!SKILL_SOURCES.includes(k.source?.repo)) { report.skipped.push({ name: k.name, reason: 'not from an allowed source' }); continue; }
    if (seen.has(k.source.url)) { report.skipped.push({ name: k.name, reason: 'already seeded' }); continue; }
    try {
      const card = SkillCard.parse({ ...k, price: 0, tests: [], verifier: 'exact' });
      await hub.node.submit({ kind: 'skill', context: { task: k.description, domain: k.capabilities, environment: `imported from ${k.source.org} (${k.source.repo}), ${k.license}; no tests yet` }, body: card, evidence: [k.source.url] }, { publish: true });
      report.added++;
    } catch (e) { report.skipped.push({ name: k.name, reason: (e as Error).message.slice(0, 160) }); }
  }
  return report;
}
