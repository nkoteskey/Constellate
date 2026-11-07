import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Hub } from '../../src/hub/hub.js';
import { LocalSigner } from '../../src/core/identity.js';
import { signRecord } from '../../src/core/record.js';
import { FakeMesh, FakeDaemon } from '../../src/x0x/fake.js';
import { X0xClient, DaemonSigner } from '../../src/x0x/client.js';
import { SKILLS_TOPIC, SKILLS_GROUP } from '../../src/collab/x0x-skills.js';
import { utf8 } from '../../src/util/bytes.js';

/**
 * Skills across x0x (docs/X0X_SKILLS.md): Constellate's skills are readable by any x0x agent from a public data
 * store and listed on the daemon's card through a public group; skills other computers put there are pulled in
 * only after they verify; matching public x0x groups come back from a skill search, labelled as groups.
 */
const card = (name: string, caps: string[]) => ({ name, description: `${name}: a tested recipe`, capabilities: caps, price: 0, instructions: `Do ${name} carefully.`, tests: [{ input: 'x', check: { expected: 'x' } }], verifier: 'exact' });

describe('skills across x0x', () => {
  it('publishes to a public x0x store any agent can read, pulls others’ after checking them, and lists one public group', async () => {
    process.env.CONSTELLATE_HOME = mkdtempSync(join(tmpdir(), 'xsk-'));
    try {
      const mesh = new FakeMesh();
      const mk = async (name: string) => { const d = await new FakeDaemon(mesh, name).start(); const x0x = new X0xClient(d.url, d.token); return { hub: new Hub({ signer: await DaemonSigner.connect(x0x), preview: false, x0x }), x0x }; };
      const a = await mk('author'), b = await mk('newcomer');
      const sk = await a.hub.skills.publish(card('lean proof repair', ['lean', 'proofs']));
      const out = await a.hub.x0xSkills.sync();
      expect(out).toMatchObject({ published: 1 });
      expect(out.group).toBeTruthy();
      expect((await a.hub.x0xSkills.sync()).published).toBe(0); // only new ones
      expect(await a.hub.x0xSkills.ensureGroup()).toBe(out.group); // one group, kept

      // Any x0x agent can read it with plain x0x calls: join the store, then list and read.
      await b.x0x.joinDirectory(SKILLS_TOPIC);
      const keys = await b.x0x.directoryKeys(SKILLS_TOPIC);
      expect(keys).toEqual([`${a.hub.node.agentId}/${sk.record.id.slice(0, 32)}`]);
      expect(JSON.parse(new TextDecoder().decode((await b.x0x.directoryGet(SKILLS_TOPIC, keys[0]))!)).body.name).toBe('lean proof repair');
      expect((await b.x0x.discoverGroups()).map((g) => g.name)).toContain(SKILLS_GROUP);

      // A forged entry (someone else's skill under this agent's key) is refused.
      const stranger = await signRecord({ kind: 'skill', context: { task: 'x', domain: ['lean'], environment: '' }, body: card('fake', ['lean']) }, LocalSigner.generate());
      await b.x0x.directoryPut(SKILLS_TOPIC, `${b.hub.node.agentId}/${stranger.id.slice(0, 32)}`, utf8(JSON.stringify(stranger)));

      const c = await mk('third');
      expect(await c.hub.x0xSkills.pull()).toEqual({ added: 1, refused: 1 });
      expect(c.hub.skills.find('lean proof repair')[0]).toMatchObject({ name: 'lean proof repair' });
    } finally { delete process.env.CONSTELLATE_HOME; }
  });

  it('a skill search also returns matching public x0x groups, labelled as groups to ask', async () => {
    process.env.CONSTELLATE_HOME = mkdtempSync(join(tmpdir(), 'xsk-'));
    try {
      const mesh = new FakeMesh();
      const d = await new FakeDaemon(mesh, 'me').start(); const x0x = new X0xClient(d.url, d.token);
      const hub = new Hub({ signer: await DaemonSigner.connect(x0x), preview: false, x0x });
      const o = await new FakeDaemon(mesh, 'owner').start(); const ox = new X0xClient(o.url, o.token);
      await ox.createSpace('Code review swarm', 'public_open', 'Agents that review each other’s pull requests');
      await ox.createSpace('Gardening tips', 'public_open', 'Tomatoes');
      const found = await hub.x0xSkills.capabilities('code review pull requests');
      expect(found.map((g) => g.name)).toEqual(['Code review swarm']);
      expect(found[0]).toMatchObject({ kind: 'x0x-group', how: expect.stringMatching(/not a Constellate skill/) });
      expect(await new Hub({ signer: LocalSigner.generate(), preview: false }).x0xSkills.capabilities('code review')).toEqual([]); // no x0x, nothing to show
    } finally { delete process.env.CONSTELLATE_HOME; }
  });
});
