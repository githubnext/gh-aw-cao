import { isPlainObject } from './validator-common.js';

// A document's declarations are accumulated in validation order and reset after validation.
export const state = {
  /** @type {Map<string, string[] | undefined>} */
  declaredQueries: new Map(),
  /** @type {Map<string, Map<string, string>>} */
  declaredQueryParameters: new Map(),
  /** @type {Set<string>} */
  declaredCardTemplates: new Set(),
  /** @type {Map<string, Record<string, unknown>>} */
  declaredViews: new Map(),
  /** @type {Map<string, Set<string>>} */
  declaredQueryTables: new Map(),
  /** @type {Map<string, Record<string, unknown>>} */
  declaredCliActions: new Map()
};

/** @param {unknown} page */
export function resolveReusablePageViews(page) {
  if (!isPlainObject(page)) return page;
  const definition = page.kind === 'built-in' && isPlainObject(page.definition)
    ? page.definition
    : null;
  const views = definition?.views ?? page.views;
  if (!Array.isArray(views)) return page;
  const resolvedViews = views.map((view) => typeof view === 'string' ? state.declaredViews.get(view) ?? view : view);
  return definition
    ? { ...page, definition: { ...definition, views: resolvedViews } }
    : { ...page, views: resolvedViews };
}
