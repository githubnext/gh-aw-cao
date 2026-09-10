export const BACKGROUND_REFRESH_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Polls for updated dashboard sources until the owning page is discarded.
 * @param {() => void} refresh
 * @param {{ signal?: AbortSignal, intervalMs?: number }} [options]
 * @returns {() => void}
 */
export function scheduleBackgroundRefresh(refresh, options = {}) {
  if (options.signal?.aborted) return () => {};
  const interval = globalThis.setInterval(
    refresh,
    options.intervalMs ?? BACKGROUND_REFRESH_INTERVAL_MS
  );
  const stop = () => globalThis.clearInterval(interval);
  options.signal?.addEventListener('abort', stop, { once: true });
  return stop;
}
