/**
 * Shared declarative view-element composition selection helpers.
 */

import { selectNamedComposition } from './route-composition.js';

/**
 * @template {string} T
 * @param {ReadonlyArray<T>} values
 * @param {T} fallback
 * @returns {{ values: ReadonlyArray<T>, fallback: T }}
 */
export function createElementCompositionConfig(values, fallback) {
  return { values, fallback };
}

/**
 * @template {string} T
 * @template V
 * @param {Readonly<Record<T, V>>} compositions
 * @param {{ values: ReadonlyArray<T>, fallback: T }} config
 * @param {unknown} selected
 * @returns {V}
 */
export function selectElementComposition(compositions, config, selected) {
  const key = typeof selected === 'string' && config.values.includes(/** @type {T} */ (selected))
    ? /** @type {T} */ (selected)
    : config.fallback;
  return selectNamedComposition(compositions, key, config.fallback);
}
