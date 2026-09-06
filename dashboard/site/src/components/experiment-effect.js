/**
 * Shared normalized-effect indicator used by the experiments decision table
 * and detail sections.
 */

import { h } from '../dom.js';

const UNKNOWN = '—';

/**
 * Renders a normalized effect size as a signed, directionally colored badge
 * with an accessible description of the direction, falling back to an
 * "insufficient evidence" state when the value is not finite.
 * @param {number} value
 * @returns {HTMLElement}
 */
export function renderEffect(value) {
  if (!Number.isFinite(value)) return h('span', { className: 'effect effect-unknown' }, UNKNOWN, h('span', { className: 'sr-only' }, ' insufficient evidence'));
  const positive = value > 0;
  const negative = value < 0;
  return h(
    'span',
    { className: `effect ${positive ? 'effect-positive' : negative ? 'effect-negative' : 'effect-neutral'}` },
    `${positive ? '+' : ''}${value.toFixed(3)}`,
    positive ? ' ▲' : negative ? ' ▼' : ' ·',
    h('span', { className: 'sr-only' }, positive ? ' improvement' : negative ? ' regression' : ' no change')
  );
}
