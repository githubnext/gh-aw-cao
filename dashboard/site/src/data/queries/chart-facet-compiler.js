import { chartFacet } from '../../chart-facet.js';

/**
 * Compiles chart encoding aggregation before the terminal facet projection.
 * The input query retains its own processing; view order and limit apply to
 * resulting chart rows globally, not separately to each panel.
 * @param {Record<string, unknown>} view
 * @param {Record<string, unknown>} query
 * @returns {Array<Record<string, unknown>>}
 */
export function compileChartFacetQuery(view, query) {
  const facet = chartFacet(view);
  if (!facet) return [query];
  const encoding = mapping(view.encoding) ? view.encoding : {};
  const definitions = Object.entries(encoding).flatMap(([channel, value]) => {
    if (['facet', 'row', 'column', 'actions'].includes(channel)) return [];
    return (Array.isArray(value) ? value : [value]).filter(mapping);
  });
  const facetFields = Object.values(facet).map((definition) => String(definition.field));
  const aggregates = definitions.filter((definition) => typeof definition.aggregate === 'string' && definition.aggregate !== 'none');
  const inputName = `${query.name}:facet-input`;
  /** @type {Record<string, unknown>} */
  const prepared = { name: `${query.name}:facet-rows`, from: inputName };
  if (mapping(encoding.x) && typeof encoding.x['time-unit'] === 'string') {
    prepared.compute = [{
      as: encoding.x.field,
      function: 'date-bucket',
      args: [{ field: encoding.x.field }, { value: encoding.x['time-unit'] }]
    }];
  }
  if (aggregates.length > 0) {
    const dimensions = definitions.filter((definition) => definition.aggregate === undefined || definition.aggregate === 'none');
    const href = mapping(encoding.href) ? encoding.href : null;
    prepared.aggregate = {
      by: [...new Set([...facetFields, ...dimensions.filter((definition) => definition !== href).map((definition) => definition.field)])],
      values: [
        ...aggregates.map((definition) => ({
          field: definition.field,
          as: definition.as ?? `${definition.aggregate}-${definition.field}`,
          reducer: definition.aggregate
        })),
        ...(href ? [{ field: href.field, as: href.field, reducer: 'unique' }] : [])
      ]
    };
  }
  const data = mapping(view.data) ? view.data : {};
  const declaredOrder = Array.isArray(data['order-by']) ? data['order-by'] : [];
  const orderedFields = new Set(declaredOrder.filter(mapping).map((clause) => clause.field));
  const dimensions = [
    encoding.x, ...(Array.isArray(encoding.y) ? encoding.y : [encoding.y]),
    encoding.color, encoding.section, ...(Array.isArray(encoding.columns) ? encoding.columns : []),
    ...Object.values(facet)
  ].filter(mapping).filter((definition) => definition.aggregate === undefined || definition.aggregate === 'none');
  prepared['order-by'] = [
    ...declaredOrder,
    ...dimensions.filter((definition) => {
      if (orderedFields.has(definition.field)) return false;
      orderedFields.add(definition.field);
      return true;
    }).map((definition) => ({ field: definition.field }))
  ];
  if (Number.isSafeInteger(data.limit)) prepared.limit = data.limit;
  return [
    { ...query, name: inputName },
    prepared,
    {
      name: query.name,
      from: prepared.name,
      facet: {
        ...Object.fromEntries(Object.entries(facet).map(([channel, definition]) => [channel, definition.field])),
        as: 'facet-rows'
      }
    }
  ];
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function mapping(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
