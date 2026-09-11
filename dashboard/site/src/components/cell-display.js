/**
 * Generic renderer for JSON-selected table cell displays.
 */

import { h } from '../dom.js';
import { renderActiveStateBadge, renderGraderStatusBadge, renderModeBadge, renderStatusBadge } from './badge.js';
import { renderWorkflowRunUrl } from './link-content.js';
import { formatHumanFriendlyTimestamp, formatNumber, formatString, stringOrFallback } from '../view-formatters.js';
import { formatUtcDateTime, renderDigest } from './ui-primitives.js';

/**
 * @param {unknown} display
 * @param {unknown} value
 * @param {(value: unknown) => string} toText
 * @param {{ name: string, symbol: string, significant: number } | null} [unit]
 * @param {unknown} [type]
 * @param {unknown} [format]
 * @returns {string | HTMLElement}
 */
export function renderCellDisplay(display, value, toText, unit = null, type, format) {
  if (value == null || value === '') return '';
  if (display === 'mode') return renderModeBadge(value);
  if (display === 'active-state') return renderActiveStateBadge(value);
  if (display === 'status') return renderStatusBadge(value);
  if (display === 'grader-status') return renderGraderStatusBadge(value);
  if (display === 'label') return formatLabel(value);
  if (display === 'digest') return renderDigest(value) ?? 'unavailable';
  if (type === 'quantitative' && !Number.isFinite(Number(value))) return '';
  if (type === 'temporal' && typeof value === 'string' && Number.isFinite(Date.parse(value))) {
    const text = format === 'human-friendly-timestamp'
      ? formatHumanFriendlyTimestamp(value)
      : formatUtcDateTime(value);
    const title = format === 'human-friendly-timestamp' ? `${formatUtcDateTime(value)} UTC` : undefined;
    const ariaLabel = title ? `${text} (${title})` : undefined;
    return h('time', { dateTime: value, title, ariaLabel }, text);
  }
  if (unit && typeof value === 'number' && Number.isFinite(value)) return formatNumber(value, unit);
  if (format === 'workflow-run-url') return renderWorkflowRunUrl(value) ?? toText(value);
  if (format !== undefined) return formatString(value, format);
  return toText(value);
}

/** @param {unknown} value */
function formatLabel(value) {
  const text = stringOrFallback(value, 'unavailable');
  const normalized = text.toLowerCase();
  if (normalized === 'matured') return 'Mature';
  return `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)}`;
}
