import { describe, it, expect } from 'vitest';
import { mkdtempSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RecordStore } from '../../src/store/records.js';
import { LocalSigner } from '../../src/core/identity.js';
import { signRecord } from '../../src/core/record.js';
import { ActivityLog } from '../../src/hub/activity.js';

/**
 * Live shows what an agent on this computer is doing. The agent runs its own Constellate process, which saves
 * into the same store and appends to the same activity log as the app; the app picks both up while running.
 */
describe('live: the agents on this computer', () => {
  it('the app picks up records another process saved into the shared store, verified, and tells its listeners', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'live-'));
    const app = new RecordStore(dir), agent = new RecordStore(dir);
    const heard: string[] = [];
    app.onAdd((s) => heard.push(s.rec.kind));
    const rec = await signRecord({ kind: 'failure', context: { task: 'Ramsey search', domain: ['maths_physics'], environment: 'python' }, body: { approach: 'annealing over circulant colourings', outcome: 'too_slow' } }, LocalSigner.generate());
    agent.add(rec);
    expect(app.get(rec.id)).toBeUndefined();
    expect(app.rescan()).toBe(1);
    expect(app.get(rec.id)?.rec.id).toBe(rec.id);
    expect(heard).toEqual(['failure']);
    expect(app.rescan()).toBe(0); // once only
    // A damaged or forged file is never taken in.
    appendFileSync(join(dir, 'public', `${'ab'.repeat(32)}.cbor`), 'not a record');
    expect(app.rescan()).toBe(0);
  });

  it('reads only the activity appended since it last looked, whole lines only', () => {
    const log = new ActivityLog(join(mkdtempSync(join(tmpdir(), 'live-')), 'agent-activity.jsonl'));
    log.record('claude-code', 'failures_search', { results: [{ id: 'x' }] });
    const start = log.size();
    log.record('claude-ai', 'answers_lookup', { results: [] });
    appendFileSync(log.file, '{"at":"half a line');
    const { events, next } = log.since(start);
    expect(events.map((e) => [e.client, e.tool, e.results])).toEqual([['Claude Desktop', 'answers_lookup', 0]]);
    expect(log.since(next).events).toEqual([]); // the half line waits until it's finished
  });
});
