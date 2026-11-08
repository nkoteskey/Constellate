# Sealed mailbox: messages for people who are offline

x0x delivers a direct message only while both computers are online. When it can't, Constellate seals the
message so only the recipient can read it and leaves it in a shared x0x data store. The recipient's app
collects it the next time it's online, even if the sender's computer is off by then.

## How it works

1. **Every computer has a mailbox key.**
   - Each app makes an ML-KEM-768 key pair once (post-quantum, like the rest of Constellate) and keeps the secret half in
     `~/.constellate/mailbox.key`, readable only by the user.
   - It publishes the public half to the x0x store `constellate.mailbox.v1` under `<agent_id>/key`.
2. **Sending to someone offline:**
   - When x0x can't reach them, the message is sealed to their mailbox key: ML-KEM-768, then XChaCha20-Poly1305
     with a key from HKDF-SHA256.
   - It's stored under `<sender>/m/<recipient tag>/<id>`.
   - The sender sees "sealed in their mailbox, waiting for them to come online".
3. **Collecting:**
   - The app (`serve` and the desktop app) collects five seconds after starting, then every minute.
   - It opens only the letters tagged for it.
   - Each one joins the conversation once, marked "left in your mailbox while you were away".
4. **Expiry:**
   - Letters keep for 14 days.
   - The recipient ignores expired ones.
   - The sender's app removes its own expired letters once a day.

## People who use Constellate only through an agent

Someone who runs only `npx constellate-mcp mcp` (no app) is still reachable:

- **Listed.** With x0x, their agent's Constellate process publishes a profile marked "Uses Constellate through an
  agent". The People page says that messages and invites reach their agent.
- **Messages.** Direct messages and sealed letters for their computer are collected by that process. Each is
  passed to the agent once, with its next Constellate reply. The agent tells its person and can answer with
  `dm_send` (full tool set). When the app is running on the same computer, the app collects instead.
- **Shares made offline.** Without x0x, what their agent shares is signed and kept on their computer. It goes out
  to the network the next time Constellate starts with x0x (`Hub.sendOfflineShares`), once. The agent is told
  once that it's offline, with how to join.

## What it protects, and what it doesn't

- **Only the recipient can read a letter.** Without their secret key the text can't be recovered, and any
  tampering is detected.
- **Nobody can leave a letter in someone else's name.** The store is self-keyed: only an agent can write under
  its own id. A letter at `<sender>/…` is from that sender, and the app shows it as from them, whatever the text
  claims.
- **Others can see that a letter exists, not what it says.** Anyone in the store can see that a sender left a
  letter for a recipient tag, and when. The tag is a hash of the recipient's agent id, so anyone who knows that
  id can work out it's for them. If that matters, a later version can hide recipients completely, at the cost of
  every app trying to open every letter.
- **Mailboxes are only as old as this version.** Someone running an older Constellate has no mailbox key. A
  message to them while they're offline isn't sent, and the app says so, as before.

Code: `src/collab/mailbox.ts`, used from `People.dm` (`src/collab/people.ts`). Tests:
`test/gates/mailbox.test.ts`. They cover:
- sealing for someone offline, and collecting it once they're back;
- that nobody else can read a letter;
- forgery attempts;
- expiry;
- a recipient with no mailbox.
