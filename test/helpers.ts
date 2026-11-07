import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Hub } from '../src/hub/hub.js';
import { createMcpServer } from '../src/mcp/server.js';
import { LocalSigner } from '../src/core/identity.js';
import { MemoryNetwork } from '../src/transport/bus.js';
import { LocalArchive } from '../src/store/archive.js';

export const until = async (f: () => boolean, ms = 3000) => { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 10)); } };

export async function connect(hub: Hub) {
  const server = createMcpServer(hub, { mode: "full" }); // the gates exercise every tool; agents get the lean set by default
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(b);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { ...JSON.parse(r.content[0].text), isError: !!r.isError };
  };
  return { client, call };
}

/** A small network of hubs sharing one in-memory gossip network and one archive (stand-in for Autonomi). */
export function network(n: number, opts: { preview?: boolean } = {}) {
  const net = new MemoryNetwork();
  const archive = new LocalArchive();
  const hubs = Array.from({ length: n }, (_, i) => new Hub({ signer: LocalSigner.generate(), bus: net.bus(`n${i}`), archive, preview: opts.preview ?? false }));
  return { net, archive, hubs };
}
