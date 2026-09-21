import mappings from './ingestion.json' with { type: 'json' };
import { DASHBOARD_QUERY_LIMITS, executeDashboardQueries } from './declarative.js';
import { requiredString } from '../model/schema.js';

const SOURCE = 'dashboard-sources';

/**
 * @typedef {{ field?: string, fields?: string[], default?: unknown, trim?: boolean,
 *   omitEmpty?: boolean, equals?: unknown, notEquals?: unknown,
 *   nonnegativeInteger?: boolean }} FieldMapping
 */

/** @param {unknown} value */
function sourceDocument(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { rows: [], metadata: {} };
  const source = /** @type {{ rows?: unknown, metadata?: unknown }} */ (value);
  return {
    rows: Array.isArray(source.rows) ? source.rows : [],
    metadata: source.metadata && typeof source.metadata === 'object' && !Array.isArray(source.metadata)
      ? /** @type {Record<string, unknown>} */ (source.metadata)
      : {}
  };
}

/**
 * Makes source metadata available to declarative queries without interpreting
 * any source-specific fields.
 *
 * @param {Record<string, unknown>} sources
 * @returns {Record<string, import('../../presenter.js').LogicalSourceInput>}
 */
function queryInputs(sources) {
  return /** @type {Record<string, import('../../presenter.js').LogicalSourceInput>} */ (Object.fromEntries(mappings.inputs.map((input) => {
    const sourceName = input.sources.find((name) => Object.hasOwn(sources, name));
    const document = sourceDocument(sourceName ? sources[sourceName] : undefined);
    const observedAt = document.metadata['as-of'] ?? document.metadata['retrieved-at'];
    return [input.name, {
      source: input.name,
      metadata: document.metadata,
      rows: document.rows
        .filter((row) => row && typeof row === 'object' && !Array.isArray(row))
        .map((row) => ({ ...row, '__source-observed-at': observedAt }))
    }];
  })));
}

/** @param {Record<string, unknown>} row @param {FieldMapping} mapping */
function mappedValue(row, mapping) {
  const fields = mapping.fields ?? (mapping.field ? [mapping.field] : []);
  /** @type {unknown} */
  let value = fields.map((field) => row[field]).find((candidate) => candidate !== undefined && candidate !== null);
  if (value === undefined || value === null) value = mapping.default;
  if (mapping.trim && value !== undefined && value !== null) value = String(value).trim();
  if (value === '' && mapping.default !== undefined) value = mapping.default;
  if (mapping.omitEmpty && value === '') return undefined;
  if (Object.hasOwn(mapping, 'equals')) return value === mapping.equals;
  if (Object.hasOwn(mapping, 'notEquals')) return value !== mapping.notEquals;
  if (mapping.nonnegativeInteger) {
    const number = Number(value);
    return Number.isInteger(number) && number >= 0 ? number : undefined;
  }
  return value;
}

/**
 * Converts published source documents into source-neutral observations by
 * executing the checked-in declarative query and field mappings.
 *
 * @param {Record<string, unknown>} sources
 * @returns {{ observations: import('../model/schema.js').CanonicalObservation[] }}
 */
export function queryDashboardSourceObservations(sources) {
  const inputs = queryInputs(sources);
  const observations = mappings.observations.flatMap((mapping) => {
    const input = inputs[mapping.input];
    if (input.metadata.availability === 'unavailable') {
      throw new Error(typeof input.metadata.error === 'string'
        ? input.metadata.error
        : `${mapping.input} is unavailable`);
    }
    const chunkSize = DASHBOARD_QUERY_LIMITS['max-output-rows'];
    /**
     * @param {import('../../presenter.js').LogicalSourceInput} source
     * @param {boolean} includeEmpty
     */
    const chunks = (source, includeEmpty = false) => source.rows.length > chunkSize
      ? Array.from(
          { length: Math.ceil(source.rows.length / chunkSize) },
          (_, index) => source.rows.slice(index * chunkSize, (index + 1) * chunkSize)
        )
      : source.rows.length > 0 || includeEmpty ? [source.rows] : [];
    let executions = chunks(input, true).map((rows) => ({
      ...inputs,
      [mapping.input]: { ...input, rows }
    }));
    for (const sourceName of mapping.chunkInputs ?? []) {
      const source = inputs[sourceName];
      executions = executions.flatMap((execution) => chunks(source).map((rows) => ({
        ...execution,
        [sourceName]: { ...source, rows }
      })));
    }
    const results = executions.map((execution) => executeDashboardQueries(
      mappings.queries,
      execution,
      [mapping.query]
    )[mapping.query]);
    const failed = results.find((result) => result.metadata.availability === 'unavailable');
    if (failed) throw new Error(requiredString(failed.metadata.error, `${mapping.query} query error`));
    const rows = results.flatMap((result) => result.rows);
    if (mapping.publishAs) {
      inputs[mapping.publishAs] = {
        ...(results[0] ?? input),
        source: mapping.publishAs,
        rows
      };
    }
    return rows.map((row) => {
      const sourceId = requiredString(row[mapping.sourceId], `${mapping.kind}.source-id`);
      const observedAt = requiredString(row[mapping.observedAt], `${mapping.kind}.observed-at`);
      for (const field of mapping.required) requiredString(row[field], `${mapping.kind}.${field}`);
      return {
        kind: /** @type {import('../model/schema.js').EntityKind} */ (mapping.kind),
        source: SOURCE,
        sourceId,
        observedAt,
        data: Object.fromEntries(Object.entries(
          Object.keys(mapping.data).length === 0 ? mappings.runLinkedData : mapping.data
        )
          .map(([name, definition]) => [name, mappedValue(row, /** @type {FieldMapping} */ (definition))])
          .filter(([, value]) => value !== undefined))
      };
    });
  });
  return { observations };
}
