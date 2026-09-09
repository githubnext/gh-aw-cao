/**
 * Shared presentation-only count and pluralization helpers.
 */

/**
 * Converts a kebab-case or snake_case identifier into title-cased display
 * text, capitalizing the first letter of each hyphen/underscore-delimited
 * word and joining them with spaces.
 * @param {string} value
 * @returns {string}
 */
export function titleCase(value) {
  return value
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => `${part[0].toUpperCase()}${part.slice(1)}`)
    .join(' ')
}

/**
 * Coerces a value to a trimmed string, returning an empty string for
 * non-string values. Shared by view components that read loosely-typed
 * source rows and need a defensive plain-text accessor.
 * @param {unknown} value
 * @returns {string}
 */
export function textValue(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Formats a count for UI text.
 * @param {unknown} value
 * @returns {string}
 */
export function formatCount(value) {
  return new Intl.NumberFormat('en').format(Number(value) || 0)
}

/**
 * Formats a count with a singular/plural noun.
 * @param {unknown} value
 * @param {string} singular
 * @param {string} plural
 * @returns {string}
 */
export function formatCountNoun(value, singular, plural) {
  const count = Number(value) || 0
  return `${formatCount(count)} ${count === 1 ? singular : plural}`
}

/**
 * Returns the regular English plural suffix ('' or 's') for a count, for
 * inline pluralization of nouns that only need a trailing "s".
 * @param {unknown} value
 * @returns {string}
 */
export function pluralSuffix(value) {
  return Number(value) === 1 ? '' : 's'
}

/**
 * Coerces an arbitrary value to a display string, treating `null`/`undefined`
 * as an empty string.
 * @param {unknown} value
 * @returns {string}
 */
export function text(value) {
  return value == null ? '' : String(value)
}

/**
 * Computes the fraction of usable observations out of usable + excluded,
 * returning `null` when there are no observations to divide.
 * @param {number} usable
 * @param {number} excluded
 * @returns {number | null}
 */
export function computeObservationCoverage(usable, excluded) {
  return usable + excluded > 0 ? usable / (usable + excluded) : null
}

/**
 * Formats an observation coverage ratio (as returned by
 * `computeObservationCoverage`) as a one-decimal percentage string, or a
 * placeholder when the ratio is `null`.
 * @param {number | null} coverage
 * @param {string} [unknown]
 * @returns {string}
 */
export function formatCoveragePercent(coverage, unknown = '—') {
  return coverage === null ? unknown : `${(coverage * 100).toFixed(1)}%`
}

/**
 * Formats a 0-1 ratio as a whole-number percentage string, or a placeholder
 * when the ratio is `null`/not finite. Unlike `formatCoveragePercent`, this
 * rounds to the nearest whole percent for compact summary metrics.
 * @param {number | null} ratio
 * @param {string} [unknown]
 * @returns {string}
 */
export function formatRoundedPercent(ratio, unknown = '—') {
  return ratio === null || !Number.isFinite(ratio) ? unknown : `${Math.round(ratio * 100)}%`
}

/**
 * Clamps a percentage value to the closed `[0, 100]` range, guarding chart
 * and progress-bar rendering against out-of-range inputs (e.g. rounding
 * artifacts or partially available telemetry).
 * @param {number} value
 * @returns {number}
 */
export function clampPercent(value) {
  return Math.max(0, Math.min(100, value))
}

/**
 * Converts a value into a lowercase, hyphen-delimited slug suitable for use
 * as (part of) an HTML `id` attribute, collapsing runs of non-alphanumeric
 * characters and trimming leading/trailing hyphens.
 * @param {string} value
 * @param {string} [fallback]
 * @returns {string}
 */
export function slugify(value, fallback = '') {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || fallback
  )
}

/**
 * Tallies rows into a `Map` keyed by a derived label, counting how many rows
 * produced each key. Shared by experiment summary and detail views that
 * group observations by state, readiness, or reason.
 * @param {Array<Record<string, any>>} rows
 * @param {(row: Record<string, any>) => string} key
 * @returns {Map<string, number>}
 */
export function countBy(rows, key) {
  const counts = new Map()
  for (const row of rows) {
    const value = key(row)
    counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  return counts
}
