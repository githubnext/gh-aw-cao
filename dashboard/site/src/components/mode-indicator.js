/**
 * Reusable declarative page-mode indicator.
 *
 * Reads a `mode` query-string value from a caller-supplied URL and reports
 * `review` or `live` when present, or an empty string otherwise. This
 * primitive takes no page identity of its own — callers decide which pages
 * are eligible to show the indicator by declaring `mode-indicator: true`,
 * rather than the resolution logic being wired to one built-in page id.
 */

import { createDebug } from '../debug.js';

const debugModeIndicator = createDebug('mode-indicator');

/**
 * @param {string} search a URL search string, e.g. `location.search`
 * @returns {'review' | 'live' | ''}
 */
export function resolveModeIndicator(search) {
  const requested = new URLSearchParams(search ?? '').get('mode');
  const resolved = requested === 'review' || requested === 'live' ? requested : '';
  debugModeIndicator({ event: 'resolved', hasRequestedValue: requested != null, resolved: resolved || 'none' });
  return resolved;
}
