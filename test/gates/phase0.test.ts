import { describe, it, expect, afterAll } from 'vitest';
import { FakeMesh, FakeDaemon } from '../../src/x0x/fake.js';
import { X0xClient, DaemonSigner } from '../../src/x0x/client.js';
import { X0xBus } from '../../src/transport/bus.js';
import { HubNode } from '../../src/hub/node.js';
import { hashInputs, PrivacyBlockedError } from '../../src/privacy/scrub.js';
import { fromUtf8 } from '../../src/util/bytes.js';
import { verifyRecord } from '../../src/core/record.js';

/**
 * GATE 0: signed records round-trip between two machines, with nothing private leaking.
 * Two fake x0x daemons stand in for two machines; each runs a hub node that signs
 * through its daemon (POST /agent/sign) and gossips over /publish + /events.
 */
const until = async (f: () => boolean, ms = 3000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 20)); } };

describe('GATE 0 — foundations', async () => {
  const mesh = new FakeMesh();
  const dA = await new FakeDaemon(mesh, 'laptop').start();
  const dB = await new FakeDaemon(mesh, 'server').start();
  const cA = new X0xClient(dA.url, dA.token), cB = new X0xClient(dB.url, dB.token);
  const A = new HubNode({ signer: await DaemonSigner.connect(cA), bus: await X0xBus.connect(cA) });
  const B = new HubNode({ signer: await DaemonSigner.connect(cB), bus: await X0xBus.connect(cB) });
  afterAll(async () => { await A.close(); await B.close(); await dA.stop(); await dB.stop(); });

  const SECRET_PROMPT = 'Fix the deploy for jane.doe@example.org, key sk-ant-api03-SUPERSECRETKEYVALUE1234567890';

  it('signs with the daemon identity', () => {
    expect(A.agentId).toBe(dA.agentId);
    expect(B.agentId).toBe(dB.agentId);
  });

  it('round-trips a signed record A -> B after preview + publish', async () => {
    const { preview, published } = await A.submit({
      kind: 'failure',
      context: { task: 'Deploy service with cargo-shuttle', domain: ['rust', 'deploy'], environment: 'cargo-shuttle 0.49, rustc 1.95, linux', inputs_hash: hashInputs(SECRET_PROMPT) },
      body: { approach: 'shuttle deploy with default features', outcome: 'error', error_summary: 'linker error: undefined symbol ring_core_0_17', confidence: 0.8 },
    });
    expect(published).toBe(false);
    expect(B.store.size).toBe(0); // preview mode: nothing left the machine yet
    expect(mesh.wire.length).toBe(0);
    await A.publish(preview!.preview_id);
    await until(() => B.store.size === 1);
    const got = B.store.all()[0];
    expect(got.rec.id).toBe(preview!.record.id);
    expect(got.rec.agent_id).toBe(dA.agentId);
    expect(verifyRecord(got.rec).ok).toBe(true);
  });

  it('blocks private data instead of trimming it', async () => {
    await expect(A.submit({ kind: 'failure', context: { task: SECRET_PROMPT, domain: ['x'], environment: '' }, body: {} }, { publish: true })).rejects.toBeInstanceOf(PrivacyBlockedError);
  });

  it('rejects forged and tampered records on receipt', async () => {
    const good = A.store.all()[0].rec;
    const before = B.rejected.length;
    await cA.publish('constellate/v1/records', (await import('../../src/core/canonical.js')).canonicalBytes({ ...good, body: { ...good.body, outcome: 'success' } }));
    await until(() => B.rejected.length > before);
    expect(B.rejected.at(-1)!.reason).toMatch(/content hash|signature/);
  });

  it('nothing private crossed the wire', () => {
    const wire = mesh.wire.map((w) => fromUtf8(w.payload)).join('\n');
    expect(mesh.wire.length).toBeGreaterThan(0);
    for (const needle of ['jane.doe', 'example.org', 'SUPERSECRET', 'sk-ant', 'Fix the deploy']) expect(wire).not.toContain(needle);
  });
});
