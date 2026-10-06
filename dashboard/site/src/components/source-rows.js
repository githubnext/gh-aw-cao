/**
 * Shared presentation-only accessor for reading rows out of a Dashboard
 * Language `sources` map, used by every detail/list view to safely read a
 * named source's rows without assuming the source or its `rows` array exist.
 */

import { createDebug } from '../debug.js';

const debugSourceRows = createDebug('source-rows');

/**
 * @param {Record<string, import('../presenter.js').LogicalSourceInput>} sources
 * @param {string} name
 * @returns {Array<Record<string, unknown>>}
 */
export function rowsFor(sources, name) {
  const entry = sources[name];
  if (entry === undefined) {
    debugSourceRows({ event: 'source-missing', name });
    return [];
  }
  if (!Array.isArray(entry.rows)) {
    debugSourceRows({ event: 'rows-malformed', name });
    return [];
  }
  return entry.rows;
}
