// "Show people it's you": link a Constellate identity to a GitHub account in three steps.
// The person posts one line containing their Constellate id in a public gist; the signed
// identity_link record says "I'm @handle, proof: <gist>". Both directions are covered: only the
// key holder can sign the record, and only the GitHub account holder can post the gist.
// Anyone viewing a profile re-checks the gist in their own browser; nothing is taken on trust.
// Only the public username is shared (Constellate's personal-data rule).

export const HANDLE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
export const proofLine = (id) => `Verifying my Constellate identity: ${id}`;

const gh = (path) => fetch(`https://api.github.com${path}`, { headers: { accept: 'application/vnd.github+json' } });

async function gistMentions(gist, id) {
  if ((gist.description ?? '').includes(id)) return true;
  for (const f of Object.values(gist.files ?? {})) {
    if (f.content != null) { if (f.content.includes(id)) return true; continue; }
    if (!f.raw_url || f.size > 20000) continue;
    try { if ((await (await fetch(f.raw_url)).text()).includes(id)) return true; } catch { /* try the next file */ }
  }
  return false;
}

/** Find the gist with the proof line among the account's latest public gists. Returns its URL, or why not. */
export async function findProof(handle, id) {
  if (!HANDLE.test(handle)) return { error: 'That doesn’t look like a GitHub username.' };
  const r = await gh(`/users/${encodeURIComponent(handle)}/gists?per_page=20`).catch(() => null);
  if (!r) return { error: 'Couldn’t reach GitHub. Check your connection and try again.' };
  if (r.status === 404) return { error: `GitHub has no user called ${handle}.` };
  if (r.status === 403) return { error: 'GitHub is limiting checks right now. Try again in a few minutes.' };
  if (!r.ok) return { error: `GitHub said ${r.status}.` };
  for (const g of await r.json()) if (g.public && await gistMentions(g, id)) return { url: g.html_url };
  return { error: 'No public gist with your line yet. Saved it as public? It can take a few seconds to appear.' };
}

/** Re-check a linked profile: the gist exists, belongs to that account, and still carries the id. Cached per tab. */
export async function verifyLink(handle, proof, id) {
  const key = `gh-verified:${handle}:${proof}:${id}`;
  try { const c = sessionStorage.getItem(key); if (c) return c === '1'; } catch { /* private mode */ }
  const m = /^https:\/\/gist\.github\.com\/([A-Za-z0-9-]+)\/([0-9a-f]{20,40})$/.exec(proof ?? '');
  let ok = false;
  if (m && m[1].toLowerCase() === handle.toLowerCase()) {
    const r = await gh(`/gists/${m[2]}`).catch(() => null);
    if (r?.ok) { const g = await r.json(); ok = g.public && g.owner?.login?.toLowerCase() === handle.toLowerCase() && await gistMentions(g, id); }
    else if (r?.status === 403) return null; // rate-limited: unknown, not false
  }
  try { sessionStorage.setItem(key, ok ? '1' : '0'); } catch { /* private mode */ }
  return ok;
}
