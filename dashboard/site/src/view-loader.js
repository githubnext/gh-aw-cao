const pageLoads = new WeakMap();

/**
 * Resolves the external view definitions for one dashboard page.
 * @param {{ dashboard?: { pages?: unknown[] } }} document
 * @param {string} pageId
 * @param {{ baseUrl?: string, fetch?: typeof globalThis.fetch }} [options]
 */
export function resolveDashboardPageViews(document, pageId, options = {}) {
  const page = document.dashboard?.pages?.find((candidate) => (
    isPlainObject(candidate) && candidate.id === pageId
  ));
  if (!isPlainObject(page)) return Promise.resolve();

  const owner = page.kind === 'built-in' && isPlainObject(page.definition)
    ? page.definition
    : page;
  if (!Array.isArray(owner.views)) return Promise.resolve();
  const references = owner.views.filter(isViewReference);
  if (references.length === 0) return Promise.resolve();

  const existing = pageLoads.get(page);
  if (existing) return existing;

  const fetchView = options.fetch ?? globalThis.fetch;
  if (typeof fetchView !== 'function') {
    return Promise.reject(new Error(`Unable to load dashboard views for ${pageId}: fetch is unavailable`));
  }
  const baseUrl = options.baseUrl ?? globalThis.location?.href;
  const load = Promise.all(owner.views.map(async (view) => {
    if (!isViewReference(view)) return view;
    const url = new URL(view.$ref, baseUrl);
    const response = await fetchView(url);
    if (!response.ok) {
      throw new Error(`Unable to load dashboard view ${view.$ref}: ${response.status}`);
    }
    const resolved = await response.json();
    if (!isPlainObject(resolved) || typeof resolved.id !== 'string') {
      throw new Error(`Dashboard view ${view.$ref} must contain a view mapping`);
    }
    return resolved;
  })).then((views) => {
    owner.views = views;
  });
  pageLoads.set(page, load);
  return load;
}

/**
 * @param {unknown} value
 * @returns {value is { $ref: string }}
 */
export function isViewReference(value) {
  return isPlainObject(value)
    && Object.keys(value).length === 1
    && typeof value.$ref === 'string';
}

/** @param {unknown} value */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
