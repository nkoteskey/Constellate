import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Hub } from '../../src/hub/hub.js';
import { LocalSigner } from '../../src/core/identity.js';
import { FakeMesh, FakeDaemon } from '../../src/x0x/fake.js';
import { X0xClient, DaemonSigner, directSendProblem } from '../../src/x0x/client.js';

/**
 * Introducing yourself to a stranger on x0x: real x0x refuses a direct message to an agent it has no contact
 * card for (404 recipient_key_unavailable), so Constellate looks them up first and tries once more. What you
 * sent shows in your own thread, replies to this computer reach you, and a failure says why in plain words.
 */
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('direct messages to people and agents you have never met', () => {
  it('looks a stranger up, delivers, shows it in your thread, and brings their reply back to you', async () => {
    process.env.CONSTELLATE_HOME = mkdtempSync(join(tmpdir(), 'dm-'));
    try {
      const mesh = new FakeMesh();
      mesh.strangers = true; // like real x0x
      const mk = async (name: string) => { const d = await new FakeDaemon(mesh, name).start(); const x0x = new X0xClient(d.url, d.token); const hub = new Hub({ signer: await DaemonSigner.connect(x0x), preview: false, x0x }); x0x.directEvents((m) => { if (!hub.sync.handle(m.sender, m.payload)) hub.people.receive(m.sender, m.payload); }); return hub; };
      const me = await mk('me'), owner = await mk('group-owner');
      await wait(100);
      const person = LocalSigner.generate().agentId; // the browser identity of the person using "me"

      // Without the lookup, x0x refuses: we never met.
      await expect(me.x0x!.directSend(owner.node.agentId, 'aGk=')).rejects.toThrow(/recipient_key_unavailable/);

      const sent = await me.people.dm(owner.node.agentId, 'Hi! I use Constellate.', { from: person });
      expect(sent).toMatchObject({ ok: true, via: 'x0x', receipt: true });
      for (let i = 0; i < 20 && !owner.people.conversations(owner.node.agentId).length; i++) await wait(50);
      expect(owner.people.conversations(owner.node.agentId)[0]).toMatchObject({ from: me.node.agentId, text: 'Hi! I use Constellate.' });

      // The sender's thread shows what they sent (it used to vanish).
      expect(me.people.conversations(person)).toEqual([expect.objectContaining({ from: person, to: owner.node.agentId, text: 'Hi! I use Constellate.' })]);

      // Their reply goes to this computer's x0x identity; on this computer, it shows in the person's thread.
      await owner.people.dm(me.node.agentId, 'Welcome! Tell me more.');
      for (let i = 0; i < 20 && me.people.conversations(person, { onThisComputer: true }).length < 2; i++) await wait(50);
      expect(me.people.conversations(person, { onThisComputer: true }).map((m) => m.text)).toEqual(['Hi! I use Constellate.', 'Welcome! Tell me more.']);
      expect(me.people.conversations(person).map((m) => m.text)).toEqual(['Hi! I use Constellate.']); // not from elsewhere
    } finally { delete process.env.CONSTELLATE_HOME; }
  });

  it('when they really can\'t be reached, nothing is sent and the reason is plain', async () => {
    process.env.CONSTELLATE_HOME = mkdtempSync(join(tmpdir(), 'dm-'));
    try {
      const mesh = new FakeMesh();
      mesh.strangers = true;
      const d = await new FakeDaemon(mesh, 'me').start();
      const x0x = new X0xClient(d.url, d.token);
      const hub = new Hub({ signer: await DaemonSigner.connect(x0x), preview: false, x0x });
      const nobody = LocalSigner.generate().agentId;
      const err = await hub.people.dm(nobody, 'hello?').catch((e) => e);
      expect(directSendProblem(err)).toMatch(/hasn’t announced itself.*Nothing was sent/);
      expect(hub.people.conversations(hub.node.agentId)).toEqual([]);
    } finally { delete process.env.CONSTELLATE_HOME; }
  });
});
