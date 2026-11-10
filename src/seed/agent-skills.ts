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
export const SKILL_SOURCES = ['anthropics/skills', 'huggingface/skills', 'openai/skills', 'saorsa-labs/x0x', 'WithAutonomi/ant-sdk', 'wrencanfly/research-loop-skills'];

export interface ImportedSkill {
  name: string; description: string; capabilities: string[]; instructions: string; license: string; notice: string;
  source: { org: string; repo: string; path: string; commit: string; url: string };
}
export interface SkillSeedReport { added: number; skipped: { name: string; reason: string }[] }

/** Test cases Constellate wrote for imported skills (data/seed/skill-tests.json), keyed by "repository:path". */
export interface SkillTestsFile { tests: Record<string, { input: string; check: Record<string, unknown>; from?: string }[]> }

export async function seedAgentSkills(hub: Hub, file: { skills: ImportedSkill[] }, testsFile?: SkillTestsFile): Promise<SkillSeedReport> {
  const report: SkillSeedReport = { added: 0, skipped: [] };
  const seen = new Set(hub.node.store.ofKind('skill').flatMap((s) => s.rec.evidence));
  for (const k of file.skills ?? []) {
    if (!SKILL_SOURCES.includes(k.source?.repo)) { report.skipped.push({ name: k.name, reason: 'not from an allowed source' }); continue; }
    if (seen.has(k.source.url)) { report.skipped.push({ name: k.name, reason: 'already seeded' }); continue; }
    try {
      // Tests we wrote travel with the skill, and its notice says so: they are Constellate's, not the source's.
      const tests = (testsFile?.tests[`${k.source.repo}:${k.source.path}`] ?? []).map(({ input, check }) => ({ input, check }));
      const notice = tests.length ? `${k.notice} Test cases written by Constellate from the skill's own text (data/seed/skill-tests.json).`.slice(0, 800) : k.notice;
      const card = SkillCard.parse({ ...k, notice, price: 0, tests, verifier: 'exact' });
      await hub.node.submit({ kind: 'skill', context: { task: k.description, domain: k.capabilities, environment: `imported from ${k.source.org} (${k.source.repo}), ${k.license}; ${tests.length ? `${tests.length} test cases written by Constellate` : 'no tests yet'}` }, body: card, evidence: [k.source.url] }, { publish: true });
      report.added++;
    } catch (e) { report.skipped.push({ name: k.name, reason: (e as Error).message.slice(0, 160) }); }
  }
  return report;
}

/** x0x's wrapped skills (data/seed/x0x-skills.json): short how-tos from x0x's public SKILL.md, each with its own test case. */
export interface WrappedSkillFile {
  source: string; version?: string; licence: string;
  skills: { name: string; description: string; capabilities: string[]; instructions: string; tests: { input: string; check: Record<string, unknown> }[] }[];
}

/**
 * Seeds x0x's wrapped skills, credited to x0x's skill file under its licence. Unlike the imported skills these
 * carry test cases, so they can be trialled. Returns the ids of the skills it added (none on a second run).
 */
export async function seedX0xSkills(hub: Hub, file: WrappedSkillFile): Promise<string[]> {
  const have = new Set(hub.node.store.ofKind('skill').filter((s) => s.rec.evidence.includes(file.source)).map((s) => (s.rec.body as { name: string }).name));
  const ids: string[] = [];
  for (const k of file.skills ?? []) {
    if (have.has(k.name)) continue;
    const card = SkillCard.parse({ ...k, price: 0, verifier: 'exact', license: file.licence });
    const { record } = await hub.node.submit({ kind: 'skill', context: { task: k.description, domain: k.capabilities, environment: `x0x skill file${file.version ? ` ${file.version}` : ''}, ${file.licence}` }, body: card, evidence: [file.source] }, { publish: true });
    ids.push(record.id);
  }
  return ids;
}

/**
 * Constellate's own skill (distribution/SKILL.md, the one on ClawHub), as a card on the Skills page, so agents
 * browsing skills find it. Signed like any seeded skill, so it is not "Official" (src/economy/official.ts), and it
 * isn't pinned above the others. Its tests come from its own text. Returns the record id, or null if seeded already.
 */
export async function seedConstellateSkill(hub: Hub, markdown: string, version: string): Promise<string | null> {
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(markdown);
  const field = (k: string) => new RegExp(`^${k}:\\s*(.*)$`, 'm').exec(fm?.[1] ?? '')?.[1].trim().replace(/^["']|["']$/g, '') ?? '';
  const tag = `v${version}`;
  const url = `https://github.com/nkoteskey/Constellate/blob/${tag}/distribution/SKILL.md`;
  if (hub.node.store.ofKind('skill').some((s) => s.rec.evidence.includes(url))) return null;
  const card = SkillCard.parse({
    name: 'Constellate', description: field('description').slice(0, 400), capabilities: ['constellate', 'failures', 'answers', 'mcp', 'agent-skill'],
    instructions: markdown.slice(fm ? fm[0].length : 0).trim(), price: 0, verifier: 'exact', license: 'MIT OR Apache-2.0',
    tests: [
      { input: 'You just hit an error. Which Constellate tool do you call first, with the error message? Answer with the tool name only, as the last word.', check: { expected: 'failures_search' } },
      { input: 'You tried a fix you found on Constellate. Which tool reports whether it worked? Answer with the tool name only, as the last word.', check: { expected: 'fix_tried' } },
    ],
    source: { org: 'Constellate', repo: 'nkoteskey/Constellate', path: 'distribution/SKILL.md', commit: tag, url },
    notice: `Constellate's own skill (distribution/SKILL.md, version ${version}), under MIT OR Apache-2.0. Test cases written from its text.`,
  });
  const { record } = await hub.node.submit({ kind: 'skill', context: { task: card.description, domain: card.capabilities, environment: `Constellate ${version}, 2 test cases` }, body: card, evidence: [url] }, { publish: true });
  return record.id;
}
