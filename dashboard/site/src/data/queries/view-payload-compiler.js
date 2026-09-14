/**
 * Compiles one page's authored view payload scope into deterministic,
 * worker-executed declarative queries.
 */

/**
 * @typedef {{
 *   filters?: Record<string, string[]>,
 *   timeWindow?: { start?: string, end?: string }
 * }} GlobalQueryContext
 */

/**
 * @param {string} pageId
 * @param {unknown} view
 * @param {number} viewIndex
 * @param {string} sourceName
 * @param {number} sourceIndex
 * @returns {string}
 */
export function dashboardViewAliasName(pageId, view, viewIndex, sourceName, sourceIndex = 0) {
  const candidate = isPlainObject(view) ? /** @type {Record<string, unknown>} */ (view) : {};
  const viewId = typeof candidate.id === 'string' && candidate.id.trim().length > 0
    ? candidate.id
    : `view-${viewIndex + 1}`;
  const qualifier = sourceIndex > 0 ? `-${sourceIndex + 1}` : '';
  return ['view', pageId, viewId, `${sourceName}${qualifier}`]
    .map(slug)
    .join(':');
}

/**
 * @param {unknown} page
 * @param {string} pageId
 * @param {{ routeParameters?: Record<string, string>, queryContext?: GlobalQueryContext, queries?: unknown }} [options]
 * @returns {{ aliases: string[], queries: Array<Record<string, unknown>>, replacedSources: string[] }}
 */
export function compileDashboardViewPayloadQueries(page, pageId, options = {}) {
  const payload = pagePayload(page);
  const views = Array.isArray(payload.views) ? payload.views : [];
  const routeParameterName = typeof payload.route?.['hash-query-parameter'] === 'string'
    ? payload.route['hash-query-parameter']
    : '';
  const routeValue = routeParameterName
    ? typeof options.routeParameters?.[routeParameterName] === 'string'
      ? options.routeParameters?.[routeParameterName]
      : ''
    : '';
  /** @type {string[]} */
  const aliases = [];
  /** @type {Array<Record<string, unknown>>} */
  const queries = [];
  const replacedSources = new Set();

  views.forEach((view, viewIndex) => {
    const sources = getViewSources(view);
    if (sources.length === 0) return;
    const viewData = isPlainObject(view) && isPlainObject(view.data)
      ? /** @type {Record<string, unknown>} */ (view.data)
      : null;
    const routeField = viewData && typeof viewData['route-field'] === 'string'
      ? viewData['route-field']
      : '';

    sources.forEach((sourceName, sourceIndex) => {
      const alias = dashboardViewAliasName(pageId, view, viewIndex, sourceName, sourceIndex);
      aliases.push(alias);
      const predicates = [
        ...compileScopePredicates(viewData?.scope),
        ...compileViewFilterPredicates(viewData?.filters),
        ...compileTimePredicates(viewData?.time),
        ...compileGlobalFilterPredicates(options.queryContext?.filters),
        ...compileTimePredicates(options.queryContext?.timeWindow),
        ...compileRoutePredicates(routeField, routeValue)
      ];
      const compiled = compileAliasedQuery(sourceName, alias, predicates, options.queries);
      queries.push(compiled.query);
      if (compiled.replacesSource) replacedSources.add(sourceName);
    });
  });

  return { aliases, queries, replacedSources: [...replacedSources] };
}

/**
 * @param {string} sourceName
 * @param {string} alias
 * @param {Array<Record<string, unknown>>} predicates
 * @param {unknown} definitions
 */
function compileAliasedQuery(sourceName, alias, predicates, definitions) {
  const declaredQueries = Array.isArray(definitions) ? definitions.filter(isPlainObject) : [];
  const declared = declaredQueries
    .find((definition) => definition.name === sourceName);
  const declaredNames = new Set(declaredQueries
    .map((definition) => definition.name)
    .filter((name) => typeof name === 'string'));
  const standalone = isPlainObject(declared)
    && typeof declared.from === 'string'
    && !declaredNames.has(declared.from)
    && (!Array.isArray(declared.joins) || declared.joins.every((join) => (
      isPlainObject(join) && typeof join.source === 'string' && !declaredNames.has(join.source)
    )));
  const sourceQuery = standalone
    ? /** @type {Record<string, unknown>} */ (declared)
    : undefined;
  const declaredFilter = sourceQuery && isPlainObject(sourceQuery.filter)
    ? /** @type {Record<string, unknown>} */ (sourceQuery.filter)
    : null;
  const declaredPredicates = declaredFilter && Array.isArray(declaredFilter.predicates)
    ? declaredFilter.predicates.filter(isPlainObject)
    : [];
  const combinedPredicates = [...declaredPredicates, ...predicates];
  return {
    replacesSource: Boolean(sourceQuery),
    query: sourceQuery
      ? {
        ...sourceQuery,
        name: alias,
        ...(combinedPredicates.length > 0 ? { filter: { predicates: combinedPredicates } } : { filter: undefined })
      }
      : {
        name: alias,
        from: sourceName,
        ...(combinedPredicates.length > 0 ? { filter: { predicates: combinedPredicates } } : {})
      }
  };
}

/** @param {unknown} scope */
function compileScopePredicates(scope) {
  if (!isPlainObject(scope)) return [];
  const configured = /** @type {Record<string, unknown>} */ (scope);
  const map = {
    organizations: 'organization',
    repositories: 'repository',
    workflows: 'workflow'
  };
  return Object.entries(map).flatMap(([scopeKey, field]) => {
    const values = asStringList(configured[scopeKey]);
    return values.length > 0 ? [{ field, in: values }] : [];
  });
}

/** @param {unknown} filters */
function compileViewFilterPredicates(filters) {
  if (!isPlainObject(filters)) return [];
  const configured = /** @type {Record<string, unknown>} */ (filters);
  /** @type {Array<Record<string, unknown>>} */
  const predicates = [];
  for (const [field, expected] of Object.entries(configured)) {
    const values = Array.isArray(expected) ? expected : undefined;
    if (values) {
      const list = values.filter((candidate) => candidate !== undefined);
      if (list.length > 0) predicates.push({ field, in: list });
    } else {
      predicates.push({ field, equals: expected });
    }
  }
  return predicates;
}

/** @param {unknown} filters */
function compileGlobalFilterPredicates(filters) {
  if (!isPlainObject(filters)) return [];
  return Object.entries(/** @type {Record<string, unknown>} */ (filters)).flatMap(([configuredField, values]) => {
    const list = asStringList(values);
    if (list.length === 0) return [];
    return [{
      field: configuredField === 'mode' ? 'rollout-mode' : configuredField,
      in: list,
      optional: true
    }];
  });
}

/** @param {unknown} time */
function compileTimePredicates(time) {
  if (!isPlainObject(time)) return [];
  const configured = /** @type {Record<string, unknown>} */ (time);
  const start = typeof configured.start === 'string' ? configured.start : '';
  const end = typeof configured.end === 'string' ? configured.end : '';
  /** @type {Array<Record<string, unknown>>} */
  const predicates = [];
  if (start) predicates.push({ field: '@time', gte: start });
  if (end) predicates.push({ field: '@time', lt: end });
  return predicates;
}

/** @param {string} routeField @param {string} routeValue */
function compileRoutePredicates(routeField, routeValue) {
  const value = routeValue.trim();
  if (!routeField || !value) return [];
  return [{ field: routeField, equals: value }];
}

/** @param {unknown} value */
function asStringList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item) => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim()))];
}

/** @param {unknown} page */
function pagePayload(page) {
  if (!isPlainObject(page)) return {};
  const configured = /** @type {Record<string, unknown>} */ (page);
  const builtInDefinition = configured.kind === 'built-in' && isPlainObject(configured.definition)
    ? /** @type {Record<string, unknown>} */ (configured.definition)
    : null;
  return {
    views: builtInDefinition?.views ?? (Array.isArray(configured.views) ? configured.views : []),
    route: isPlainObject(configured.route) ? configured.route : null
  };
}

/** @param {unknown} view @returns {string[]} */
function getViewSources(view) {
  if (!isPlainObject(view)) return [];
  const configured = /** @type {Record<string, unknown>} */ (view);
  if (!isPlainObject(configured.data)) return [];
  const data = /** @type {Record<string, unknown>} */ (configured.data);
  if (Array.isArray(data.sources)) {
    return data.sources.filter((source) => typeof source === 'string');
  }
  return typeof data.source === 'string' ? [data.source] : [];
}

/** @param {unknown} value */
function slug(value) {
  const text = String(value ?? '').trim().toLowerCase();
  const compact = text.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return compact.length > 0 ? compact : 'view';
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
