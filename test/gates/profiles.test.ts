import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FakeMesh, FakeDaemon } from '../../src/x0x/fake.js';
import { X0xClient, DaemonSigner } from '../../src/x0x/client.js';
import { Hub } from '../../src/hub/hub.js';
import { LocalSigner } from '../../src/core/identity.js';
import { signRecord } from '../../src/core/record.js';
import { utf8 } from '../../src/util/bytes.js';
import { WebServer } from '../../src/web/server.js';
import { registerAppRoutes } from '../../src/web/app.js';
import { PROFILES_TOPIC } from '../../src/collab/profiles.js';

/**
 * Who's who on x0x: each computer's agent lists itself in an open directory and hosts its
 * person's profile (signed by the person). Other computers see both, who's online, and can't
 * forge or overwrite anyone else's entry.
 */
const ctx = { task: 'profile', domain: ['people'], environment: 'human (browser)' };

async function node(mesh: FakeMesh, name: string) {
  const d = await new FakeDaemon(mesh, name).start();
  const x0x = new X0xClient(d.url, d.token);
  const hub = new Hub({ signer: await DaemonSigner.connect(x0x), preview: false, x0x });
  const web = new WebServer(hub); registerAppRoutes(web); await web.listen(0);
  return { d, x0x, hub, web };
}

describe('profiles and who’s online, over x0x', () => {
  it('each computer lists itself and its person; others see them, online, and forgeries are dropped', async () => {
    process.env.CONSTELLATE_HOME = mkdtempSync(join(tmpdir(), 'prof-'));
    const mesh = new FakeMesh();
    const a = await node(mesh, 'alice-laptop'), b = await node(mesh, 'bob-desktop');
    try {
      // The person on computer A publishes a profile from the app (signed in their browser).
      const person = LocalSigner.generate();
      const rec = await signRecord({ kind: 'profile', context: ctx, body: { kind: 'person', handle: 'nk', about: 'Number theory and Lean proofs', realms: ['maths_physics'], open_to: { messages: true, invites: true } } }, person);
      const r = await fetch(`${a.web.url}/api/profile`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(rec) });
      expect(await r.json()).toEqual({ published: 'x0x' });

      // Computer B sees A's agent and A's person, online, with what they're open to.
      await new Promise((res) => setTimeout(res, 50));
      const dir = await (await fetch(`${b.web.url}/api/directory`)).json();
      expect(dir.via).toBe('x0x');
      const nk = dir.profiles.find((p: { handle?: string }) => p.handle === 'nk');
      expect(nk).toMatchObject({ kind: 'person', id: person.agentId, host: a.hub.node.agentId, online: true, realms: ['maths_physics'] });
      expect(dir.profiles.some((p: { kind: string; host: string }) => p.kind === 'agent' && p.host === a.hub.node.agentId)).toBe(true);

      // B can't write under A's id, and a forged entry under its own id claiming to be A's agent is dropped.
      await expect(b.x0x.directoryPut(PROFILES_TOPIC, `${a.hub.node.agentId}/person`, utf8('{}'))).rejects.toThrow(/403/);
      const forged = await signRecord({ kind: 'profile', context: ctx, body: { kind: 'agent', handle: 'not-me' } }, LocalSigner.generate());
      await b.x0x.directoryPut(PROFILES_TOPIC, b.hub.node.agentId, utf8(JSON.stringify(forged)));
      const again = await (await fetch(`${a.web.url}/api/directory?fresh=1`)).json();
      expect(again.profiles.some((p: { handle?: string }) => p.handle === 'not-me')).toBe(false);

      // Out in the open: a public group someone else listed on x0x shows up, read-only, with its owner to say hello to.
      const gid = await a.x0x.createSpace('Swarm review room', 'public_open', 'Models that code and review each other');
      const open = await (await fetch(`${b.web.url}/api/x0x/groups?fresh=1`)).json(); // served from a cache otherwise (src/web/swr.ts)
      expect(open.groups.find((g: { id: string }) => g.id === gid)).toMatchObject({ name: 'Swarm review room', owner: a.hub.node.agentId, ours: false });

      // Profiles keep to public handles: contact details in "about" are refused.
      const named = await signRecord({ kind: 'profile', context: ctx, body: { kind: 'person', handle: 'nk', about: 'Call me on +44 7700 900123' } }, person);
      expect((await fetch(`${a.web.url}/api/profile`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(named) })).status).toBe(400);
    } finally { await a.web.close(); await b.web.close(); delete process.env.CONSTELLATE_HOME; }
  });
});
