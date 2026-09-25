/**
 * Reusable presentation-only linked text helpers for dashboard views.
 */

import { renderExternalLink, renderSafeLink } from './link-content.js';

/**
 * Renders text as an external link when a safe link is available, otherwise as plain text.
 * @param {string} text
 * @param {{ href: string, label: string } | null} link
 * @returns {string | HTMLElement}
 */
export function renderLinkedText(text, link) {
  return renderSafeLink(text, link);
}

/**
 * @param {Record<string, string>} entityLinkFields
 * @param {(row: Record<string, unknown>, field: string) => { href: string, label: string } | null} findLink
 * @param {(display: unknown, value: unknown, column: string | { field: string, title?: unknown, as?: unknown, display?: unknown, format?: unknown, type?: unknown }) => string | HTMLElement} renderTableCellValue
 * @param {(value: unknown) => string} toText
 * @returns {(column: string | { field: string, title?: unknown, as?: unknown, display?: unknown, format?: unknown, type?: unknown }, value: unknown, row: Record<string, unknown>) => string | HTMLElement}
 */
export function createEntityAwareCellRenderer(entityLinkFields, findLink, renderTableCellValue, toText) {
  /**
   * @param {string | { field: string, title?: unknown, as?: unknown, display?: unknown, format?: unknown, type?: unknown }} column
   * @param {unknown} value
   * @param {Record<string, unknown>} row
   * @returns {string | HTMLElement}
   */
  return function renderEntityAwareCellValue(column, value, row) {
    const field = typeof column === 'string' ? column : column.field;
    const display = typeof column === 'string' ? undefined : column.display;
    const renderedValue = renderTableCellValue(display, value, column);
    if (value == null || value === '') return renderedValue;
    const linkField = Object.prototype.hasOwnProperty.call(entityLinkFields, field)
      ? entityLinkFields[/** @type {keyof typeof entityLinkFields} */ (field)]
      : null;
    if (linkField) {
      const link = findLink(row, linkField);
      if (link) {
        const linkedText = typeof column !== 'string'
          && column.format !== undefined
          && typeof renderedValue === 'string'
          ? renderedValue
          : toText(value);
        return renderLinkedText(linkedText, link);
      }
    }
    if (display === undefined && typeof column !== 'string' && column.format === undefined && isExternalLinkField(column)) {
      const externalLink = resolveExternalUrlValue(value);
      if (externalLink) return renderExternalLink(externalLink);
    }
    return renderedValue;
  };
}

/**
 * @param {{ field: string, title?: unknown, as?: unknown }} column
 * @returns {boolean}
 */
function isExternalLinkField(column) {
  return [column.field, column.as, column.title]
    .some((candidate) => typeof candidate === 'string' && hasUrlOrLinkToken(candidate));
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function hasUrlOrLinkToken(value) {
  const tokenized = value.replace(/([a-z0-9])([A-Z][a-z])/g, '$1 $2');
  return /(?:^|[^a-z0-9])(?:url|link)(?:$|[^a-z0-9])/i.test(tokenized);
}

/**
 * @param {unknown} value
 * @returns {{ href: string, label: string } | null}
 */
function resolveExternalUrlValue(value) {
  if (typeof value !== 'string') return null;
  const label = value.trim();
  if (label.length === 0) return null;
  try {
    const url = new URL(label);
    return url.protocol === 'https:' ? { href: url.href, label } : null;
  } catch {
    return null;
  }
}
