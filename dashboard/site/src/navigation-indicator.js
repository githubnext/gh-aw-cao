/**
 * Resolves the declarative navigation indicator for one page.
 * The returned predicates are source predicates; a presenter should subscribe to
 * those bounded sources and a navigation component should show the indicator
 * when any predicate's row field equals its declared scalar value.
 *
 * @param {Record<string, unknown>} page
 * @returns {{ label: string, predicates: Array<Record<string, unknown>> } | null}
 */
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
    predicates: tests
  };
}

/**
 * Returns the unique bounded sources needed to evaluate page navigation
 * indicators.
 * @param {Array<Record<string, unknown>>} pages
 */
export function navigationIndicatorSourceNames(pages) {
  return [...new Set(pages.flatMap(navigationIndicatorSourceNamesForPage))];
}

/**
 * Returns the bounded sources referenced by one page's navigation indicator.
 * @param {Record<string, unknown>} page
 */
export function navigationIndicatorSourceNamesForPage(page) {
  const indicator = navigationIndicator(page);
  if (!indicator) return [];
  return indicator.predicates.flatMap((test) => (
    typeof test.source === 'string' ? [test.source] : []
  ));
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
