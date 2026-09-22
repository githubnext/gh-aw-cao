/**
 * Builds the dependency graph connecting rendered dashboard content to
 * declarative queries.
 *
 * @param {Record<string, unknown>} dashboard
 */
export function buildDashboardQueryUsageGraph(dashboard) {
  const queries = Array.isArray(dashboard.queries) ? dashboard.queries : [];
  const queryNames = new Set(queries.flatMap((query) => (
    isRecord(query) && typeof query.name === 'string' ? [query.name] : []
  )));
  /** @type {Map<string, Set<string>>} */
  const graph = new Map();
  const roots = new Set();
  /** @type {Map<string, string>} */
  const queryPaths = new Map();
  /** @type {Map<string, string>} */
  const reusableViewNodes = new Map();

  /** @param {string} name */
  const queryNode = (name) => `query:${name}`;
  /** @param {string} node */
  const addNode = (node) => {
    if (!graph.has(node)) graph.set(node, new Set());
    return node;
  };
  /** @param {string} node @param {unknown[]} names */
  const addQueryEdges = (node, names) => {
    const edges = graph.get(addNode(node)) ?? new Set();
    for (const name of names) {
      if (typeof name === 'string' && queryNames.has(name)) edges.add(queryNode(name));
    }
  };

  queries.forEach((query, index) => {
    if (!isRecord(query) || typeof query.name !== 'string') return;
    const node = addNode(queryNode(query.name));
    queryPaths.set(query.name, `$.dashboard.queries[${index}].name`);
    addQueryEdges(node, queryInputNames(query));
  });

  if (Array.isArray(dashboard.views)) {
    dashboard.views.forEach((view, index) => {
      if (!isRecord(view)) return;
      const node = `view:$.dashboard.views[${index}]`;
      addQueryEdges(node, viewQueryNames(view));
      if (typeof view.id === 'string') reusableViewNodes.set(view.id, node);
    });
  }

  if (Array.isArray(dashboard.pages)) {
    dashboard.pages.forEach((page, pageIndex) => {
      if (!isRecord(page)) return;
      const definition = page.kind === 'built-in' && isRecord(page.definition)
        ? page.definition
        : page;
      if (!Array.isArray(definition.views)) return;
      definition.views.forEach((view, viewIndex) => {
        const path = `$.dashboard.pages[${pageIndex}]${definition === page ? '' : '.definition'}.views[${viewIndex}]`;
        const node = addNode(`view:${path}`);
        roots.add(node);
        if (typeof view === 'string') {
          const reusableNode = reusableViewNodes.get(view);
          if (reusableNode) graph.get(node)?.add(reusableNode);
        } else if (isRecord(view)) {
          addQueryEdges(node, viewQueryNames(view));
        }
      });
      if (Array.isArray(definition.sections)) {
        definition.sections.forEach((section, sectionIndex) => {
          if (!isRecord(section)) return;
          const path = `$.dashboard.pages[${pageIndex}]${definition === page ? '' : '.definition'}.sections[${sectionIndex}]`;
          const node = addNode(`section:${path}`);
          roots.add(node);
          addQueryEdges(node, [
            section['count-source'],
            ...(Array.isArray(section['count-sources']) ? section['count-sources'] : [])
          ]);
        });
      }
    });
  }

  if (Array.isArray(dashboard.callouts)) {
    dashboard.callouts.forEach((callout, index) => {
      if (!isRecord(callout) || !isRecord(callout['visible-when'])) return;
      const node = addNode(`callout:$.dashboard.callouts[${index}]`);
      roots.add(node);
      addQueryEdges(node, [callout['visible-when'].source]);
    });
  }

  return { graph, roots, queryPaths };
}

/**
 * @param {Record<string, unknown>} dashboard
 * @returns {Array<{ name: string, path: string }>}
 */
export function findDeadDashboardQueries(dashboard) {
  const { graph, roots, queryPaths } = buildDashboardQueryUsageGraph(dashboard);
  const reachable = new Set(roots);
  const pending = [...roots];
  while (pending.length > 0) {
    const node = pending.pop();
    for (const dependency of graph.get(node) ?? []) {
      if (reachable.has(dependency)) continue;
      reachable.add(dependency);
      pending.push(dependency);
    }
  }

  return [...queryPaths].flatMap(([name, path]) => (
    reachable.has(`query:${name}`) ? [] : [{ name, path }]
  ));
}

/** @param {Record<string, unknown>} query */
function queryInputNames(query) {
  return [
    query.from,
    ...(Array.isArray(query.union) ? query.union : []),
    ...(Array.isArray(query.joins)
      ? query.joins.flatMap((join) => isRecord(join) ? [join.source] : [])
      : [])
  ];
}

/** @param {Record<string, unknown>} view */
function viewQueryNames(view) {
  const names = [];
  if (isRecord(view.data)) {
    names.push(view.data.source);
    if (Array.isArray(view.data.sources)) names.push(...view.data.sources);
  }
  if (isRecord(view.list) && isRecord(view.list.drill)) names.push(view.list.drill.query);
  return names;
}

/** @param {unknown} value @returns {value is Record<string, any>} */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
