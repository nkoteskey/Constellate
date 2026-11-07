import { describe, it, expect } from 'vitest';
import { Hub } from '../../src/hub/hub.js';
import { LocalSigner } from '../../src/core/identity.js';
import { signRecord } from '../../src/core/record.js';
import { WebServer } from '../../src/web/server.js';
import { toB64, utf8 } from '../../src/util/bytes.js';
import { registerAppRoutes } from '../../src/web/app.js';

/**
 * "Show people it's you": a person links a GitHub account by posting one line with their
 * Constellate id in a public gist. The app accepts the signed claim only when the proof is a
 * gist owned by that same account; viewers re-check the gist themselves. Only the public
 * username is ever stored.
 */
const ctx = { task: 'link a GitHub account', domain: ['identity'], environment: 'human (browser)' };

describe('linking a GitHub account', () => {
  it('accepts a gist from the same account, shows @handle on the profile, and refuses anything else', async () => {
    const hub = new Hub({ signer: LocalSigner.generate(), preview: false, privacy: { level: 'strict', denyTerms: [] } }); // strict, as the desktop app runs
    const web = new WebServer(hub); registerAppRoutes(web); await web.listen(0);
    try {
      const person = LocalSigner.generate();
      const post = async (body: Record<string, unknown>) => {
        const rec = await signRecord({ kind: 'identity_link', context: ctx, body }, person);
        return fetch(`${web.url}/api/records`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(rec) });
      };
      expect((await post({ method: 'github', handle: 'octo-cat', proof: 'https://gist.github.com/someone-else/0123456789abcdef0123' })).status).toBe(400);
      expect((await post({ method: 'github', handle: 'bad handle!', proof: 'https://gist.github.com/x/0123456789abcdef0123' })).status).toBe(400);
      expect((await post({ method: 'github', handle: 'octo-cat', proof: 'https://evil.example/octo-cat/0123456789abcdef0123' })).status).toBe(400);
      const ok = await post({ method: 'github', handle: 'octo-cat', proof: 'https://gist.github.com/Octo-Cat/0123456789abcdef0123' });
      expect(ok.status).toBe(200);
      const me = await (await fetch(`${web.url}/api/me/${person.agentId}`)).json();
      expect(me.linked_github).toEqual({ handle: 'octo-cat', proof: 'https://gist.github.com/Octo-Cat/0123456789abcdef0123' });
      expect(me.linked_user).toBeNull();
      await new Promise((r) => setTimeout(r, 5)); // the unlink is newer
      expect((await post({ method: 'github', handle: 'octo-cat', unlink: true })).status).toBe(200);
      expect((await (await fetch(`${web.url}/api/me/${person.agentId}`)).json()).linked_github).toBeNull();
    } finally { await web.close(); }
  });
  it('one click in the desktop app: this computer’s x0x agent vouches for the person, and a forged vouch is refused', async () => {
    const hub = new Hub({ signer: LocalSigner.generate(), preview: false, privacy: { level: 'strict', denyTerms: [] } }); // strict, as the desktop app runs
    const web = new WebServer(hub); registerAppRoutes(web); await web.listen(0);
    try {
      const person = LocalSigner.generate(), x0xAgent = LocalSigner.generate(), stranger = LocalSigner.generate();
      // What the desktop app gets back from x0xd's /agent/sign (same framing as LocalSigner.sign).
      const vouch = async (agent: LocalSigner, forId: string) => ({ method: 'x0x-agent', x0x_agent_id: agent.agentId, x0x_public_key: toB64(agent.publicKey), signature: toB64(await agent.sign('constellate.identity-link.v1', utf8(forId))) });
      const post = async (body: Record<string, unknown>) => fetch(`${web.url}/api/records`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(await signRecord({ kind: 'identity_link', context: { ...ctx, task: 'link x0x' }, body }, person)) });
      expect((await post(await vouch(x0xAgent, stranger.agentId))).status).toBe(400); // vouches for someone else
      expect((await post({ ...(await vouch(x0xAgent, person.agentId)), x0x_agent_id: stranger.agentId })).status).toBe(400); // key and id don't match
      expect((await post({ ...(await vouch(x0xAgent, person.agentId)), note: 'call me on +44 7700 900123' })).status).toBe(400); // only the key and signature are set aside
      expect((await post(await vouch(x0xAgent, person.agentId))).status).toBe(200);
      const me = await (await fetch(`${web.url}/api/me/${person.agentId}`)).json();
      expect(me.linked_x0x).toBe(x0xAgent.agentId);
    } finally { await web.close(); }
  });
});
