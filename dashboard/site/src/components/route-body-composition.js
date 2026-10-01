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
  const recognized = typeof selected === 'string' && config.values.includes(/** @type {T} */ (selected));
  if (!recognized) {
    debugRouteBodyComposition({
      event: 'body-fallback',
      body: typeof selected === 'string' ? selected : typeof selected,
      fallback: config.fallback
    });
  }
  return recognized ? /** @type {T} */ (selected) : config.fallback;
}
