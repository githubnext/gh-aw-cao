/**
 * Shared canonical body selection helpers for declarative route elements.
 */

import { selectNamedComposition } from './route-composition.js';
import { selectConfigBody } from './route-body-composition.js';
import { createDebug } from '../debug.js';

const debugRouteBodyConfig = createDebug('route-body-config');

/**
 * @template {string} T
 * @template V
 * @param {readonly T[]} values
 * @param {T} fallback
 * @returns {{
 *   values: readonly T[],
 *   fallback: T,
 *   body: (value: unknown) => T,
 *   composition: (compositions: Readonly<Record<T, V>>, value: unknown) => V
 * }}
 */
export function createRouteBodyConfig(values, fallback) {
  const body = (/** @type {unknown} */ value) => {
    const resolved = selectConfigBody({ values, fallback }, value);
    if (resolved !== value) {
      debugRouteBodyConfig({
        event: 'body-fallback',
        requested: typeof value === 'string' ? value : typeof value,
        fallback: resolved
      });
    }
    return resolved;
  };
  return {
    values,
    fallback,
    body,
    composition: (compositions, value) => selectNamedComposition(compositions, body(value), fallback)
  };
}
