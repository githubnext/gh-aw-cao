const FIELDS = ['intent', 'objective', 'acceptance'];

/**
 * Compose semantic annotations from named query dependencies and a view.
 * Query IDs are returned in dependency-first reference order, without duplicates.
 * @param {Record<string, unknown>} view
 * @param {Array<Record<string, unknown>>} queries
 * @returns {{ queryIds: string[], intent: string, objective: string, acceptance: string }}
 */
export function effectiveViewSemantics(view, queries) {
  const byName = new Map(queries
    .filter((query) => typeof query?.name === 'string')
    .map((query) => [query.name, query]));
  const visited = new Set();
  /** @type {Array<Record<string, unknown>>} */
  const referenced = [];
  /** @param {unknown} name */
  const visit = (name) => {
    if (typeof name !== 'string' || visited.has(name)) return;
    const query = byName.get(name);
    if (!query) return;
    visited.add(name);
    visit(query.from);
    if (Array.isArray(query.union)) query.union.forEach(visit);
    if (Array.isArray(query.joins)) query.joins.forEach((join) => visit(join?.source));
    referenced.push(query);
  };
  if (view.data && typeof view.data === 'object' && !Array.isArray(view.data)) {
    const data = /** @type {Record<string, unknown>} */ (view.data);
    visit(data.source);
    if (Array.isArray(data.sources)) data.sources.forEach(visit);
  }
  const annotations = [...referenced, view];
  return /** @type {{ queryIds: string[], intent: string, objective: string, acceptance: string }} */ ({
    queryIds: referenced.map((query) => String(query.name)),
    ...Object.fromEntries(FIELDS.map((field) => [field, annotations
      .map((item) => item[field])
      .filter((value) => typeof value === 'string' && value.trim())
      .join('\n\n')]))
  });
}
