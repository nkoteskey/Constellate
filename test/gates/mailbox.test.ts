import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Hub } from '../../src/hub/hub.js';
import { FakeMesh, FakeDaemon } from '../../src/x0x/fake.js';
import { X0xClient, DaemonSigner } from '../../src/x0x/client.js';
import { MAILBOX_TOPIC, recipientTag, seal, open } from '../../src/collab/mailbox.js';
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';
import { utf8, fromUtf8 } from '../../src/util/bytes.js';

/**
 * Sealed mailbox (docs/MAILBOX.md): a direct message to someone offline is sealed so only they can read it,
 * left in a shared x0x store, and collected when they're next online. Nobody else can read it, nobody can
 * leave one in someone else's name, and expired letters are ignored and cleared.
 */
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('a sealed mailbox for people who are offline', () => {
  it('seals a message for someone offline; they collect it when back, and only they can read it', async () => {
    const mesh = new FakeMesh();
    // Each computer has its own data folder (and so its own mailbox key).
    const mk = async (name: string) => {
      process.env.CONSTELLATE_HOME = mkdtempSync(join(tmpdir(), `mb-${name}-`));
      const d = await new FakeDaemon(mesh, name).start();
      const x0x = new X0xClient(d.url, d.token);
      const hub = new Hub({ signer: await DaemonSigner.connect(x0x), preview: false, x0x });
      void hub.mailbox; // made now, in this computer's folder
      x0x.directEvents((m) => { if (!hub.sync.handle(m.sender, m.payload)) hub.people.receive(m.sender, m.payload); });
      return { hub, d, x0x };
    };
    try {
      const a = await mk('alice'), b = await mk('bob'), c = await mk('carol');
      await wait(100);
      expect(await b.hub.mailbox.publishKey()).toBe(true); // Bob's app published its key while it was online

      // Bob goes offline: x0x can't deliver, so Alice's message is sealed into his mailbox.
      mesh.partitioned.add(b.d);
      const sent = await a.hub.people.dm(b.hub.node.agentId, 'Want to work on the Ramsey bounds together?');
      expect(sent).toMatchObject({ ok: true, via: 'mailbox' });
      expect(a.hub.people.conversations(a.hub.node.agentId).at(-1)).toMatchObject({ via: 'mailbox', out: true, waiting: true });

      // What's in the shared store: under Alice's id, tagged for Bob, and unreadable.
      const store = mesh.stores.get(MAILBOX_TOPIC)!;
      const letterKey = [...store.data.keys()].find((k) => k.startsWith(`${a.hub.node.agentId}/m/`))!;
      expect(letterKey).toContain(`/m/${recipientTag(b.hub.node.agentId)}/`);
      expect(Buffer.from(store.data.get(letterKey)!.value, 'base64').toString('utf8')).not.toMatch(/Ramsey/);

      // Carol can't read it, and finds nothing for her.
      expect(await c.hub.people.collectMail()).toBe(0);

      // Bob comes back online and collects it, once.
      mesh.partitioned.delete(b.d);
      expect(await b.hub.people.collectMail()).toBe(1);
      expect(b.hub.people.conversations(b.hub.node.agentId)).toEqual([expect.objectContaining({ from: a.hub.node.agentId, text: 'Want to work on the Ramsey bounds together?', via: 'mailbox' })]);
      expect(await b.hub.people.collectMail()).toBe(0);

      // Nobody can leave a letter in someone else's name: Carol can't write under Alice's id…
      await expect(c.x0x.directoryPut(MAILBOX_TOPIC, `${a.hub.node.agentId}/m/${recipientTag(b.hub.node.agentId)}/${'ab'.repeat(12)}`, utf8('{}'))).rejects.toThrow(/403/);
      // …and a letter she seals under her own id that claims to be from Alice is delivered as from Carol.
      mesh.partitioned.add(b.d);
      await c.hub.people.dm(b.hub.node.agentId, 'It’s me, Alice. Honest.');
      mesh.partitioned.delete(b.d);
      await b.hub.people.collectMail();
      expect(b.hub.people.conversations(b.hub.node.agentId).at(-1)).toMatchObject({ from: c.hub.node.agentId });

      // An expired letter is ignored by the recipient and cleared by the sender's daily tidy.
      const bobKey = (await a.hub.mailbox.keyOf(b.hub.node.agentId))!;
      const old = seal({ id: 'cd'.repeat(12), from: a.hub.node.agentId, to: b.hub.node.agentId, text: 'old news', at: '2026-01-01T00:00:00Z' }, bobKey, new Date(Date.now() - 1000));
      await a.x0x.directoryPut(MAILBOX_TOPIC, `${a.hub.node.agentId}/m/${recipientTag(b.hub.node.agentId)}/${'cd'.repeat(12)}`, utf8(JSON.stringify(old)));
      expect(await b.hub.people.collectMail()).toBe(0);
      expect(await a.hub.mailbox.tidy()).toBe(1);
      expect([...store.data.keys()].some((k) => k.endsWith('cd'.repeat(12)))).toBe(false);
    } finally { delete process.env.CONSTELLATE_HOME; }
  });

  it('with no mailbox to leave it in (an older Constellate, or nobody), the original reason stands and nothing is sent', async () => {
    const mesh = new FakeMesh();
    process.env.CONSTELLATE_HOME = mkdtempSync(join(tmpdir(), 'mb-old-'));
    try {
      const a = await new FakeDaemon(mesh, 'a').start(), old = await new FakeDaemon(mesh, 'old').start();
      const ax = new X0xClient(a.url, a.token);
      const hub = new Hub({ signer: await DaemonSigner.connect(ax), preview: false, x0x: ax });
      mesh.partitioned.add(old);
      await expect(hub.people.dm(old.agentId, 'hello')).rejects.toThrow(/recipient_key_unavailable/);
      expect(hub.people.conversations(hub.node.agentId)).toEqual([]);
    } finally { delete process.env.CONSTELLATE_HOME; }
  });

  it('a letter opens only with the recipient’s key, and tampering is caught', () => {
    const bob = ml_kem768.keygen(), eve = ml_kem768.keygen();
    const letter = { id: 'ab'.repeat(12), from: 'a'.repeat(64), to: 'b'.repeat(64), text: 'hi', at: '2026-11-08T00:00:00Z' };
    const s = seal(letter, bob.publicKey, new Date(Date.now() + 1000));
    expect(open(s, bob.secretKey)).toEqual(letter);
    expect(open(s, eve.secretKey)).toBeNull();
    const box = Buffer.from(s.box, 'base64'); box[0] ^= 1;
    expect(open({ ...s, box: box.toString('base64') }, bob.secretKey)).toBeNull();
    expect(fromUtf8(utf8(JSON.stringify(s)))).not.toContain('hi"');
  });
});
