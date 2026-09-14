/**
 * Shared declarative config.body selection helpers for route-bound elements.
 */

/**
 * @template {string} T
 * @typedef {{
 *   values: readonly T[],
 *   fallback: T
 * }} NamedCompositionConfig
 */

/**
 * @template {string} T
 * @param {NamedCompositionConfig<T>} config
 * @param {unknown} selected
 * @returns {T}
 */
export function selectConfigBody(config, selected) {
  return typeof selected === 'string' && config.values.includes(/** @type {T} */ (selected))
    ? /** @type {T} */ (selected)
    : config.fallback;
}
