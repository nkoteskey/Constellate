import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { decodeCanonical } from '../core/canonical.js';
import { openBundle, isBundle } from '../store/bundle.js';
import { verifyRecord, type SignedRecord } from '../core/record.js';

/**
 * The starter library's signing identities (the desktop app imports a signed snapshot of public history
 * once; see CONSTELLATE_STARTER). Read from the snapshot named in the import marker. The People page uses it to
 * say "Starter library" instead of showing an anonymous agent with a thousand contributions, and the announcer
 * (docs/ANNOUNCE.md) trusts problems these identities signed.
 */
const cache = new Map<string, Set<string>>();
export function starterOperators(home = process.env.CONSTELLATE_HOME ?? join(homedir(), '.constellate')): Set<string> {
  const known = cache.get(home);
  if (known) return known;
  const ops = new Set<string>();
  cache.set(home, ops);
  try {
    const marker = JSON.parse(readFileSync(join(home, 'starter-imported'), 'utf8')) as { file?: string };
    if (marker.file && existsSync(marker.file)) {
      const bytes = new Uint8Array(readFileSync(marker.file));
      const recs = isBundle(bytes) ? (({ roots, records }) => [...roots, ...records])(openBundle(bytes)) : decodeCanonical<{ records: SignedRecord[] }>(bytes).records;
      const roots = new Map(recs.filter((r) => r.kind === 'batch_root').map((r) => [r.id, r]));
      for (const r of recs.slice(0, 2500)) { const v = verifyRecord(r, { root: (id) => roots.get(id) }); if (v.ok) ops.add(v.operatorId); }
    }
  } catch { /* no starter library on this install */ }
  return ops;
}
