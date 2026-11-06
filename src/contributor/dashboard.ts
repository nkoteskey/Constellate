import { WebServer, HttpReply } from '../web/server.js';
import { Worker } from '../work/worker.js';
import { Budget } from './models.js';
import { Device, Policy, readConditions, suggestFor } from './device.js';

/**
 * The contributor app's status and controls, served on this machine only:
 * what the device is doing and why, which models, spend against the cap, and
 * the polite policy (plugged in, battery, hours, heat, pause). The app's
 * "Lend your computer" page shows it when it's running.
 */
export function registerContributorRoutes(web: WebServer, c: { workers: Worker[]; budget: Budget; policy: Policy; device: Device }) {
  web.route('GET', /^\/api\/contributor$/, () => {
    const cond = readConditions();
    return {
      status: c.workers[0]?.status ?? { state: 'waiting', message: 'Starting…' },
      models: c.workers.map((w) => ({ id: w.runner.id, family: w.runner.family, local: w.runner.costPerCall === 0 })),
      spend: c.budget.report(),
      policy: c.policy,
      conditions: cond,
      device: c.device,
      suggestion: suggestFor(c.device),
    };
  });
  web.route('POST', /^\/api\/contributor\/policy$/, async (req, _m, _u, body) => {
    // Local only: the controls change what this machine does, so only this machine may change them.
    const ip = req.socket.remoteAddress ?? '';
    if (!/^(127\.|::1$|::ffff:127\.)/.test(ip)) return new HttpReply(403, { error: 'controls are local to this machine' });
    const j = (await body()) as Partial<Policy>;
    if (typeof j.paused === 'boolean') c.policy.paused = j.paused;
    if (typeof j.requireAC === 'boolean') c.policy.requireAC = j.requireAC;
    if (Number.isFinite(j.minBattery)) c.policy.minBattery = Math.max(0, Math.min(100, Number(j.minBattery)));
    if (j.maxTempC === null || Number.isFinite(j.maxTempC)) c.policy.maxTempC = j.maxTempC === null ? null : Math.max(40, Math.min(110, Number(j.maxTempC)));
    if (j.hours === null || (Array.isArray(j.hours) && j.hours.length === 2 && j.hours.every((h) => Number.isInteger(h) && h >= 0 && h < 24))) c.policy.hours = j.hours as [number, number] | null;
    return { policy: c.policy };
  });
}
