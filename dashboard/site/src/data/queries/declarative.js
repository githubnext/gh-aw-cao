/**
 * Declarative dashboard data queries.
 *
 * A query is a closed, structured projection over declared logical sources.
 * Queries contain no scripts, callbacks, SQL text, or executable expressions:
 * every clause compiles to the serializable row operators in
 * `data-operations.js` so the whole pipeline runs inside the data Web Worker.
 *
 * Clause execution order is fixed and deterministic:
 * `from` -> `joins` -> `filter` -> `compute` -> `aggregate` -> `select` ->
 * `order-by` -> `limit`.
 */

import { tidy } from '../../data-operations.js';

/**
 * @typedef {Record<string, unknown>} Row
 * @typedef {import('../../presenter.js').LogicalSourceInput} LogicalSourceInput
 * @typedef {import('../../presenter.js').SourceMetadata} SourceMetadata
 */

/**
 * @typedef {{
 *   name: string,
 *   description?: string,
 *   from: string,
 *   joins?: Array<{ source: string, type?: 'inner'|'left', on: Array<{ left: string, right: string }>, fields: Array<{ field: string, as: string }> }>,
 *   filter?: { predicates?: Array<{ field: string, equals?: unknown, in?: unknown[], includes?: string }> },
 *   compute?: import('../../data-operations.js').ComputedField[],
 *   aggregate?: { by?: string[], values: Array<{ field: string, as: string, reducer: 'count'|'distinct-count'|'sum'|'mean'|'min'|'max' }> },
 *   select?: Array<{ field: string, as?: string }>,
 *   ['order-by']?: Array<{ field: string, direction?: 'asc'|'desc' }>,
 *   limit?: number
 * }} DashboardQuery
 */

/**
 * Documented resource limits. A query that would exceed any limit fails
 * closed and reports an explicit unavailable state instead of truncating.
 */
export const DASHBOARD_QUERY_LIMITS = {
  'max-input-rows': 200000,
  'max-join-rows': 200000,
  'max-output-rows': 100000,
  'max-joins': 4,
  'max-operations': 5000000,
  'max-duration-ms': 60000
};

/** Rows processed between cancellation checkpoints inside a join. */
const CANCELLATION_CHECK_INTERVAL = 4096;

/**
 * @typedef {ReturnType<typeof createDashboardQueryBudget>} QueryBudget
 */

/**
 * Raised when execution stops before it finished, either because the caller
 * aborted it, the deadline elapsed, or the operation budget was exhausted.
 * It is distinct from a query fault: no partial result is reported.
 */
export class DashboardQueryCancelledError extends Error {
  /** @param {string} message @param {'aborted'|'timeout'|'budget'} kind */
  constructor(message, kind) {
    super(message);
    this.name = 'DashboardQueryCancelledError';
    this.kind = kind;
  }
}

/**
 * Bounds one execution by wall-clock time, by the number of row operations it
 * performs, and by an external abort signal. Every bound is checked at the
 * same checkpoints, so a runaway computation stops on whichever bound it
 * reaches first.
 *
 * @param {{ signal?: { aborted?: boolean, reason?: unknown }, timeout?: number, maxOperations?: number, now?: () => number }} [options]
 */
export function createDashboardQueryBudget(options = {}) {
  const timeout = Number.isFinite(options.timeout) && Number(options.timeout) > 0
    ? Number(options.timeout)
    : DASHBOARD_QUERY_LIMITS['max-duration-ms'];
  const maxOperations = Number.isFinite(options.maxOperations) && Number(options.maxOperations) > 0
    ? Number(options.maxOperations)
    : DASHBOARD_QUERY_LIMITS['max-operations'];
  const now = options.now ?? (() => Date.now());
  const startedAt = now();
  let operations = 0;
  return {
    get operations() {
      return operations;
    },
    /**
     * Records row operations and stops execution when the budget is spent.
     * @param {number} count
     */
    spend(count) {
      operations += Math.max(0, count);
      if (operations > maxOperations) {
        throw new DashboardQueryCancelledError(
          `dashboard queries exceeded the max-operations budget of ${maxOperations}`,
          'budget'
        );
      }
      this.checkpoint();
    },
    /** Stops execution when the caller aborted it or the deadline elapsed. */
    checkpoint() {
      if (options.signal?.aborted) {
        throw new DashboardQueryCancelledError('dashboard queries were cancelled', 'aborted');
      }
      if (now() - startedAt > timeout) {
        throw new DashboardQueryCancelledError(
          `dashboard queries exceeded the max-duration-ms limit of ${timeout}`,
          'timeout'
        );
      }
    }
  };
}

/** Supported join types. */
export const DASHBOARD_QUERY_JOIN_TYPES = ['inner', 'left'];

/**
 * Indexes declared queries by name, preserving declaration order.
 * @param {unknown} definitions
 * @returns {Map<string, DashboardQuery>}
 */
export function dashboardQueryIndex(definitions) {
  /** @type {Map<string, DashboardQuery>} */
  const index = new Map();
  if (!Array.isArray(definitions)) return index;
  for (const definition of definitions) {
    if (!isPlainObject(definition) || typeof definition.name !== 'string') continue;
    if (index.has(definition.name)) continue;
    index.set(definition.name, /** @type {DashboardQuery} */ (definition));
  }
  return index;
}

/**
 * Detects the query patterns that cannot be executed safely, so they fail
 * closed before any rows are read instead of looping, expanding without
 * bound, or resolving to an arbitrary definition.
 *
 * Detected patterns are cyclic dependencies (including self-reference),
 * dependencies declared after the consuming query, duplicate query names,
 * unbounded keyless joins, excessive join chains, and out-of-range limits.
 *
 * @param {unknown} definitions
 * @returns {Map<string, string>} query name to the reason it is rejected
 */
export function dashboardQueryDefects(definitions) {
  /** @type {Map<string, string>} */
  const defects = new Map();
  const list = Array.isArray(definitions) ? definitions : [];
  const index = dashboardQueryIndex(definitions);

  /** @type {Set<string>} */
  const seen = new Set();
  for (const definition of list) {
    if (!isPlainObject(definition) || typeof definition.name !== 'string') continue;
    if (seen.has(definition.name)) {
      defects.set(definition.name, `query name "${definition.name}" is declared more than once`);
    }
    seen.add(definition.name);
  }

  /** @type {Set<string>} */
  const available = new Set();
  for (const [name, definition] of index) {
    for (const input of queryInputNames(definition)) {
      if (!index.has(input) || available.has(input)) continue;
      defects.set(name, input === name
        ? `query "${name}" reads itself`
        : reachesQuery(index, input, name)
          ? `query "${name}" and input source "${input}" form a dependency cycle`
          : `input source "${input}" is declared after "${name}"`);
      break;
    }
    available.add(name);
    const structural = queryStructuralDefect(definition);
    if (structural && !defects.has(name)) defects.set(name, structural);
  }

  let propagated = true;
  while (propagated) {
    propagated = false;
    for (const [name, definition] of index) {
      if (defects.has(name)) continue;
      const rejected = queryInputNames(definition).find((input) => defects.has(input));
      if (!rejected) continue;
      defects.set(name, `input source "${rejected}" is a rejected query`);
      propagated = true;
    }
  }
  return defects;
}

/**
 * Rejects the query shapes whose cost is unbounded or undefined regardless of
 * the rows they read.
 * @param {DashboardQuery} definition
 * @returns {string | undefined}
 */
function queryStructuralDefect(definition) {
  const joins = definition.joins ?? [];
  if (joins.length > DASHBOARD_QUERY_LIMITS['max-joins']) {
    return `joins exceed the max-joins limit of ${DASHBOARD_QUERY_LIMITS['max-joins']}`;
  }
  for (const join of joins) {
    if (!Array.isArray(join?.on) || join.on.length === 0) {
      return `join on "${String(join?.source)}" declares no equality keys`;
    }
  }
  if (definition.limit !== undefined
      && (!Number.isSafeInteger(definition.limit)
        || Number(definition.limit) <= 0
        || Number(definition.limit) > DASHBOARD_QUERY_LIMITS['max-output-rows'])) {
    return `limit must be a positive integer no greater than ${DASHBOARD_QUERY_LIMITS['max-output-rows']}`;
  }
  return undefined;
}

/**
 * @param {Map<string, DashboardQuery>} index
 * @param {string} from
 * @param {string} target
 * @returns {boolean} whether `target` is reachable from `from`
 */
function reachesQuery(index, from, target) {
  /** @type {Set<string>} */
  const visited = new Set();
  /** @type {string[]} */
  const pending = [from];
  while (pending.length > 0) {
    const name = /** @type {string} */ (pending.shift());
    if (name === target) return true;
    if (visited.has(name)) continue;
    visited.add(name);
    pending.push(...queryInputNames(index.get(name)));
  }
  return false;
}

/**
 * Resolves the query dependency graph so every input source required by the
 * requested sources is loaded and unrelated sources stay excluded.
 * @param {unknown} definitions
 * @param {Iterable<string>} requested
 * @returns {string[]} requested names plus every transitively required source
 */
export function resolveDashboardQuerySources(definitions, requested) {
  const index = dashboardQueryIndex(definitions);
  /** @type {Set<string>} */
  const resolved = new Set();
  /** @type {string[]} */
  const pending = [...requested];
  while (pending.length > 0) {
    const name = /** @type {string} */ (pending.shift());
    if (resolved.has(name)) continue;
    resolved.add(name);
    for (const input of queryInputNames(index.get(name))) {
      if (!resolved.has(input)) pending.push(input);
    }
  }
  return [...resolved];
}

/**
 * @param {DashboardQuery | undefined} definition
 * @returns {string[]}
 */
export function queryInputNames(definition) {
  if (!definition) return [];
  const joins = Array.isArray(definition.joins) ? definition.joins : [];
  return [definition.from, ...joins.map((join) => join.source)].filter((name) => typeof name === 'string');
}

/**
 * Derives the static output field schema of a query so encodings, filters,
 * and `order-by` references can be validated before execution.
 * @param {DashboardQuery} definition
 * @param {(source: string) => string[] | undefined} fieldsOf
 * @returns {string[] | undefined} undefined when an input schema is unknown
 */
export function dashboardQueryOutputFields(definition, fieldsOf) {
  const inputFields = fieldsOf(definition.from);
  if (!inputFields) return undefined;
  /** @type {string[]} */
  let fields = [...inputFields];
  for (const join of definition.joins ?? []) {
    for (const field of join.fields ?? []) fields.push(field.as);
  }
  for (const computed of definition.compute ?? []) fields.push(computed.as);
  if (definition.aggregate) {
    fields = [...(definition.aggregate.by ?? []), ...definition.aggregate.values.map((value) => value.as)];
  }
  if (definition.select) {
    fields = definition.select.map((field) => field.as ?? field.field);
  }
  return [...new Set(fields)];
}

/**
 * Executes declared queries against already loaded logical sources.
 * Queries are executed in declaration order so a query may consume an
 * earlier query's output.
 *
 * @param {unknown} definitions
 * @param {Record<string, LogicalSourceInput>} sources
 * @param {Iterable<string>} [requested] only these queries are executed when provided
 * @param {{ signal?: { aborted?: boolean }, timeout?: number, maxOperations?: number, budget?: QueryBudget }} [options]
 * @returns {Record<string, LogicalSourceInput>}
 */
export function executeDashboardQueries(definitions, sources, requested, options = {}) {
  const index = dashboardQueryIndex(definitions);
  if (index.size === 0) return {};
  const defects = dashboardQueryDefects(definitions);
  const wanted = requested ? new Set(resolveDashboardQuerySources(definitions, requested)) : null;
  const budget = options.budget ?? createDashboardQueryBudget(options);
  /** @type {Record<string, LogicalSourceInput>} */
  const derived = {};
  for (const [name, definition] of index) {
    if (wanted && !wanted.has(name)) continue;
    budget.checkpoint();
    derived[name] = executeDashboardQuery(definition, { ...sources, ...derived }, defects.get(name), budget);
  }
  return derived;
}

/**
 * @param {DashboardQuery} definition
 * @param {Record<string, LogicalSourceInput>} sources
 * @param {string} [defect] a rejected query pattern detected before execution
 * @param {QueryBudget} [budget] shared cancellation, deadline, and operation budget
 * @returns {LogicalSourceInput}
 */
export function executeDashboardQuery(definition, sources, defect, budget = createDashboardQueryBudget()) {
  const inputs = queryInputNames(definition).map((name) => ({ name, source: sources[name] }));
  const rejected = defect ?? queryStructuralDefect(definition);
  if (rejected) {
    return unavailableResult(definition, composedMetadata(definition.name, inputs, 0), rejected);
  }
  const unavailable = inputs.find((input) => !input.source || !Array.isArray(input.source.rows));
  if (unavailable) {
    return unavailableResult(definition, composedMetadata(definition.name, inputs, 0), `input source "${unavailable.name}" is unavailable`);
  }
  if (inputs.some((input) => input.source?.metadata?.availability === 'unavailable')) {
    return unavailableResult(
      definition,
      composedMetadata(definition.name, inputs, 0),
      `input source "${inputs.find((input) => input.source?.metadata?.availability === 'unavailable')?.name}" is unavailable`
    );
  }
  try {
    const rows = runDashboardQuery(definition, sources, budget);
    return { source: definition.name, rows, metadata: composedMetadata(definition.name, inputs, rows.length) };
  } catch (error) {
    if (error instanceof DashboardQueryCancelledError) throw error;
    return unavailableResult(
      definition,
      composedMetadata(definition.name, inputs, 0),
      error instanceof Error ? error.message : String(error)
    );
  }
}

/**
 * @param {DashboardQuery} definition
 * @param {Record<string, LogicalSourceInput>} sources
 * @param {QueryBudget} budget
 * @returns {Row[]}
 */
function runDashboardQuery(definition, sources, budget) {
  const input = /** @type {Row[]} */ (sources[definition.from].rows);
  enforceLimit(input.length, 'max-input-rows', definition.from);
  budget.spend(input.length);
  let rows = input.map((row) => ({ ...row }));
  for (const join of definition.joins ?? []) {
    rows = applyJoin(rows, join, /** @type {Row[]} */ (sources[join.source].rows), join.source, budget);
  }
  const operators = compileRowOperators(definition);
  budget.spend(rows.length * Math.max(1, operators.length));
  rows = tidy(rows, operators);
  enforceLimit(rows.length, 'max-output-rows', definition.name);
  return rows;
}

/**
 * Compiles the post-join clauses into serializable row operators.
 * @param {DashboardQuery} definition
 * @returns {import('../../data-operations.js').DataOperator[]}
 */
export function compileRowOperators(definition) {
  /** @type {import('../../data-operations.js').DataOperator[]} */
  const operators = [];
  if (definition.filter?.predicates?.length) {
    operators.push({ op: 'filter', predicates: definition.filter.predicates });
  }
  if (definition.compute?.length) operators.push({ op: 'compute', values: definition.compute });
  if (definition.aggregate) {
    operators.push({ op: 'summarize', by: definition.aggregate.by ?? [], values: definition.aggregate.values });
  }
  if (definition.select?.length) operators.push({ op: 'select', fields: definition.select });
  if (definition['order-by']?.length) operators.push({ op: 'arrange', by: definition['order-by'] });
  if (typeof definition.limit === 'number') operators.push({ op: 'slice', limit: definition.limit });
  return operators;
}

/**
 * Applies one constrained equality join. The joined source must contain at
 * most one row per join key, so many-to-many expansion is rejected instead of
 * silently multiplying rows.
 *
 * @param {Row[]} rows
 * @param {NonNullable<DashboardQuery['joins']>[number]} join
 * @param {Row[]} joinedRows
 * @param {string} sourceName
 * @param {QueryBudget} budget
 * @returns {Row[]}
 */
function applyJoin(rows, join, joinedRows, sourceName, budget) {
  enforceLimit(joinedRows.length, 'max-input-rows', sourceName);
  budget.spend(joinedRows.length);
  /** @type {Map<string, Row>} */
  const byKey = new Map();
  for (const row of joinedRows) {
    const key = joinKey(row, join.on.map((pair) => pair.right));
    if (key === null) continue;
    if (byKey.has(key)) {
      throw new Error(`joined source "${sourceName}" contains more than one row per join key`);
    }
    byKey.set(key, row);
  }
  const type = join.type ?? 'inner';
  /** @type {Row[]} */
  const joined = [];
  for (const row of rows) {
    if (joined.length % CANCELLATION_CHECK_INTERVAL === 0) budget.checkpoint();
    const key = joinKey(row, join.on.map((pair) => pair.left));
    const match = key === null ? undefined : byKey.get(key);
    if (!match && type === 'inner') continue;
    joined.push({
      ...row,
      ...Object.fromEntries(join.fields.map((field) => [field.as, match?.[field.field] ?? null]))
    });
  }
  enforceLimit(joined.length, 'max-join-rows', sourceName);
  budget.spend(joined.length);
  return joined;
}

/**
 * Null, missing, and blank key parts never match, so a `left` join keeps the
 * row with null joined fields and an `inner` join drops it.
 * @param {Row} row
 * @param {string[]} fields
 * @returns {string | null}
 */
function joinKey(row, fields) {
  /** @type {string[]} */
  const parts = [];
  for (const field of fields) {
    const value = row[field];
    if (value === null || value === undefined || typeof value === 'object') return null;
    const text = String(value).trim();
    if (text === '') return null;
    parts.push(text);
  }
  return JSON.stringify(parts);
}

/**
 * @param {number} count
 * @param {keyof typeof DASHBOARD_QUERY_LIMITS} limit
 * @param {string} subject
 */
function enforceLimit(count, limit, subject) {
  if (count > DASHBOARD_QUERY_LIMITS[limit]) {
    throw new Error(`"${subject}" exceeds the ${limit} limit of ${DASHBOARD_QUERY_LIMITS[limit]} rows`);
  }
}

/**
 * Composes provenance, freshness, completeness, and availability across every
 * input source. The weakest input state wins.
 * @param {string} name
 * @param {Array<{ name: string, source?: LogicalSourceInput }>} inputs
 * @param {number} rowCount
 * @returns {SourceMetadata}
 */
function composedMetadata(name, inputs, rowCount) {
  const metadata = inputs.map((input) => input.source?.metadata).filter(Boolean);
  /** @param {'as-of'|'retrieved-at'} field */
  const oldest = (field) => metadata
    .map((value) => value?.[field])
    .filter((value) => typeof value === 'string' && Number.isFinite(Date.parse(value)))
    .sort((left, right) => Date.parse(/** @type {string} */ (left)) - Date.parse(/** @type {string} */ (right)))[0];
  const complete = metadata.length === inputs.length && metadata.length > 0;
  return {
    'source-id': `${name}-query`,
    'source-kind': 'derived',
    'as-of': /** @type {string} */ (oldest('as-of')) ?? new Date(0).toISOString(),
    'retrieved-at': /** @type {string} */ (oldest('retrieved-at')) ?? new Date(0).toISOString(),
    completeness: !complete || metadata.some((value) => value?.completeness !== 'complete')
      ? (metadata.some((value) => value?.completeness === 'partial') ? 'partial' : 'unknown')
      : 'complete',
    freshness: metadata.some((value) => value?.freshness === 'stale')
      ? 'stale'
      : complete && metadata.every((value) => value?.freshness === 'fresh')
        ? 'fresh'
        : 'unknown',
    availability: !complete || metadata.some((value) => value?.availability === 'unavailable')
      ? 'unavailable'
      : rowCount > 0 ? 'available' : 'empty',
    'query-name': name
  };
}

/**
 * Query diagnostics identify the dashboard path and the failing clause without
 * exposing source payloads or secrets.
 * @param {DashboardQuery} definition
 * @param {SourceMetadata} metadata
 * @param {string} reason
 * @returns {LogicalSourceInput}
 */
function unavailableResult(definition, metadata, reason) {
  return {
    source: definition.name,
    rows: [],
    metadata: {
      ...metadata,
      completeness: 'unknown',
      freshness: 'unknown',
      availability: 'unavailable',
      'query-diagnostic': `$.dashboard.queries[${definition.name}]: ${reason}.`
    }
  };
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
