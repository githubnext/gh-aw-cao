import { createDebug } from './debug.js';

/** @typedef {{ label: string, field: string, source: string, 'value-field': string, 'label-field'?: string }} ViewFilterGroup */
/** @typedef {{ id: string, label: string, groups: ViewFilterGroup[] }} ViewFilterControl */
/** @typedef {Record<string, Record<string, string[]>>} ViewFilters */

const debugViewFilterContract = createDebug('view-filter-contract');

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** @param {unknown} view @returns {ViewFilterControl[]} */
export function viewFilterControls(view) {
  if (!isRecord(view) || !isRecord(view['filter-bar'])) return [];
  return Array.isArray(view['filter-bar'].filters)
    ? /** @type {ViewFilterControl[]} */ (view['filter-bar'].filters)
    : [];
}

/** @param {unknown} view @returns {string[]} */
export function viewFilterSourceNames(view) {
  return [...new Set(viewFilterControls(view).flatMap((control) => control.groups.map((group) => group.source)))];
}

/** @param {unknown} view @returns {string[]} */
export function viewDataSourceNames(view) {
  if (!isRecord(view) || !isRecord(view.data)) return [];
  return Array.isArray(view.data.sources)
    ? view.data.sources.filter((source) => typeof source === 'string')
    : typeof view.data.source === 'string' ? [view.data.source] : [];
}

/** @param {unknown} view @returns {string[]} */
export function dashboardViewSourceNames(view) {
  return [...new Set([...viewDataSourceNames(view), ...viewFilterSourceNames(view)])];
}

/** @param {unknown} value @returns {ViewFilters | undefined} */
export function normalizeViewFilters(value) {
  if (value !== undefined && !isRecord(value)) {
    debugViewFilterContract({ event: 'view-filters-rejected', reason: 'not-a-mapping' });
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  const viewCount = Object.keys(value).length;
  const entries = Object.entries(value).flatMap(([viewId, filters]) => {
    if (!isRecord(filters)) return [];
    const fields = Object.entries(filters).flatMap(([field, values]) => {
      const selected = Array.isArray(values)
        ? [...new Set(values.filter((entry) => typeof entry === 'string'))]
        : [];
      return selected.length ? [[field, selected]] : [];
    });
    return fields.length ? [[viewId, Object.fromEntries(fields)]] : [];
  });
  debugViewFilterContract({
    event: 'view-filters-normalized',
    viewCount,
    retainedViewCount: entries.length
  });
  return entries.length ? Object.fromEntries(entries) : undefined;
}
