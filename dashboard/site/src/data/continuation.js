export const CONTINUATION_PAGE_SIZE = 25;

/**
 * @param {string[]} sourceNames
 * @param {number} [limit]
 */
export function continuationRequests(sourceNames, limit = CONTINUATION_PAGE_SIZE) {
  validateLimit(limit);
  return Object.fromEntries(sourceNames.map((sourceName) => [
    sourceName,
    { limit }
  ]));
}

/**
 * Adds validated, source-bound continuation loaders without exposing token
 * mechanics to presenters.
 *
 * @param {Record<string, import('../presenter.js').LogicalSourceInput>} sources
 * @param {string[]} sourceNames
 * @param {(sourceNames: string[], pagination: Record<string, { limit: number, continuationToken?: string }>) => Promise<Record<string, import('../presenter.js').LogicalSourceInput>>} loadPage
 * @param {number} [limit]
 */
export function bindSourceContinuations(
  sources,
  sourceNames,
  loadPage,
  limit = CONTINUATION_PAGE_SIZE
) {
  validateLimit(limit);
  return Object.fromEntries(Object.entries(sources).map(([name, source]) => {
    if (!sourceNames.includes(name) || source.continuationToken === undefined) {
      return [name, source];
    }
    const totalRows = validatePage(name, source);
    /** @type {string | undefined} */
    let currentToken = source.continuationToken;
    /** @type {Promise<import('../presenter.js').LogicalSourceInput> | undefined} */
    let inFlight;
    return [name, {
      ...source,
      /** @param {string} continuationToken */
      loadContinuation: (continuationToken) => {
        if (continuationToken !== currentToken) {
          return Promise.reject(new TypeError(`Continuation token for "${name}" is not current.`));
        }
        if (inFlight) return inFlight;
        inFlight = loadPage(
          [name],
          { [name]: { limit, continuationToken } }
        ).then((nextSources) => {
          const next = nextSources[name];
          if (!next) throw new TypeError(`Continuation response is missing source "${name}".`);
          validatePage(name, next, totalRows);
          currentToken = next.continuationToken;
          return next;
        }).finally(() => {
          inFlight = undefined;
        });
        return inFlight;
      }
    }];
  }));
}

/** @param {import('../presenter.js').LogicalSourceInput} source */
export function sourceContinuation(source) {
  if (source.continuationToken === undefined) return undefined;
  if (typeof source.loadContinuation !== 'function') return undefined;
  const totalRows = validatePage(source.source, source);
  return {
    token: source.continuationToken,
    totalRows,
    load: source.loadContinuation
  };
}

/**
 * @param {string} name
 * @param {import('../presenter.js').LogicalSourceInput} source
 * @param {number} [expectedTotal]
 */
function validatePage(name, source, expectedTotal) {
  if (source.source !== name || !Array.isArray(source.rows)) {
    throw new TypeError(`Invalid continuation response for source "${name}".`);
  }
  if (source.continuationToken !== undefined
      && (typeof source.continuationToken !== 'string' || source.continuationToken.length === 0)) {
    throw new TypeError(`Invalid continuation token for source "${name}".`);
  }
  const totalRows = Number(source.metadata?.['total-row-count']);
  if (!Number.isSafeInteger(totalRows) || totalRows < source.rows.length) {
    throw new TypeError(`Invalid continuation row count for source "${name}".`);
  }
  if (expectedTotal !== undefined && totalRows !== expectedTotal) {
    throw new TypeError(`Continuation data for "${name}" is stale.`);
  }
  return totalRows;
}

/** @param {number} limit */
function validateLimit(limit) {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new TypeError('Continuation page size must be a positive integer.');
  }
}
