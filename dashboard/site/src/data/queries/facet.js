import { MAX_CHART_FACETS } from '../../chart-facet.js';

/**
 * @typedef {{ field?: string, row?: string, column?: string, as: string }} FacetDefinition
 */

/** @param {unknown} value @returns {value is FacetDefinition} */
export function validFacetDefinition(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const facet = /** @type {Record<string, unknown>} */ (value);
  return Object.keys(facet).every((key) => ['field', 'row', 'column', 'as'].includes(key))
    && typeof facet.as === 'string' && facet.as.trim().length > 0
    && !['facet-field', 'facet-row', 'facet-column', 'facet-row-index', 'facet-column-index'].includes(facet.as)
    && (facet.field !== undefined
      ? facet.row === undefined && facet.column === undefined && typeof facet.field === 'string' && facet.field.length > 0
      : (facet.row !== undefined || facet.column !== undefined)
        && [facet.row, facet.column].every((field) => field === undefined || typeof field === 'string' && field.length > 0));
}

/**
 * Terminal query projection: partitions already processed rows in first-appearance
 * order, preserving raw category identity independently from formatted headers.
 * @param {Array<Record<string, unknown>>} rows
 * @param {FacetDefinition} definition
 */
export function partitionFacetRows(rows, definition) {
  /** @type {Map<string, Record<string, unknown>>} */
  const panels = new Map();
  /** @type {Map<string, number>} */
  const rowIndices = new Map();
  /** @type {Map<string, number>} */
  const columnIndices = new Map();
  /** @param {Record<string, unknown>} row @param {string | undefined} field */
  const category = (row, field) => {
    if (!field) return null;
    const value = row[field] ?? null;
    if (value !== null && (!['string', 'number', 'boolean'].includes(typeof value)
      || typeof value === 'number' && !Number.isFinite(value))) {
      throw new TypeError('Facet categories must be scalar values.');
    }
    return value;
  };
  /** @param {Map<string, number>} indices @param {unknown} value */
  const indexOf = (indices, value) => {
    const key = JSON.stringify(value);
    if (!indices.has(key)) indices.set(key, indices.size);
    return indices.get(key);
  };
  for (const row of rows) {
    const field = category(row, definition.field);
    const rowValue = category(row, definition.row);
    const column = category(row, definition.column);
    const key = JSON.stringify([field, rowValue, column]);
    let panel = panels.get(key);
    if (!panel) {
      if (panels.size >= MAX_CHART_FACETS) throw new RangeError(`Facet result exceeds ${MAX_CHART_FACETS} panels.`);
      panel = {
        'facet-field': field,
        'facet-row': rowValue,
        'facet-column': column,
        'facet-row-index': indexOf(rowIndices, rowValue),
        'facet-column-index': indexOf(columnIndices, column),
        [definition.as]: []
      };
      panels.set(key, panel);
    }
    /** @type {Array<Record<string, unknown>>} */ (panel[definition.as]).push(row);
  }
  return [...panels.values()];
}
