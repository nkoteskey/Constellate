/**
 * Answer at once from the last result and refresh in the background ("stale while revalidate"), for routes that
 * wait on the x0x daemon or walk the disk. Pages then draw without waiting on the network; the next visit sees
 * what changed. The first call waits for a result, at most `firstWaitMs`, then gets `fallback()` while the call
 * finishes in the background. A failed refresh keeps the last good result. `fresh()` waits for a new result
 * (routes take `?fresh=1` for it).
 */
export function swr<T>(load: () => Promise<T> | T, opts: { maxAgeMs: number; firstWaitMs?: number; fallback?: () => T }) {
  let value: { v: T; at: number } | undefined;
  let pending: Promise<T> | undefined;
  const refresh = () => (pending ??= Promise.resolve().then(load).then((v) => { value = { v, at: Date.now() }; return v; }).finally(() => { pending = undefined; }));
  const get = async (): Promise<T> => {
    if (value) {
      if (Date.now() - value.at >= opts.maxAgeMs) void refresh().catch(() => {});
      return value.v;
    }
    const p = refresh();
    if (!opts.fallback) return p;
    const timeout = new Promise<'late'>((r) => setTimeout(() => r('late'), opts.firstWaitMs ?? 1500).unref?.());
    const r = await Promise.race([p.catch(() => 'late' as const), timeout]);
    return r === 'late' ? opts.fallback() : r;
  };
  return Object.assign(get, { warm: () => void refresh().catch(() => {}), clear: () => { value = undefined; }, fresh: () => refresh() });
}
