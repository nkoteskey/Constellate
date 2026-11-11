/**
 * Where an approved announcement goes (docs/ANNOUNCE.md). Every one is off until the owner sets it up, and none
 * runs without `constellate announce send --yes`.
 *
 *  - feed: an Atom file on this computer, for a website or feed reader to pick up. No network.
 *  - bluesky: a post from the owner's account, logged in with an app password kept in the vault
 *    (`constellate keys set bluesky`). Request shapes from the atproto lexicons (bluesky-social/atproto, lexicons/,
 *    commit ec49bcb, read 2026-11-11): com.atproto.server.createSession takes
 *    { identifier, password } and returns { accessJwt, did, … }; com.atproto.repo.createRecord takes
 *    { repo, collection, record } and returns { uri, cid }; app.bsky.feed.post needs text (at most 300
 *    graphemes) and createdAt; a link is only clickable with a facet whose byteStart/byteEnd count UTF-8 bytes.
 *  - mastodon: POST /api/v1/statuses with the account's token (`constellate keys set mastodon`), form fields
 *    status, visibility and language, and an Idempotency-Key header, which the server honours for up to an hour
 *    (docs.joinmastodon.org/methods/statuses, read 2026-11-11). Default limit 500 characters; links count as 23.
 *  - X: no account access at all. The person gets a compose link (x.com/intent/tweet?text=…, from
 *    docs.x.com/x-for-websites/post-button/overview, read 2026-11-11), reads the post in X's own composer and
 *    sends it by hand. Web Intents need no app or key.
 */
export type SinkName = 'feed' | 'bluesky' | 'mastodon';
export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const trim = (u: string) => u.replace(/\/+$/, '');
const LINK = /https:\/\/[^\s<>"]+[^\s<>".,;:!?)\]]/g;

/** Facets that make each https link in the text clickable on Bluesky, with UTF-8 byte offsets. */
export function linkFacets(text: string) {
  const enc = new TextEncoder();
  return [...text.matchAll(LINK)].map((m) => {
    const byteStart = enc.encode(text.slice(0, m.index)).length;
    return { index: { byteStart, byteEnd: byteStart + enc.encode(m[0]).length }, features: [{ $type: 'app.bsky.richtext.facet#link', uri: m[0] }] };
  });
}

async function ok(r: Response, what: string) {
  if (r.ok) return r.json() as Promise<Record<string, unknown>>;
  const why = (await r.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
  throw new Error(`${what}: HTTP ${r.status}${why ? ` ${why}` : ''}`);
}

export async function postBluesky(cfg: { handle: string; service?: string }, password: string, text: string, fetch: Fetch): Promise<string> {
  const host = trim(cfg.service ?? 'https://bsky.social');
  const json = { 'content-type': 'application/json' };
  const session = await ok(await fetch(`${host}/xrpc/com.atproto.server.createSession`, { method: 'POST', headers: json, body: JSON.stringify({ identifier: cfg.handle, password }) }), 'Bluesky login');
  const record = { $type: 'app.bsky.feed.post', text, createdAt: new Date().toISOString(), langs: ['en'], facets: linkFacets(text) };
  const r = await ok(await fetch(`${host}/xrpc/com.atproto.repo.createRecord`, {
    method: 'POST', headers: { ...json, authorization: `Bearer ${String(session.accessJwt)}` },
    body: JSON.stringify({ repo: session.did, collection: 'app.bsky.feed.post', record }),
  }), 'Bluesky post');
  return String(r.uri ?? '');
}

export async function postMastodon(cfg: { instance: string }, token: string, text: string, key: string, fetch: Fetch): Promise<string> {
  const r = await ok(await fetch(`${trim(cfg.instance)}/api/v1/statuses`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'idempotency-key': key, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ status: text, visibility: 'public', language: 'en' }).toString(),
  }), 'Mastodon post');
  return String(r.url ?? r.id ?? '');
}

/** A link that opens X's composer with the text filled in. The person sends it themselves; nothing is posted from here. */
export function xIntent(text: string) { return `https://x.com/intent/tweet?text=${encodeURIComponent(text)}`; }

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** An Atom feed of what was announced, newest first. */
export function atomFeed(entries: { id: string; at: string; title: string; content: string }[], link: string) {
  const sorted = [...entries].sort((a, b) => b.at.localeCompare(a.at));
  const updated = sorted[0]?.at ?? new Date(0).toISOString();
  return `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Constellate: checked by machine</title>
  <id>urn:constellate:announce</id>
  <link href="${xml(link)}"/>
  <updated>${updated}</updated>
  <author><name>Constellate</name></author>
${sorted.map((e) => `  <entry>
    <id>urn:constellate:announce:${xml(e.id)}</id>
    <title>${xml(e.title)}</title>
    <updated>${e.at}</updated>
    <content type="text">${xml(e.content)}</content>
  </entry>`).join('\n')}
</feed>
`;
}
