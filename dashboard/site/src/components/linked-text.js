/**
 * Reusable presentation-only linked text helpers for dashboard views.
 */

import { renderSafeLink } from './link-content.js'

/**
 * Renders text as an external link when a safe link is available, otherwise as plain text.
 * @param {string} text
 * @param {{ href: string, label: string } | null} link
 * @returns {string | HTMLElement}
 */
export function renderLinkedText(text, link) {
  return renderSafeLink(text, link)
}

/**
 * @param {Record<string, string>} entityLinkFields
 * @param {(row: Record<string, unknown>, field: string) => { href: string, label: string } | null} findLink
 * @param {(display: unknown, value: unknown, column: string | { field: string, display?: unknown, format?: unknown, type?: unknown }) => string | HTMLElement} renderTableCellValue
 * @param {(value: unknown) => string} toText
 * @returns {(column: string | { field: string, display?: unknown, format?: unknown, type?: unknown }, value: unknown, row: Record<string, unknown>) => string | HTMLElement}
 */
export function createEntityAwareCellRenderer(entityLinkFields, findLink, renderTableCellValue, toText) {
  /**
   * @param {string | { field: string, display?: unknown, format?: unknown, type?: unknown }} column
   * @param {unknown} value
   * @param {Record<string, unknown>} row
   * @returns {string | HTMLElement}
   */
  return function renderEntityAwareCellValue(column, value, row) {
    const field = typeof column === 'string' ? column : column.field
    const display = typeof column === 'string' ? undefined : column.display
    const renderedValue = renderTableCellValue(display, value, column)
    const linkField = Object.prototype.hasOwnProperty.call(entityLinkFields, field)
      ? entityLinkFields[/** @type {keyof typeof entityLinkFields} */ (field)]
      : null
    if (linkField) {
      const link = findLink(row, linkField)
      if (link) {
        const linkedText = typeof column !== 'string' && column.format !== undefined && typeof renderedValue === 'string' ? renderedValue : toText(value)
        return renderLinkedText(linkedText, link)
      }
    }
    return renderedValue
  }
}
