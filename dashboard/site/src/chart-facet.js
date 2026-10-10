/**
 * Shared declarative facet vocabulary. Partitioning belongs to the query engine.
 */

export const MAX_CHART_FACETS = 64;

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function mapping(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @param {Record<string, unknown>} view
 * @returns {{ field?: Record<string, unknown>, row?: Record<string, unknown>, column?: Record<string, unknown> } | null}
 */
export function chartFacet(view) {
  const encoding = mapping(view.encoding) ? view.encoding : {};
  const facet = view.facet ?? encoding.facet;
  if (mapping(facet)) {
    if (typeof facet.field === 'string') return { field: facet };
    return {
      ...(mapping(facet.row) ? { row: facet.row } : {}),
      ...(mapping(facet.column) ? { column: facet.column } : {})
    };
  }
  if (encoding.row !== undefined || encoding.column !== undefined) {
    return {
      ...(mapping(encoding.row) ? { row: encoding.row } : {}),
      ...(mapping(encoding.column) ? { column: encoding.column } : {})
    };
  }
  return null;
}

/**
 * Resolves aggregate output names for presentation, without querying rows.
 * @param {Record<string, unknown>} encoding
 */
export function facetPresentationEncoding(encoding) {
  /** @param {unknown} value @returns {unknown} */
  const resolve = (value) => {
    if (Array.isArray(value)) return value.map(resolve);
    if (!mapping(value)) return value;
    const { aggregate, as, ...definition } = value;
    return {
      ...definition,
      field: typeof aggregate === 'string' && aggregate !== 'none'
        ? typeof as === 'string' ? as : `${aggregate}-${value.field}`
        : value.field
    };
  };
  return Object.fromEntries(Object.entries(encoding)
    .filter(([channel]) => !['facet', 'row', 'column'].includes(channel))
    .map(([channel, definition]) => [channel, resolve(definition)]));
}
