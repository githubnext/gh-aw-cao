/**
 * Shared presentation-only count and pluralization helpers.
 */

/**
 * Converts a kebab-case identifier into title-cased display text.
 * @param {string} value
 * @returns {string}
 */
export function titleCase(value) {
  return value.replaceAll('-', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/**
 * Formats a count for UI text.
 * @param {unknown} value
 * @returns {string}
 */
export function formatCount(value) {
  return new Intl.NumberFormat('en').format(Number(value) || 0);
}

/**
 * Formats a count with a singular/plural noun.
 * @param {unknown} value
 * @param {string} singular
 * @param {string} plural
 * @returns {string}
 */
export function formatCountNoun(value, singular, plural) {
  const count = Number(value) || 0;
  return `${formatCount(count)} ${count === 1 ? singular : plural}`;
}

/**
 * Returns the regular English plural suffix ('' or 's') for a count, for
 * inline pluralization of nouns that only need a trailing "s".
 * @param {unknown} value
 * @returns {string}
 */
export function pluralSuffix(value) {
  return Number(value) === 1 ? '' : 's';
}

/**
 * Coerces an arbitrary value to a display string, treating `null`/`undefined`
 * as an empty string.
 * @param {unknown} value
 * @returns {string}
 */
export function text(value) {
  return value == null ? '' : String(value);
}

/**
 * Computes the fraction of usable observations out of usable + excluded,
 * returning `null` when there are no observations to divide.
 * @param {number} usable
 * @param {number} excluded
 * @returns {number | null}
 */
export function computeObservationCoverage(usable, excluded) {
  return usable + excluded > 0 ? usable / (usable + excluded) : null;
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
  return coverage === null ? unknown : `${(coverage * 100).toFixed(1)}%`;
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
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || fallback;
}
