import { readFile, readdir } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ignoredDirectories = new Set(['.cao', '.git', 'coverage', 'dist', 'node_modules', 'test-results']);

/** @param {string} source */
export function elementRendererNames(source) {
  const registry = source.match(/const ELEMENT_RENDERERS = new Map\(\[([\s\S]*?)\n\s*\]\);/)?.[1] ?? '';
  return [...registry.matchAll(/\[\s*['"]([^'"]+)['"]\s*,/g)].map((match) => match[1]);
}

/** @param {unknown} document */
export function referencedElementNames(document) {
  /** @type {Set<string>} */
  const names = new Set();
  /** @param {unknown} value */
  const visit = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const record = /** @type {Record<string, unknown>} */ (value);
    if (record.mark === 'element' && typeof record.element === 'string') names.add(record.element);
    for (const child of Object.values(record)) visit(child);
  };
  visit(document);
  return names;
}

/**
 * @param {string[]} renderers
 * @param {Iterable<string>} references
 */
export function deadElementRendererNames(renderers, references) {
  const referenced = new Set(references);
  return renderers.filter((name) => !referenced.has(name));
}

/** @param {unknown} document */
export function referencedPageNames(document) {
  /** @type {Set<string>} */
  const names = new Set();
  /** @param {unknown} value */
  const visit = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const record = /** @type {Record<string, unknown>} */ (value);
    if (Array.isArray(record.pages)) {
      for (const page of record.pages) {
        if (typeof page === 'string') names.add(page);
      }
    }
    if (Array.isArray(record.tabs)) {
      for (const tab of record.tabs) {
        if (tab && typeof tab === 'object') {
          const page = /** @type {{ page?: unknown }} */ (tab).page;
          if (typeof page === 'string') names.add(page);
        }
      }
    }
    for (const key of ['navigation-page', 'view-all-page']) {
      if (typeof record[key] === 'string') names.add(record[key]);
    }
    for (const key of ['href', 'dashboard-href', 'navigation-href']) {
      if (typeof record[key] === 'string') {
        const page = pageIdFromHashRoute(record[key]);
        if (page) names.add(page);
      }
    }
    for (const child of Object.values(record)) visit(child);
  };
  visit(document);
  return names;
}

/**
 * @param {string} route
 * @returns {string | null}
 */
function pageIdFromHashRoute(route) {
  if (!route.startsWith('#page-')) return null;
  const page = route.slice('#page-'.length).split('?')[0];
  try {
    return decodeURIComponent(page);
  } catch {
    return page;
  }
}

/** @param {unknown} document */
export function dashboardPages(document) {
  if (!document || typeof document !== 'object') return [];
  const dashboard = /** @type {{ dashboard?: { pages?: unknown } }} */ (document).dashboard;
  if (!dashboard || !Array.isArray(dashboard.pages)) return [];
  return dashboard.pages.filter((page) => (
    page
    && typeof page === 'object'
    && typeof /** @type {{ id?: unknown }} */ (page).id === 'string'
  ));
}

/**
 * @param {Array<Record<string, unknown>>} pages
 * @param {Iterable<string>} references
 */
export function deadDashboardPages(pages, references) {
  const referenced = new Set(references);
  return pages.filter((page) => (
    typeof page.id === 'string'
    && !referenced.has(page.id)
    // Dynamic route pages are commonly reached through data-provided #page-* links
    // that this static dashboard document pass cannot resolve.
    && !isDynamicallyRoutedPage(page)
  ));
}

/** @param {Record<string, unknown>} page */
function isDynamicallyRoutedPage(page) {
  if (!page.route || typeof page.route !== 'object') return false;
  const route = /** @type {Record<string, unknown>} */ (page.route);
  // Best-effort exemption: these route shapes are usually entered through
  // query-backed dashboard links, so this static pass avoids classifying them
  // as dead without evaluating runtime data rows.
  return (
    typeof route['hash-query-parameter'] === 'string' && route['hash-query-parameter'].length > 0
  ) || (
    typeof route['navigation-page'] === 'string' && route['navigation-page'].length > 0
  );
}

/** @param {Record<string, unknown>} page */
export function pageViewNames(page) {
  const views = Array.isArray(page.views)
    ? page.views
    : page.definition && typeof page.definition === 'object' && Array.isArray(/** @type {{ views?: unknown }} */ (page.definition).views)
      ? /** @type {{ views: unknown[] }} */ (page.definition).views
      : [];
  return views
    .map((view) => {
      if (typeof view === 'string') return view;
      if (view && typeof view === 'object' && typeof /** @type {{ id?: unknown }} */ (view).id === 'string') {
        return /** @type {{ id: string }} */ (view).id;
      }
      return null;
    })
    .filter((view) => typeof view === 'string');
}

/** @param {string} directory @returns {Promise<string[]>} */
async function findDashboardDocuments(directory) {
  const documents = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (
      entry.isDirectory()
      && !ignoredDirectories.has(entry.name)
      && !entry.name.startsWith('.cao-')
      && !entry.name.startsWith('.lazy-page-chunks-')
    ) {
      documents.push(...await findDashboardDocuments(resolve(directory, entry.name)));
    } else if (entry.isFile() && entry.name === 'dashboard.json') {
      documents.push(resolve(directory, entry.name));
    }
  }
  return documents;
}

async function main() {
  const repositoryRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
  const rendererPath = resolve(repositoryRoot, 'dashboard/site/src/components/ui-elements.js');
  const renderers = elementRendererNames(await readFile(rendererPath, 'utf8'));
  const references = new Set();
  const pageReferences = new Set();
  const pages = [];
  const dashboardPaths = await findDashboardDocuments(repositoryRoot);

  for (const dashboardPath of dashboardPaths) {
    const document = JSON.parse(await readFile(dashboardPath, 'utf8'));
    for (const name of referencedElementNames(document)) references.add(name);
    for (const name of referencedPageNames(document)) pageReferences.add(name);
    pages.push(...dashboardPages(document));
  }

  const dead = deadElementRendererNames(renderers, references);
  console.log(`Dead element views (${dead.length}):`);
  for (const name of dead) console.log(`- ${name}`);
  const deadPages = deadDashboardPages(pages, pageReferences);
  console.log(`Dead dashboard pages (${deadPages.length}):`);
  for (const page of deadPages) {
    const viewNames = pageViewNames(page);
    const suffix = viewNames.length ? ` (${viewNames.join(', ')})` : '';
    console.log(`- ${page.id}${suffix}`);
  }
  console.log(
    `Analyzed ${renderers.length} element renderers and ${pages.length} dashboard pages across ${dashboardPaths.length} dashboard.json file(s) from ${relative(repositoryRoot, rendererPath)}.`
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
