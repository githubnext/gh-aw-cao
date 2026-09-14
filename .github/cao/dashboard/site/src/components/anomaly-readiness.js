/**
 * Reusable statistical-anomaly evaluation boundary widget.
 */

import { h } from '../dom.js';
import { octicon } from '../octicons.js';
import { text as stringValue } from './count-formatters.js';

/**
 * @param {Record<string, unknown>} row
 * @returns {HTMLElement}
 */
export function renderAnomalyReadiness(row) {
  return h(
    'div',
    { className: 'anomaly-readiness', role: 'note' },
    h(
      'span',
      null,
      octicon(stringValue(row.icon) || 'pulse'),
      h('strong', null, stringValue(row.title))
    ),
    h('p', null, stringValue(row.detail))
  );
}
