export const DASHBOARD_QUERY_CACHE_MAX_ENTRIES = 24;

/**
 * Creates a bounded, revision-aware in-memory cache for materialized query results.
 * Results remain reusable for the lifetime of their database revision. Older
 * revisions remain available as stale-while-revalidate snapshots until the
 * worker replaces or evicts them.
 * @param {{ maxEntries?: number }} [options]
 */
export function createDashboardQueryMemoization(options = {}) {
  const maxEntries = options.maxEntries ?? DASHBOARD_QUERY_CACHE_MAX_ENTRIES;
  /** @type {Map<string, { revision: number, value: unknown }>} */
  const entries = new Map();
  let latestRevision = Number.NEGATIVE_INFINITY;

  /** @param {string} key @param {{ revision: number, value: unknown }} entry */
  const touch = (key, entry) => {
    entries.delete(key);
    entries.set(key, entry);
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
  };

  return {
    /**
     * Returns the most recent materialized value for a view, including one
     * produced from an older database revision.
     * @param {string} key
     * @returns {{ revision: number, value: unknown } | null}
     */
    peek(key) {
      const cached = entries.get(key);
      if (!cached) return null;
      touch(key, cached);
      return { revision: cached.revision, value: cached.value };
    },

    /**
     * @template T
     * @param {number} databaseRevision
     * @param {string} key
     * @param {() => Promise<T>} compute
     * @returns {Promise<T>}
     */
    async get(databaseRevision, key, compute) {
      latestRevision = Math.max(latestRevision, databaseRevision);
      const cached = entries.get(key);
      if (cached?.revision === databaseRevision) {
        touch(key, cached);
        return /** @type {T} */ (cached.value);
      }

      const pending = compute().then((value) => {
        if (latestRevision === databaseRevision) {
          touch(key, { revision: databaseRevision, value });
        }
        return value;
      });
      try {
        return /** @type {T} */ (await pending);
      } finally {
        if (latestRevision > databaseRevision && entries.get(key)?.revision === databaseRevision) {
          entries.delete(key);
        }
      }
    }
  };
}

/**
 * @param {unknown[]} parts
 */
export function dashboardQueryMemoizationKey(parts) {
  return JSON.stringify(parts);
}
