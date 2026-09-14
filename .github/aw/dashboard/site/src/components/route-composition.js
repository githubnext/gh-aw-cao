/**
 * Shared route-bound element composition selection helpers.
 */

/**
 * @template {string} T
 * @template V
 * @param {Readonly<Record<T, V>>} compositions
 * @param {unknown} selected
 * @param {T} fallback
 * @returns {V}
 */
export function selectNamedComposition(compositions, selected, fallback) {
  const key = typeof selected === 'string' && Object.hasOwn(compositions, selected)
    ? /** @type {T} */ (selected)
    : fallback;
  return compositions[key];
}
