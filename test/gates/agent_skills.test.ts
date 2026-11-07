import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Hub } from '../../src/hub/hub.js';
import { LocalSigner } from '../../src/core/identity.js';
import { RecordStore } from '../../src/store/records.js';
import { MockRunner } from '../../src/contributor/models.js';
import { seedAgentSkills, ImportedSkill, SKILL_SOURCES } from '../../src/seed/agent-skills.js';
import { scrub } from '../../src/privacy/scrub.js';

/**
 * Public agent skills (docs/AGENT_SKILLS.md): only openly licensed skills, each credited to its source at a pinned
 * commit, with a notice of what changed and the licence texts shipped; nothing that fails the privacy check; and
 * honest about having no tests yet.
 */
const SEED = join(import.meta.dirname, '../../data/seed');
const file = JSON.parse(readFileSync(join(SEED, 'agent-skills.json'), 'utf8')) as { skills: ImportedSkill[] };

describe('public agent skills', () => {
  it('the data file: open licences only, credited and pinned, privacy-clean, with the licence texts alongside', () => {
    expect(file.skills.length).toBeGreaterThanOrEqual(50);
    for (const k of file.skills) {
      expect(['Apache-2.0', 'MIT', 'MIT OR Apache-2.0'], k.name).toContain(k.license);
      expect(SKILL_SOURCES, k.name).toContain(k.source.repo);
      expect(k.source.url, k.name).toMatch(/^https:\/\/github\.com\/[^/]+\/[^/]+\/(tree|blob)\/([0-9a-f]{40}|v\d+\.\d+\.\d+)\//);
      expect(k.notice, k.name).toMatch(/Changed by Constellate/);
      expect(scrub(k, { level: 'standard' }).ok, k.name).toBe(true);
    }
    for (const f of ['Apache-2.0.txt', 'MIT-x0x.txt', 'MIT-ant-sdk.txt', 'MIT-notion-skills.txt', 'MIT-vercel-deploy.txt', 'NOTICE.md']) expect(existsSync(join(SEED, 'LICENSES', f)), f).toBe(true);
    expect(file.skills.map((k) => k.source.repo)).toEqual(expect.arrayContaining(['saorsa-labs/x0x', 'WithAutonomi/ant-sdk', 'anthropics/skills', 'huggingface/skills', 'openai/skills']));
  });

  it('seeds them findable and credited, labels them untested, and never twice', async () => {
    const hub = new Hub({ signer: LocalSigner.generate(), store: new RecordStore(), preview: false });
    const r = await seedAgentSkills(hub, file);
    expect(r.added).toBe(file.skills.length);
    expect((await seedAgentSkills(hub, file)).added).toBe(0);
    const [x0x] = hub.skills.find('x0x gossip direct messaging between agents', 3).filter((k) => k.name === 'x0x');
    expect(x0x).toMatchObject({ tests: 0, credit: 'Saorsa Labs (saorsa-labs/x0x), MIT OR Apache-2.0' });
    expect(hub.skills.find('autonomi pointers antd', 3)[0].name).toMatch(/Autonomi/);
    const rec = hub.node.store.get(x0x.id)!.rec;
    expect(rec.context.environment).toMatch(/no tests yet/);
    expect(JSON.stringify(rec.body)).not.toMatch(/@saorsalabs|author:/);
    await expect(hub.skills.trial(x0x.id, new MockRunner('m', 'mock', 'small', () => 'x'))).rejects.toThrow(/no test cases yet/);
  });

  it('a skill an agent publishes still needs tests; only imported ones, with a source, may have none', async () => {
    const hub = new Hub({ signer: LocalSigner.generate(), store: new RecordStore(), preview: false });
    await expect(hub.skills.publish({ name: 'n', description: 'd', capabilities: [], price: 0, instructions: 'i', tests: [], verifier: 'exact' })).rejects.toThrow(/at least one test case/);
  });
});
