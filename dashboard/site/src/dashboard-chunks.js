import { resolveDashboardQuerySources } from './data/queries/declarative.js';
import { elementLoadsSourcesAsync } from './components/ui-elements.js';

/**
 * @typedef {{ id?: string, kind?: string, title?: string, description?: string, icon?: string, ['navigation-label']?: string, ['class-name']?: string, route?: { ['hash-query-parameter']?: string, ['navigation-page']?: string }, views?: unknown[], sections?: unknown[], definition?: { views?: unknown[], sections?: unknown[] }, chunk?: string, ['source-names']?: string[], ['lazy-source-names']?: string[], ['table-source-names']?: string[] } & Record<string, unknown>} DashboardPage
 */

/**
 * @typedef {{ languageVersion: string, dashboard: { pages: DashboardPage[], queries?: Array<Record<string, unknown>>, callouts?: Array<Record<string, unknown>> } & Record<string, unknown> }} DashboardDocument
 */

/**
 * @typedef {{ name?: string } & Record<string, unknown>} DashboardQuery
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function stringList(value) {
  return Array.isArray(value)
    ? value.filter((entry) => typeof entry === 'string' && entry.length > 0)
    : [];
}

/**
 * @param {DashboardPage | undefined} page
 * @returns {boolean}
 */
export function dashboardPageIsLoaded(page) {
  if (!page) return false;
  if (page.kind === 'built-in') {
    return Array.isArray(page.definition?.views) || Array.isArray(page.definition?.sections);
  }
  return Array.isArray(page.views) || Array.isArray(page.sections);
}

/**
 * @param {DashboardPage} page
 */
export function dashboardPageChunkPath(page) {
  return typeof page.chunk === 'string' && page.chunk.length > 0 ? page.chunk : null;
}

/**
 * @param {DashboardPage} page
 * @param {unknown} [reusableViews]
 */
export function dashboardPagePayload(page, reusableViews = []) {
  const definition = isPlainObject(page.definition) ? page.definition : null;
  const configuredViews = page.kind === 'built-in'
    ? Array.isArray(definition?.views) ? definition.views : []
    : Array.isArray(page.views) ? page.views : [];
  const viewsById = new Map((Array.isArray(reusableViews) ? reusableViews : [])
    .filter(isPlainObject)
    .map((view) => [view.id, view]));
  const views = configuredViews.map((view) => (
    typeof view === 'string' ? viewsById.get(view) ?? view : view
  ));
  const sections = page.kind === 'built-in'
    ? Array.isArray(definition?.sections) ? definition.sections : undefined
    : Array.isArray(page.sections) ? page.sections : undefined;
  return {
    ...page,
    kind: 'custom',
    views,
    ...(sections ? { sections } : {}),
  };
}

/**
 * @param {DashboardDocument} document
 * @param {string} pageId
 */
function dashboardPage(document, pageId) {
  return Array.isArray(document.dashboard?.pages)
    ? document.dashboard.pages.find((candidate) => candidate?.id === pageId)
    : undefined;
}

/**
 * @param {unknown} view
 * @returns {boolean}
 */
function isAsyncElementView(view) {
  return isPlainObject(view)
    && typeof view.element === 'string'
    && elementLoadsSourcesAsync(view.element);
}

/**
 * @param {unknown} view
 * @returns {string[]}
 */
function getViewSources(view) {
  if (!isPlainObject(view) || !isPlainObject(view.data)) return [];
  if (Array.isArray(view.data.sources)) {
    return view.data.sources.filter((source) => typeof source === 'string');
  }
  return typeof view.data.source === 'string' ? [view.data.source] : [];
}

/**
 * @param {DashboardDocument} document
 * @param {string} pageId
 * @returns {string[]}
 */
export function dashboardPageSourceNames(document, pageId) {
  const page = dashboardPage(document, pageId);
  if (!page) return [];
  const indexed = stringList(page['source-names']);
  if (indexed.length > 0) return indexed;
  const payload = dashboardPagePayload(page, document.dashboard.views);
  const names = new Set();
  for (const view of payload.views ?? []) {
    if (isAsyncElementView(view)) continue;
    for (const sourceName of getViewSources(view)) names.add(sourceName);
  }
  for (const section of payload.sections ?? []) {
    const configuredSection = isPlainObject(section) ? section : {};
    if (typeof configuredSection['count-source'] === 'string') names.add(configuredSection['count-source']);
    for (const sourceName of /** @type {unknown[]} */ (configuredSection['count-sources'] ?? [])) {
      if (typeof sourceName === 'string') names.add(sourceName);
    }
  }
  for (const callout of document.dashboard.callouts ?? []) {
    const visibility = isPlainObject(callout?.['visible-when']) ? callout['visible-when'] : null;
    if (typeof visibility?.source === 'string') {
      names.add(visibility.source);
    }
  }
  return [...names];
}

/**
 * @param {DashboardDocument} document
 * @param {string} pageId
 * @returns {string[]}
 */
export function dashboardPageLazySourceNames(document, pageId) {
  const page = dashboardPage(document, pageId);
  if (!page) return [];
  const indexed = stringList(page['lazy-source-names']);
  if (indexed.length > 0) return indexed;
  const payload = dashboardPagePayload(page, document.dashboard.views);
  return [...new Set((payload.views ?? []).flatMap((view) =>
    isPlainObject(view) && view['lazy-list'] === true ? getViewSources(view) : []
  ))];
}

/**
 * @param {DashboardDocument} document
 * @param {string} [pageId]
 * @returns {string[]}
 */
export function dashboardTableSourceNames(document, pageId) {
  if (typeof pageId === 'string' && pageId.length > 0) {
    const page = dashboardPage(document, pageId);
    if (!page) return [];
    const indexed = stringList(page['table-source-names']);
    if (indexed.length > 0) return indexed;
    const payload = dashboardPagePayload(page, document.dashboard.views);
    return [...new Set((payload.views ?? []).flatMap((view) =>
      isPlainObject(view) && view.mark === 'table' ? getViewSources(view) : []
    ))];
  }
  return [...new Set((document.dashboard.pages ?? []).flatMap((page) => dashboardTableSourceNames(document, page.id)))];
}

/**
 * Resolves `kind: 'built-in'` pages in `document` against the full `definition`
 * of the matching built-in page template found in `templateDocument` (looked
 * up by `page.page`). Used by tests and compliance fixtures that need a fully
 * resolved document without going through the runtime chunk-loading path.
 * @template {{ dashboard: { pages: DashboardPage[] } & Record<string, unknown> } & Record<string, unknown>} Document
 * @param {Document} document
 * @param {{ dashboard: { pages: DashboardPage[] } }} templateDocument
 * @returns {Document}
 */
export function resolveBuiltInPages(document, templateDocument) {
  return {
    ...document,
    dashboard: {
      ...document.dashboard,
      pages: document.dashboard.pages.map((page) => {
        if (page.kind !== 'built-in') return page;
        const template = templateDocument.dashboard.pages.find((candidate) => (
          candidate.kind === 'built-in' && candidate.page === page.page
        ));
        return template
          ? { ...template, ...page, definition: template.definition }
          : page;
      }),
    },
  };
}

/**
 * @param {DashboardPage} page
 * @param {string} chunkPath
 * @param {{ sourceNames: string[], lazySourceNames: string[], tableSourceNames: string[] }} index
 * @returns {DashboardPage}
 */
function stubDashboardPage(page, chunkPath, index) {
  const base = {
    ...page,
    chunk: chunkPath,
    'source-names': index.sourceNames,
    'lazy-source-names': index.lazySourceNames,
    'table-source-names': index.tableSourceNames,
  };
  if (page.kind === 'built-in') {
    delete base.definition;
  } else {
    delete base.views;
    delete base.sections;
  }
  return base;
}

/**
 * @param {DashboardPage | undefined} stub
 * @param {DashboardPage} page
 * @returns {DashboardPage}
 */
export function mergeDashboardPage(stub, page) {
  return {
    ...(stub ?? {}),
    ...page,
    ...(Array.isArray(stub?.['source-names']) ? {
      chunk: stub?.chunk,
      'source-names': stub?.['source-names'],
      'lazy-source-names': stub?.['lazy-source-names'],
      'table-source-names': stub?.['table-source-names'],
    } : {}),
  };
}

/**
 * @param {{ page: DashboardPage, queries?: Array<Record<string, unknown>> }} chunk
 * @returns {{ page: DashboardPage, queries: Array<Record<string, unknown>> }}
 */
export function normalizeDashboardPageChunk(chunk) {
  return {
    page: /** @type {DashboardPage} */ (chunk.page),
    queries: Array.isArray(chunk.queries) ? chunk.queries : [],
  };
}

/**
 * Builds the relative chunk path a page's JSON is written to / fetched from,
 * given its id and the (optional) chunk directory name. Shared by
 * `splitDashboardDocument`, `scripts/build.mjs`, and `local-server.mjs` so
 * the naming scheme only needs to change in one place.
 * @param {string} pageId
 * @param {string} [chunkDirectory]
 * @returns {string}
 */
export function buildDashboardPageChunkPath(pageId, chunkDirectory = 'dashboard-pages') {
  return `${chunkDirectory}/${encodeURIComponent(pageId)}.json`;
}

/**
 * @param {{ 'language-version'?: string, dashboard?: { pages?: DashboardPage[], queries?: DashboardQuery[], callouts?: Array<Record<string, unknown>> } & Record<string, unknown> } | DashboardDocument} source
 * @param {{ chunkDirectory?: string }} [options]
 */
export function splitDashboardDocument(source, options = {}) {
  /** @type {DashboardDocument} */
  const document = 'languageVersion' in source
    ? /** @type {DashboardDocument} */ (source)
    : {
        languageVersion: source['language-version'] ?? '',
        dashboard: {
          ...(source.dashboard ?? {}),
          pages: source.dashboard?.pages ?? [],
        },
      };
  const chunkDirectory = options.chunkDirectory ?? 'dashboard-pages';
  const queryDefinitions = /** @type {DashboardQuery[]} */ (Array.isArray(document.dashboard.queries) ? document.dashboard.queries : []);
  /** @type {Map<string, { page: DashboardPage, queries: DashboardQuery[] }>} */
  const pageChunks = new Map();
  const corePages = (document.dashboard.pages ?? []).map((page) => {
    // Pages that already carry a `chunk` pointer are assumed to already be
    // split (e.g. a previously-built dashboard.json, or a mixed schema where
    // only some pages have been split so far); leave them exactly as-is
    // instead of re-splitting or discarding their existing chunk reference.
    if (typeof page.chunk === 'string' && page.chunk.length > 0) return page;
    const sourceNames = dashboardPageSourceNames(document, page.id ?? '');
    const lazySourceNames = dashboardPageLazySourceNames(document, page.id ?? '');
    const tableSourceNames = dashboardTableSourceNames(document, page.id ?? '');
    const payload = dashboardPagePayload(page, document.dashboard.views);
    const querySourceNames = new Set([
      ...sourceNames,
      ...(payload.views ?? []).flatMap(getViewSources),
    ]);
    const requiredQueryNames = new Set(resolveDashboardQuerySources(queryDefinitions, querySourceNames));
    const queries = queryDefinitions.filter((query) => (
      typeof query?.name === 'string' && requiredQueryNames.has(query.name)
    ));
    const chunkPath = buildDashboardPageChunkPath(page.id ?? '', chunkDirectory);
    pageChunks.set(page.id ?? '', { page, queries });
    return stubDashboardPage(page, chunkPath, { sourceNames, lazySourceNames, tableSourceNames });
  });
  const dashboard = { ...document.dashboard, pages: corePages };
  delete dashboard.queries;
  return {
    core: {
      'language-version': document.languageVersion,
      dashboard,
    },
    pageChunks,
  };
}

/**
 * @param {{ 'language-version': string, dashboard: Record<string, unknown> & { pages: DashboardPage[] } }} core
 * @param {Iterable<{ page: DashboardPage, queries?: DashboardQuery[] }>} chunks
 */
export function resolveDashboardDocument(core, chunks) {
  /** @type {DashboardDocument} */
  const document = {
    languageVersion: core['language-version'],
    dashboard: {
      ...core.dashboard,
      pages: [...core.dashboard.pages],
      /** @type {DashboardQuery[]} */
      queries: [],
    },
  };
  /** @type {string[]} */
  const queryNames = [];
  const queries = /** @type {DashboardQuery[]} */ (document.dashboard.queries);
  for (const chunk of chunks) {
    const normalized = normalizeDashboardPageChunk(chunk);
    const pageIndex = document.dashboard.pages.findIndex((page) => page.id === normalized.page.id);
    if (pageIndex >= 0) {
      document.dashboard.pages.splice(
        pageIndex,
        1,
        mergeDashboardPage(document.dashboard.pages[pageIndex], normalized.page),
      );
    }
    for (const query of normalized.queries) {
      if (typeof query?.name !== 'string') continue;
      const existing = queryNames.indexOf(query.name);
      if (existing >= 0) {
        queries[existing] = query;
      } else {
        queryNames.push(query.name);
        queries.push(query);
      }
    }
  }
  return document;
}
