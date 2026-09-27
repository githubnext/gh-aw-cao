/**
 * Shared named-query executor for agent transports.
 *
 * The `cao` CLI and the read-only MCP server execute reviewed Dashboard
 * Language queries through this module so both transports resolve the same
 * dependencies, read the same canonical stores, and report the same freshness
 * and completeness metadata. It never accepts SQL and never accepts an
 * unreviewed query definition: only query identifiers declared by the dashboard
 * document can be executed.
 */

import { loadDatabaseQuerySources } from '../data/queries/database.js';
import { describeQuery, queryExecutionRequirements, queryParameters } from './catalog.js';

/** Maximum rows one named-query result returns when no smaller limit is given. */
export const DEFAULT_NAMED_QUERY_LIMIT = 500;

/** Hard upper bound on rows returned by one named-query result. */
export const MAX_NAMED_QUERY_LIMIT = 5000;

/** Maximum number of parameters accepted by one named-query invocation. */
export const MAX_NAMED_QUERY_PARAMETERS = 8;

/** Maximum length of one parameter value. */
export const MAX_NAMED_QUERY_PARAMETER_LENGTH = 256;

/** Raised for invalid agent input so transports can report it without a stack trace. */
export class NamedQueryError extends Error {}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validates the requested parameters against the parameters the dashboard
 * declares for one query.
 *
 * @param {unknown} document
 * @param {string} queryId
 * @param {unknown} parameters
 * @returns {Array<{ name: string, field: string, value: string }>}
 */
export function resolveNamedQueryParameters(document, queryId, parameters) {
  if (parameters === undefined || parameters === null) return [];
  if (!isPlainObject(parameters)) {
    throw new NamedQueryError('Query parameters must be an object of name/value pairs');
  }
  const entries = Object.entries(parameters);
  if (entries.length > MAX_NAMED_QUERY_PARAMETERS) {
    throw new NamedQueryError(`At most ${MAX_NAMED_QUERY_PARAMETERS} query parameters are accepted`);
  }
  const declared = new Map(queryParameters(document, queryId).map((parameter) => [parameter.name, parameter]));
  return entries.map(([name, value]) => {
    const parameter = declared.get(name);
    if (!parameter) {
      const known = [...declared.keys()].toSorted().join(', ') || 'none';
      throw new NamedQueryError(`Unknown parameter "${name}" for query ${queryId}; declared parameters: ${known}`);
    }
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      throw new NamedQueryError(`Parameter "${name}" must be a string, number, or boolean`);
    }
    const text = String(value);
    if (text.length > MAX_NAMED_QUERY_PARAMETER_LENGTH) {
      throw new NamedQueryError(`Parameter "${name}" exceeds ${MAX_NAMED_QUERY_PARAMETER_LENGTH} characters`);
    }
    return { name: parameter.name, field: parameter.field, value: text };
  });
}

/**
 * @param {unknown} limit
 * @returns {number}
 */
function resolveLimit(limit) {
  if (limit === undefined || limit === null) return DEFAULT_NAMED_QUERY_LIMIT;
  const value = typeof limit === 'number' ? limit : Number(limit);
  if (!Number.isInteger(value) || value < 1) {
    throw new NamedQueryError('Query limit must be a positive integer');
  }
  return Math.min(value, MAX_NAMED_QUERY_LIMIT);
}

/**
 * @param {Record<string, unknown>} row
 * @param {Array<{ field: string, value: string }>} filters
 */
function matchesParameters(row, filters) {
  return filters.every((filter) => {
    const value = row[filter.field];
    return value !== undefined && value !== null && String(value) === filter.value;
  });
}

/**
 * Executes one reviewed named Dashboard Language query against the local
 * canonical projection.
 *
 * @param {{
 *   indexedDB: IDBFactory,
 *   document: unknown,
 *   queryId: string,
 *   parameters?: Record<string, unknown>,
 *   limit?: number,
 *   signal?: AbortSignal
 * }} request
 * @returns {Promise<{ query: string, rows: Record<string, unknown>[], metadata: Record<string, unknown> }>}
 */
export async function executeNamedQuery({ indexedDB, document, queryId, parameters, limit, signal }) {
  const id = typeof queryId === 'string' ? queryId.trim() : '';
  if (!id) throw new NamedQueryError('A dashboard query identifier is required');
  const definition = describeQuery(document, id);
  if (!definition) throw new NamedQueryError(`Unknown dashboard query: ${id}`);
  const filters = resolveNamedQueryParameters(document, id, parameters);
  const maxRows = resolveLimit(limit);
  const execution = queryExecutionRequirements(document, id);
  if (!execution.local) {
    return {
      query: id,
      rows: [],
      metadata: {
        availability: 'unavailable',
        completeness: 'unknown',
        freshness: 'unknown',
        'query-diagnostic': String(execution.reason),
        requirements: execution.requirements
      }
    };
  }
  signal?.throwIfAborted?.();
  const queries = isPlainObject(document) && isPlainObject(document.dashboard)
    && Array.isArray(document.dashboard.queries)
    ? document.dashboard.queries
    : [];
  // The declarative engine reports stage timings through `console.time`, which
  // would corrupt machine-readable CLI and MCP output.
  const time = console.time;
  const timeEnd = console.timeEnd;
  /** @type {{ rows?: unknown, metadata?: unknown } | undefined} */
  let source;
  try {
    console.time = () => {};
    console.timeEnd = () => {};
    const sources = await loadDatabaseQuerySources(indexedDB, {}, { sourceNames: [id], queries });
    source = /** @type {{ rows?: unknown, metadata?: unknown } | undefined} */ (sources[id]);
  } finally {
    console.time = time;
    console.timeEnd = timeEnd;
  }
  signal?.throwIfAborted?.();
  const metadata = isPlainObject(source?.metadata) ? source.metadata : {};
  const allRows = /** @type {Record<string, unknown>[]} */ (Array.isArray(source?.rows) ? source.rows : []);
  const matched = filters.length === 0 ? allRows : allRows.filter((row) => matchesParameters(row, filters));
  const rows = matched.slice(0, maxRows);
  return {
    query: id,
    rows,
    metadata: {
      availability: typeof metadata.availability === 'string'
        ? (metadata.availability === 'available' && rows.length === 0 ? 'empty' : metadata.availability)
        : 'unknown',
      completeness: rows.length < matched.length ? 'partial' : (metadata.completeness ?? 'unknown'),
      freshness: metadata.freshness ?? 'unknown',
      'as-of': metadata['as-of'] ?? '',
      'matched-rows': matched.length,
      'returned-rows': rows.length,
      limit: maxRows,
      ...(filters.length > 0
        ? { parameters: Object.fromEntries(filters.map((filter) => [filter.name, filter.value])) }
        : {})
    }
  };
}
