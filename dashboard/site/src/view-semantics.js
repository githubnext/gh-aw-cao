import { createDebug } from './debug.js';

const FIELDS = ['subject', 'objective', 'acceptance'];

const debugViewSemantics = createDebug('view-semantics:resolve');

/**
 * Compose semantic annotations from named query dependencies and a view.
 * Query IDs are returned in dependency-first reference order, without duplicates.
 * @param {Record<string, unknown>} view
 * @param {Array<Record<string, unknown>>} queries
 * @returns {{ queryIds: string[], subject: string, objective: string, acceptance: string }}
 */
export function effectiveViewSemantics(view, queries) {
  const byName = new Map(queries
    .filter((query) => typeof query?.name === 'string')
    .map((query) => [query.name, query]));
  const visited = new Set();
  /** @type {Set<string>} */
  const missing = new Set();
  /** @type {Array<Record<string, unknown>>} */
  const referenced = [];
  /** @param {unknown} name */
  const visit = (name) => {
    if (typeof name !== 'string' || visited.has(name)) return;
    const query = byName.get(name);
    if (!query) {
      missing.add(name);
      return;
    }
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
  const result = /** @type {{ queryIds: string[], subject: string, objective: string, acceptance: string }} */ ({
    queryIds: referenced.map((query) => String(query.name)),
    ...Object.fromEntries(FIELDS.map((field) => [field, annotations
      .map((item) => item[field])
      .filter((value) => typeof value === 'string' && value.trim())
      .join('\n\n')]))
  });
  debugViewSemantics({
    viewId: typeof view?.id === 'string' ? view.id : 'unknown',
    resolvedQueryCount: referenced.length,
    missingQueryCount: missing.size,
    annotated: Boolean(result.subject && result.objective && result.acceptance)
  });
  return result;
}
