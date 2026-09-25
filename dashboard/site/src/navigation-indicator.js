/** @param {Record<string, unknown>} page */
export function navigationIndicator(page) {
  if (!isPlainObject(page['navigation-indicator'])) return null;
  const indicator = /** @type {Record<string, unknown>} */ (page['navigation-indicator']);
  if (typeof indicator.label !== 'string' || indicator.label.length === 0) return null;
  const tests = Array.isArray(indicator.any)
    ? indicator.any.filter(isPlainObject)
    : [];
  if (tests.length === 0) return null;
  return {
    label: indicator.label,
    tests
  };
}

/** @param {Array<Record<string, unknown>>} pages */
export function navigationIndicatorSourceNames(pages) {
  return [...new Set(pages.flatMap(navigationIndicatorSourceNamesForPage))];
}

/** @param {Record<string, unknown>} page */
export function navigationIndicatorSourceNamesForPage(page) {
  const indicator = navigationIndicator(page);
  if (!indicator) return [];
  return indicator.tests.flatMap((test) => (
    typeof test.source === 'string' ? [test.source] : []
  ));
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
