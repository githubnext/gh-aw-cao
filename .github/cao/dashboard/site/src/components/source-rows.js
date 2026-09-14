/**
 * Shared presentation-only accessor for reading rows out of a Dashboard
 * Language `sources` map, used by every detail/list view to safely read a
 * named source's rows without assuming the source or its `rows` array exist.
 */

/**
 * @param {Record<string, import('../presenter.js').LogicalSourceInput>} sources
 * @param {string} name
 * @returns {Array<Record<string, unknown>>}
 */
export function rowsFor(sources, name) {
  return Array.isArray(sources[name]?.rows) ? sources[name].rows : [];
}
