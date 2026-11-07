import { describe, it, expect } from 'vitest';
import { FakeMesh, FakeDaemon } from '../../src/x0x/fake.js';
import { X0xClient } from '../../src/x0x/client.js';
import { Hub } from '../../src/hub/hub.js';
import { LocalSigner } from '../../src/core/identity.js';
import { signRecord } from '../../src/core/record.js';
import { WebServer } from '../../src/web/server.js';
import { registerAppRoutes } from '../../src/web/app.js';
import { leanLaunchProblem } from '../../src/work/launch.js';

/**
 * Building on x0x: each problem has a public x0x Space, so someone on the plain
 * x0x GUI joins the same conversation; Presence shows who is online. Runs
 * against a stand-in daemon shaped from x0x's docs (docs/skill/messaging.md);
 * READY FOR TESTING against a real x0xd.
 */
describe('x0x Spaces and Presence', () => {
  it('problem chat flows both ways between the app and the problem’s x0x Space', async () => {
    const mesh = new FakeMesh();
    const d = await new FakeDaemon(mesh, 'hub').start();
    const gui = await new FakeDaemon(mesh, 'someone-on-the-x0x-gui').start();
    const hub = new Hub({ signer: LocalSigner.generate(), preview: false, x0x: new X0xClient(d.url, d.token) });
    const { problem } = await hub.collective.propose(leanLaunchProblem());
    const web = new WebServer(hub);
    registerAppRoutes(web);
    await web.listen(0);
    try {
      // A person in the app says something: signed record + mirrored into the Space.
      const person = LocalSigner.generate();
      const rec = await signRecord({ kind: 'message', context: { task: 'problem chat', domain: ['maths_physics'], environment: 'human (browser)' }, body: { channel: 'problem', text: 'Anyone checking the Gauss sum?' }, refs: [problem!.id] }, person);
      expect((await fetch(`${web.url}/api/records`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(rec) })).status).toBe(200);
      await new Promise((r) => setTimeout(r, 50));
      const [gid] = [...mesh.groups.keys()];
      expect(mesh.groups.get(gid)!.preset).toBe('public_open');
      expect(mesh.groups.get(gid)!.messages.map((m) => m.body)).toContain('Anyone checking the Gauss sum?');

      // Someone on the plain x0x GUI replies in the Space: it appears in the app, labelled.
      await new X0xClient(gui.url, gui.token).spaceSend(gid, 'Yes, I am. Induction on n.');
      const chat = await (await fetch(`${web.url}/api/chat/${problem!.id}`)).json();
      expect(chat.map((c: { text: string }) => c.text)).toEqual(['Anyone checking the Gauss sum?', 'Yes, I am. Induction on n.']);
      expect(chat[1]).toMatchObject({ via: 'x0x', from: gui.agentId });

      // Presence: who is online, and an invite to the Space for the x0x app.
      const pres = await (await fetch(`${web.url}/api/presence`)).json();
      expect(pres.via).toBe('x0x');
      expect(pres.online).toEqual(expect.arrayContaining([d.agentId, gui.agentId]));
      expect((await (await fetch(`${web.url}/api/problems/${problem!.id}/space`)).json()).invite).toMatch(/^x0x:\/\/invite\//);
    } finally { await web.close(); await d.stop(); await gui.stop(); }
  });
});
