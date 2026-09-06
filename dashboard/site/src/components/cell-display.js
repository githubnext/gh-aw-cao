/**
 * Generic renderer for JSON-selected table cell displays.
 */

import { h } from '../dom.js';
import { renderActiveStateBadge, renderGraderStatusBadge, renderModeBadge, renderStatusBadge } from './badge.js';
import { formatNumber, stringOrFallback } from '../view-formatters.js';
import { formatUtcDateTime, renderDigest } from './ui-primitives.js';

/**
 * @param {unknown} display
 * @param {unknown} value
 * @param {(value: unknown) => string} toText
 * @param {{ name: string, symbol: string, significant: number } | null} [unit]
 * @param {unknown} [type]
 * @returns {string | HTMLElement}
 */
export function renderCellDisplay(display, value, toText, unit = null, type) {
  if (display === 'mode') return renderModeBadge(value);
  if (display === 'active-state') return renderActiveStateBadge(value);
  if (display === 'status') return renderStatusBadge(value);
  if (display === 'grader-status') return renderGraderStatusBadge(value);
  if (display === 'label') return formatLabel(value);
  if (display === 'digest') return renderDigest(value) ?? 'unavailable';
  if (type === 'quantitative' && (value == null || value === '' || !Number.isFinite(Number(value)))) return '—';
  if (type === 'temporal' && typeof value === 'string' && Number.isFinite(Date.parse(value))) {
    return h('time', { dateTime: value }, formatUtcDateTime(value));
  }
  if (unit && typeof value === 'number' && Number.isFinite(value)) return formatNumber(value, unit);
  return toText(value);
}

/** @param {unknown} value */
function formatLabel(value) {
  const text = stringOrFallback(value, 'unavailable');
  const normalized = text.toLowerCase();
  if (normalized === 'matured') return 'Mature';
  return `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)}`;
}
