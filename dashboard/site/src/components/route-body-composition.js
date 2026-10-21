/**
 * Shared declarative config.body selection helpers for route-bound elements.
 */

import { createDebug } from '../debug.js';

const debugRouteBodyComposition = createDebug('route-body-composition');

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
  if (typeof selected === 'string' && config.values.includes(/** @type {T} */ (selected))) {
    return /** @type {T} */ (selected);
  }
  // The rejected value is user-controlled route input, so only its kind is logged.
  debugRouteBodyComposition({
    event: 'body-fallback',
    selectedType: selected === null ? 'null' : typeof selected,
    fallback: config.fallback,
    allowedCount: config.values.length
  });
  return config.fallback;
}
