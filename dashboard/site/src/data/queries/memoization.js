export const DASHBOARD_QUERY_CACHE_TTL_MS = 30_000;
export const DASHBOARD_QUERY_CACHE_MAX_ENTRIES = 24;

/**
 * Creates a bounded, revision-aware in-memory cache for materialized query results.
 * @param {{ ttlMs?: number, maxEntries?: number, now?: () => number }} [options]
 */
export function createDashboardQueryMemoization(options = {}) {
  const ttlMs = options.ttlMs ?? DASHBOARD_QUERY_CACHE_TTL_MS;
  const maxEntries = options.maxEntries ?? DASHBOARD_QUERY_CACHE_MAX_ENTRIES;
  const now = options.now ?? Date.now;
  /** @type {Map<string, { expiresAt: number, value: unknown }>} */
  const entries = new Map();
  /** @type {number | null} */
  let revision = null;

  return {
    /**
     * @template T
     * @param {number} databaseRevision
     * @param {string} key
     * @param {() => Promise<T>} compute
     * @returns {Promise<T>}
     */
    async get(databaseRevision, key, compute) {
      if (revision !== databaseRevision) {
        entries.clear();
        revision = databaseRevision;
      }
      const timestamp = now();
      for (const [candidate, entry] of entries) {
        if (entry.expiresAt <= timestamp) entries.delete(candidate);
      }
      const cached = entries.get(key);
      if (cached) {
        entries.delete(key);
        entries.set(key, cached);
        return /** @type {T} */ (cached.value);
      }

      const value = await compute();
      if (revision !== databaseRevision) return value;
      entries.set(key, { value, expiresAt: now() + ttlMs });
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
      return value;
    }
  };
}

/**
 * @param {unknown[]} parts
 */
export function dashboardQueryMemoizationKey(parts) {
  return JSON.stringify(parts);
}
