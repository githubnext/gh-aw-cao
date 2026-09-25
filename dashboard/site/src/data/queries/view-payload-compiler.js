/**
 * Compiles one page's authored view payload scope into deterministic,
 * worker-executed declarative queries.
 */

/**
 * @typedef {{
 *   filters?: Record<string, string[]>,
 *   search?: { fields: string[], query: string },
 *   orderBy?: Array<{ field: string, direction?: 'asc'|'desc' }>,
 *   timeWindow?: { start?: string, end?: string },
 *   viewMode?: 'chart'|'table'|'card',
 *   formValues?: Record<string, string|number|boolean>
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
 * @param {{ routeParameters?: Record<string, string>, queryContext?: GlobalQueryContext, evaluatedAt?: string, queries?: unknown, views?: unknown, viewId?: string, sourceNames?: Iterable<string> }} [options]
 * @returns {{ aliases: string[], queries: Array<Record<string, unknown>>, replacedSources: string[] }}
 */
export function compileDashboardViewPayloadQueries(page, pageId, options = {}) {
  const payload = pagePayload(page, options.views);
  const formValues = {
    ...dashboardFormDefaultValues(payload.form),
    ...(options.queryContext?.formValues ?? {})
  };
  const resolvedQueries = resolveDashboardQueryParameters(options.queries, formValues);
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
  const requestedSources = options.sourceNames ? new Set(options.sourceNames) : null;

  views.forEach((view, viewIndex) => {
    if (options.viewId && (!isPlainObject(view) || view.id !== options.viewId)) return;
    if (options.queryContext?.viewMode && !viewMatchesMode(view, options.queryContext.viewMode)) return;
    const sources = getViewSources(view);
    if (sources.length === 0) return;
    const viewData = isPlainObject(view) && isPlainObject(view.data)
      ? /** @type {Record<string, unknown>} */ (view.data)
      : null;
    const routeField = viewData && typeof viewData['route-field'] === 'string'
      ? viewData['route-field']
      : '';

    sources.forEach((sourceName, sourceIndex) => {
      if (requestedSources && !requestedSources.has(sourceName)) return;
      const predicates = [
        ...compileScopePredicates(viewData?.scope),
        ...compileViewFilterPredicates(viewData?.filters),
        ...compileArgumentPredicates(viewData?.arguments, options.routeParameters),
        ...compileTimePredicates(viewData?.time),
        ...compileGlobalFilterPredicates(options.queryContext?.filters),
        ...compileTimePredicates(options.queryContext?.timeWindow),
        ...compileRoutePredicates(routeField, routeValue)
      ];
      if (usesNativeSource(view, sourceName, predicates, options.queryContext, resolvedQueries)) return;
      const alias = dashboardViewAliasName(pageId, view, viewIndex, sourceName, sourceIndex);
      aliases.push(alias);
      const compiled = compileAliasedQuery(sourceName, alias, predicates, options.queryContext?.search, options.queryContext?.orderBy, options.evaluatedAt, resolvedQueries);
      queries.push(...compiled.dependencies, compiled.query);
      if (compiled.replacesSource) replacedSources.add(sourceName);
    });
  });

  return { aliases, queries, replacedSources: [...replacedSources] };
}

/** @param {unknown} form */
export function dashboardFormDefaultValues(form) {
  if (!isPlainObject(form) || !Array.isArray(form.fields)) return {};
  /** @type {Array<[string, string|number|boolean]>} */
  const entries = form.fields.flatMap((field) => {
    if (!isPlainObject(field) || typeof field.id !== 'string') return [];
    const value = field.default;
    return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
      ? [[field.id, value]]
      : [];
  });
  return Object.fromEntries(entries);
}

/**
 * Resolves inert parameter references before query graph compilation. Query
 * structure remains authored and static; only scalar operands are substituted.
 * @param {unknown} definitions
 * @param {Record<string, string|number|boolean>} values
 */
export function resolveDashboardQueryParameters(definitions, values) {
  if (!Array.isArray(definitions)) return definitions;
  return definitions.map((definition) => {
    if (!isPlainObject(definition)) return definition;
    const declared = new Map(Array.isArray(definition.parameters)
      ? definition.parameters.flatMap((parameter) => (
          isPlainObject(parameter) && typeof parameter.name === 'string' && typeof parameter.type === 'string'
            ? [[parameter.name, parameter.type]]
            : []
        ))
      : []);
    /** @param {unknown} value @param {string} [containerKey] @returns {unknown} */
    const resolve = (value, containerKey) => {
      if (Array.isArray(value)) return value.map((item) => resolve(item, containerKey));
      if (!isPlainObject(value)) return value;
      if (Object.keys(value).length === 1 && typeof value.parameter === 'string') {
        const type = declared.get(value.parameter);
        if (!type) {
          throw new TypeError(`Query "${String(definition.name)}" references undeclared parameter "${value.parameter}".`);
        }
        const resolved = values[value.parameter];
        if (typeof resolved !== type || (type === 'number' && !Number.isFinite(resolved))) {
          throw new TypeError(`Query "${String(definition.name)}" requires form parameter "${value.parameter}".`);
        }
        return containerKey === 'args' ? { value: resolved } : resolved;
      }
      return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, resolve(nested, key)]));
    };
    return resolve(definition);
  });
}

/**
 * Leaves an unmodified database table on its native IndexedDB read path.
 * The presenter already resolves the source directly when no view alias exists.
 * @param {unknown} view
 * @param {string} sourceName
 * @param {Array<Record<string, unknown>>} predicates
 * @param {GlobalQueryContext | undefined} queryContext
 * @param {unknown} definitions
 */
function usesNativeSource(view, sourceName, predicates, queryContext, definitions) {
  const declared = Array.isArray(definitions)
    && definitions.some((definition) => isPlainObject(definition) && definition.name === sourceName);
  return isPlainObject(view)
    && view.mark === 'list'
    && view['lazy-list'] !== true
    && !declared
    && predicates.length === 0
    && !(queryContext?.search?.query.trim())
    && !(queryContext?.orderBy?.length);
}

/** @param {unknown} view @param {'chart'|'table'|'card'} mode */
function viewMatchesMode(view, mode) {
  if (!isPlainObject(view)) return mode === 'chart';
  if (view.disclosure === 'supplemental') return true;
  if (mode === 'table') return view.mark === 'table';
  if (mode === 'card') return view.mark === 'table' || view.mark === 'list';
  return view.mark !== 'table' && view.mark !== 'list';
}

/**
 * @param {string} sourceName
 * @param {string} alias
 * @param {Array<Record<string, unknown>>} predicates
 * @param {GlobalQueryContext['search']} search
 * @param {GlobalQueryContext['orderBy']} orderBy
 * @param {string | undefined} evaluatedAt
 * @param {unknown} definitions
 */
function compileAliasedQuery(sourceName, alias, predicates, search, orderBy, evaluatedAt, definitions) {
  const declaredQueries = Array.isArray(definitions) ? definitions.filter(isPlainObject) : [];
  const declared = declaredQueries
    .find((definition) => definition.name === sourceName);
  const declaredNames = new Set(declaredQueries
    .map((definition) => definition.name)
    .filter((name) => typeof name === 'string'));
  const standalone = isPlainObject(declared)
    && typeof declared.from === 'string'
    && !declaredNames.has(declared.from)
    && (!Array.isArray(declared.union) || declared.union.every((source) => (
      typeof source === 'string' && !declaredNames.has(source)
    )))
    && (!Array.isArray(declared.joins) || declared.joins.every((join) => (
      isPlainObject(join) && typeof join.source === 'string' && !declaredNames.has(join.source)
    )));
  const postQueryFields = isPlainObject(declared) ? derivedOutputFields(declared) : new Set();
  const requiresOutputFilter = predicates.some((predicate) => (
    typeof predicate.field === 'string' && postQueryFields.has(predicate.field)
  ));
  if (isPlainObject(declared) && standalone && requiresOutputFilter) {
    return compileStandaloneOutputScopedQuery(
      declared,
      alias,
      predicates,
      postQueryFields,
      search,
      orderBy,
      evaluatedAt
    );
  }
  if (isPlainObject(declared) && !standalone) {
    return compileScopedQueryGraph(
      sourceName,
      alias,
      predicates,
      search,
      orderBy,
      evaluatedAt,
      declaredQueries
    );
  }

  /**
   * @param {Record<string, unknown>} definition
   * @param {string} alias
   * @param {Array<Record<string, unknown>>} predicates
   * @param {Set<unknown>} postQueryFields
   * @param {GlobalQueryContext['search']} search
   * @param {GlobalQueryContext['orderBy']} orderBy
   * @param {string | undefined} evaluatedAt
   */
  function compileStandaloneOutputScopedQuery(definition, alias, predicates, postQueryFields, search, orderBy, evaluatedAt) {
    const rootName = `${alias}:root`;
    const declaredFilter = isPlainObject(definition.filter) ? definition.filter : null;
    const declaredPredicates = declaredFilter && Array.isArray(declaredFilter.predicates)
      ? declaredFilter.predicates.filter(isPlainObject)
      : [];
    const preQueryPredicates = predicates.filter((predicate) => (
      predicate.field === '@time' || !postQueryFields.has(predicate.field)
    ));
    const rootPredicates = applyQueryTime(
      [...declaredPredicates, ...preQueryPredicates],
      definition.time,
      evaluatedAt
    );
    const root = resolveQueryContext({
      ...definition,
      name: rootName,
      'order-by': undefined,
      limit: undefined,
      ...(rootPredicates.length > 0 ? { filter: { predicates: rootPredicates } } : { filter: undefined })
    }, queryTimeEnd(rootPredicates) ?? evaluatedAt);
    const outputPredicates = predicates.filter((predicate) => (
      predicate.field !== '@time' && postQueryFields.has(predicate.field)
    ));
    const runtimeSearch = search && search.query.trim() && search.fields.length > 0
      ? { fields: search.fields, query: search.query.trim() }
      : undefined;
    const filter = {
      ...(outputPredicates.length > 0 ? { predicates: outputPredicates } : {}),
      ...(runtimeSearch ? { search: runtimeSearch } : {})
    };
    const effectiveOrder = Array.isArray(orderBy) && orderBy.length > 0
      ? orderBy
      : Array.isArray(definition['order-by']) ? definition['order-by'] : undefined;
    return {
      replacesSource: true,
      dependencies: [root],
      query: {
        name: alias,
        from: rootName,
        ...(Object.keys(filter).length > 0 ? { filter } : {}),
        ...(effectiveOrder ? { 'order-by': effectiveOrder } : {}),
        ...(Number.isInteger(definition.limit) ? { limit: definition.limit } : {})
      }
    };
  }

  /** @param {Record<string, unknown>} query */
  function derivedOutputFields(query) {
    const fields = new Set();
    for (const clause of ['compute', 'predict']) {
      if (!Array.isArray(query[clause])) continue;
      for (const item of query[clause]) {
        if (isPlainObject(item) && typeof item.as === 'string') fields.add(item.as);
      }
    }
    if (isPlainObject(query.aggregate) && Array.isArray(query.aggregate.values)) {
      for (const item of query.aggregate.values) {
        if (isPlainObject(item) && typeof item.as === 'string') fields.add(item.as);
      }
    }
    if (Array.isArray(query.select)) {
      for (const item of query.select) {
        if (isPlainObject(item) && typeof item.as === 'string' && item.as !== item.field) fields.add(item.as);
      }
    }
    return fields;
  }
  const sourceQuery = standalone
    ? /** @type {Record<string, unknown>} */ (declared)
    : undefined;
  const declaredFilter = sourceQuery && isPlainObject(sourceQuery.filter)
    ? /** @type {Record<string, unknown>} */ (sourceQuery.filter)
    : null;
  const declaredPredicates = declaredFilter && Array.isArray(declaredFilter.predicates)
    ? declaredFilter.predicates.filter(isPlainObject)
    : [];
  const combinedPredicates = applyQueryTime(
    [...declaredPredicates, ...predicates],
    sourceQuery?.time,
    evaluatedAt
  );
  const executableSourceQuery = sourceQuery
    ? resolveQueryContext(sourceQuery, queryTimeEnd(combinedPredicates) ?? evaluatedAt)
    : undefined;
  const runtimeSearch = search && search.query.trim() && search.fields.length > 0
    ? { fields: search.fields, query: search.query.trim() }
    : undefined;
  const runtimeOrder = Array.isArray(orderBy) && orderBy.length > 0 ? orderBy : undefined;
  const filter = {
    ...(combinedPredicates.length > 0 ? { predicates: combinedPredicates } : {}),
    ...(runtimeSearch ? { search: runtimeSearch } : {})
  };
  return {
    replacesSource: Boolean(sourceQuery),
    dependencies: [],
    query: executableSourceQuery
      ? {
        ...executableSourceQuery,
        name: alias,
        ...(Object.keys(filter).length > 0 ? { filter } : { filter: undefined }),
        ...(runtimeOrder ? { 'order-by': runtimeOrder } : {})
      }
      : {
        name: alias,
        from: sourceName,
        ...(Object.keys(filter).length > 0 ? { filter } : {}),
        ...(runtimeOrder ? { 'order-by': runtimeOrder } : {})
      }
  };
}

/**
 * Clones a derived query graph so request-scoped time bounds reach source rows
 * before dependent aggregates execute.
 * @param {string} sourceName
 * @param {string} alias
 * @param {Array<Record<string, unknown>>} predicates
 * @param {GlobalQueryContext['search']} search
 * @param {GlobalQueryContext['orderBy']} orderBy
 * @param {string | undefined} evaluatedAt
 * @param {Array<Record<string, unknown>>} definitions
 */
function compileScopedQueryGraph(sourceName, alias, predicates, search, orderBy, evaluatedAt, definitions) {
  const byName = new Map(definitions
    .filter((definition) => typeof definition.name === 'string')
    .map((definition) => [/** @type {string} */ (definition.name), definition]));
  const structuralSources = new Set(['campaigns', 'repositories', 'workflows']);
  const rootComputedName = `${alias}:root`;
  /** @param {string} name */
  const scopedName = (name) => name === sourceName ? rootComputedName : `${alias}:dependency:${slug(name)}`;
  const temporalPredicates = predicates.filter((predicate) => predicate.field === '@time');
  /** @type {Array<Record<string, unknown>>} */
  const dependencies = [];
  const compiled = new Set();

  /**
   * @param {string} name
   * @returns {Record<string, unknown> | undefined}
   */
  const compile = (name) => {
    if (compiled.has(name)) return;
    const definition = byName.get(name);
    if (!definition) return;
    if (typeof definition.from !== 'string') {
      throw new TypeError(`Declared dashboard query "${name}" requires a source.`);
    }
    const from = definition.from;
    const dependencyNames = [
      from,
      ...(Array.isArray(definition.union) ? definition.union : []),
      ...(Array.isArray(definition.joins)
      ? definition.joins.flatMap((join) => (
          isPlainObject(join) && typeof join.source === 'string' ? [join.source] : []
        ))
      : [])
    ].filter((dependency) => byName.has(dependency));
    for (const dependency of dependencyNames) compile(dependency);

    const declaredFilter = isPlainObject(definition.filter) ? definition.filter : null;
    const declaredPredicates = declaredFilter && Array.isArray(declaredFilter.predicates)
      ? declaredFilter.predicates.filter(isPlainObject)
      : [];
    const requestPredicates = !byName.has(from) && !structuralSources.has(from)
      ? temporalPredicates
      : [];
    const combinedPredicates = applyQueryTime(
      [...declaredPredicates, ...requestPredicates],
      definition.time,
      evaluatedAt
    );
    const filter = combinedPredicates.length > 0 ? { predicates: combinedPredicates } : {};
    const query = resolveQueryContext({
      ...definition,
      name: scopedName(name),
      from: byName.has(from) ? scopedName(from) : from,
      ...(Array.isArray(definition.union) ? {
        union: definition.union.map((source) => (
          typeof source === 'string' && byName.has(source) ? scopedName(source) : source
        ))
      } : {}),
      ...(Array.isArray(definition.joins) ? {
        joins: definition.joins.map((join) => {
          if (!isPlainObject(join) || typeof join.source !== 'string' || !byName.has(join.source)) return join;
          return { ...join, source: scopedName(join.source) };
        })
      } : {}),
      ...(Object.keys(filter).length > 0 ? { filter } : { filter: undefined })
    }, queryTimeEnd(combinedPredicates) ?? evaluatedAt);
    compiled.add(name);
    dependencies.push(query);
    return query;
  };

  compile(sourceName);

  const requestPredicates = predicates.filter((predicate) => predicate.field !== '@time');
  const runtimeSearch = search && search.query.trim() && search.fields.length > 0
    ? { fields: search.fields, query: search.query.trim() }
    : undefined;
  const filter = {
    ...(requestPredicates.length > 0 ? { predicates: requestPredicates } : {}),
    ...(runtimeSearch ? { search: runtimeSearch } : {})
  };
  const query = {
    name: alias,
    from: rootComputedName,
    ...(Object.keys(filter).length > 0 ? { filter } : {}),
    ...(Array.isArray(orderBy) && orderBy.length > 0 ? { 'order-by': orderBy } : {})
  };
  return { replacesSource: true, dependencies, query };
}

/** @param {Array<Record<string, unknown>>} predicates @param {unknown} time @param {string | undefined} evaluatedAt */
function applyQueryTime(predicates, time, evaluatedAt) {
  if (!isPlainObject(time) || typeof time.range !== 'string') return predicates;
  const end = queryTimeEnd(predicates) ?? evaluatedAt;
  const match = /^([1-9][0-9]*)(h|d|w)$/.exec(time.range);
  if (!end || !match) return predicates;
  const unitHours = { h: 1, d: 24, w: 168 }[match[2]];
  const endMs = Date.parse(end);
  if (!unitHours || !Number.isFinite(endMs)) return predicates;
  const start = new Date(endMs - Number(match[1]) * unitHours * 3_600_000).toISOString();
  return [
    ...predicates.filter((predicate) => predicate.field !== '@time'),
    { field: '@time', gte: start },
    { field: '@time', lt: end }
  ];
}

/** @param {Array<Record<string, unknown>>} predicates */
function queryTimeEnd(predicates) {
  const end = predicates.findLast((predicate) => predicate.field === '@time' && typeof predicate.lt === 'string')?.lt;
  return typeof end === 'string' ? end : undefined;
}

/** @param {Record<string, unknown>} query @param {string | undefined} timeEnd */
function resolveQueryContext(query, timeEnd) {
  if (!Array.isArray(query.compute)) return query;
  return {
    ...query,
    compute: query.compute.map((computed) => !isPlainObject(computed) || !Array.isArray(computed.args)
      ? computed
      : {
          ...computed,
          args: computed.args.map((argument) => (
            isPlainObject(argument) && argument.context === 'time-end'
              ? { value: timeEnd ?? '' }
              : argument
          ))
        })
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

/**
 * @param {unknown} args
 * @param {Record<string, string> | undefined} routeParameters
 */
function compileArgumentPredicates(args, routeParameters) {
  if (!Array.isArray(args)) return [];
  return args.flatMap((argument) => {
    if (!isPlainObject(argument) || typeof argument.name !== 'string' || typeof argument.field !== 'string') return [];
    return [{
      field: argument.field,
      equals: typeof routeParameters?.[argument.name] === 'string'
        ? routeParameters[argument.name]
        : ''
    }];
  });
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
  const value = decodeRouteValue(routeValue.trim());
  if (!routeField) return [];
  if (!value) return [
    { field: routeField, equals: '' },
    { field: routeField, equals: '\0' }
  ];
  if (routeField === 'workflow') {
    const separator = value.indexOf(':');
    const repository = separator > 0 ? value.slice(0, separator) : '';
    const workflow = separator > 0 ? value.slice(separator + 1) : value;
    const slash = repository.indexOf('/');
    return [
      ...(slash > 0 ? [
        { field: 'organization', equals: repository.slice(0, slash) },
        { field: 'repository', equals: repository.slice(slash + 1) }
      ] : []),
      { field: 'workflow', equals: workflow }
    ];
  }
  return [{ field: routeField, equals: value }];
}

/** @param {string} value */
function decodeRouteValue(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** @param {unknown} value */
function asStringList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item) => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim()))];
}

/** @param {unknown} page @param {unknown} reusableViews */
function pagePayload(page, reusableViews) {
  if (!isPlainObject(page)) return {};
  const configured = /** @type {Record<string, unknown>} */ (page);
  const builtInDefinition = configured.kind === 'built-in' && isPlainObject(configured.definition)
    ? /** @type {Record<string, unknown>} */ (configured.definition)
    : null;
  const viewsById = new Map((Array.isArray(reusableViews) ? reusableViews : [])
    .filter(isPlainObject)
    .map((view) => [view.id, view]));
  const views = /** @type {unknown[]} */ (
    builtInDefinition?.views ?? (Array.isArray(configured.views) ? configured.views : [])
  );
  return {
    views: views.map((view) => typeof view === 'string' ? viewsById.get(view) ?? view : view),
    route: isPlainObject(configured.route) ? configured.route : null,
    form: isPlainObject(configured.form) ? configured.form : null
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
