/**
 * Shared canonical body selection helpers for declarative route elements.
 */

import { selectNamedComposition } from './route-composition.js'
import { selectConfigBody } from './route-body-composition.js'

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
  return {
    values,
    fallback,
    body: (value) => selectConfigBody({ values, fallback }, value),
    composition: (compositions, value) => selectNamedComposition(compositions, selectConfigBody({ values, fallback }, value), fallback),
  }
}
