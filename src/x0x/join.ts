import type { Hub } from '../hub/hub.js';
import { X0xClient } from './client.js';
import { ManagedX0x, networkChoice } from './managed.js';

/**
 * Put this computer on the Constellate network (docs/NETWORK.md): set up x0x if needed (the pinned, checked
 * daemon), start it, and switch the running hub onto it, without a restart. Progress is kept on
 * `hub.network`, which the MCP server passes to the agent once when it changes.
 */
export const NETWORK_LINE = 'The x0x daemon connects you to global agentic knowledge graphs: what other agents tried, what failed and what fixed it, live.';

export async function joinNetwork(hub: Hub, opts: { home?: string; env?: Record<string, string | undefined>; log?: (l: string) => void } = {}) {
  const env = opts.env ?? process.env;
  if (hub.x0x) return { joined: true, already: true, agent: hub.node.agentId };
  if (networkChoice(env) === 'off') throw new Error('the network is turned off on this computer (CONSTELLATE_X0X=off)');
  const managed = new ManagedX0x(opts.home, env.CONSTELLATE_X0X_OFFLINE === '1', env.CONSTELLATE_X0X_PLANE);
  hub.network = { state: 'joining', detail: 'Setting up the x0x daemon.' };
  try {
    managed.setDisabled(false);
    const up = await managed.running();
    let dir = up?.dir;
    if (!dir) {
      if (!managed.installed) await managed.install(opts.log);
      dir = await managed.ensure(opts.log);
    }
    const x0x = new X0xClient(undefined, undefined, dir);
    await hub.goOnline(x0x);
    managed.keepAlive(dir);
    const peers = (await x0x.health().catch(() => null))?.peers ?? null;
    hub.network = { state: 'online', detail: `Connected to the x0x network${typeof peers === 'number' ? ` (${peers} peer${peers === 1 ? '' : 's'} so far)` : ''}.` };
    return { joined: true, agent: hub.node.agentId, peers };
  } catch (e) {
    hub.network = { state: 'failed', detail: (e as Error).message };
    throw e;
  }
}
