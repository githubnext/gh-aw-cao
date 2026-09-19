export const DASHBOARD_QUERY_CACHE_MAX_ENTRIES = 24;

/**
 * Creates a bounded, revision-aware weak cache for materialized query results.
 * Results remain reusable while another owner keeps them alive. Older revisions
 * may provide stale-while-revalidate snapshots, but never prevent collection.
 * @param {{ maxEntries?: number, weakRef?: (value: object) => { deref: () => object | undefined } | null }} [options]
 */
export function createDashboardQueryMemoization(options = {}) {
  const maxEntries = options.maxEntries ?? DASHBOARD_QUERY_CACHE_MAX_ENTRIES;
  const weakRef = options.weakRef ?? ((value) => (
    typeof WeakRef === 'function' ? new WeakRef(value) : null
  ));
  /** @type {Map<string, { revision: number, reference: { deref: () => object | undefined } }>} */
  const entries = new Map();
  let latestRevision = Number.NEGATIVE_INFINITY;

  /** @param {string} key @param {{ revision: number, reference: { deref: () => object | undefined } }} entry */
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
      const value = cached.reference.deref();
      if (value === undefined) {
        entries.delete(key);
        return null;
      }
      touch(key, cached);
      return { revision: cached.revision, value };
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
        const value = cached.reference.deref();
        if (value !== undefined) {
          touch(key, cached);
          return /** @type {T} */ (value);
        }
        entries.delete(key);
      }

      const pending = compute().then((value) => {
        if (latestRevision === databaseRevision && value !== null && typeof value === 'object') {
          const reference = weakRef(value);
          if (reference) touch(key, { revision: databaseRevision, reference });
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
