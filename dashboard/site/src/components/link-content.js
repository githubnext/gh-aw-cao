/**
 * Reusable presentation-only link helpers for dashboard views.
 */

import { h } from '../dom.js'
import { octicon } from '../octicons.js'
import { isPlainObject, isSafeHttpsUrl } from './ui-primitives.js'

/**
 * @typedef {{ href: string, label: string, externalHref?: string }} SafeLink
 */

/**
 * @param {Array<Record<string, unknown>>} rows
 * @param {string} field
 * @returns {SafeLink | null}
 */
export function findFirstLink(rows, field) {
  for (const row of rows) {
    const link = findLink(row, field)
    if (link) {
      return link
    }
  }
  return null
}

/**
 * @param {Record<string, unknown>} row
 * @param {string} field
 * @returns {SafeLink | null}
 */
export function findLink(row, field) {
  const candidate = row[field]
  if (
    !isPlainObject(candidate) ||
    typeof candidate.href !== 'string' ||
    typeof candidate.label !== 'string'
  ) {
    return null
  }
  if (!isSafeHttpsUrl(candidate.href) || candidate.label.trim().length === 0) {
    return null
  }
  const dashboardHref =
    typeof candidate['dashboard-href'] === 'string' &&
    candidate['dashboard-href'].startsWith('#page-')
      ? candidate['dashboard-href']
      : null
  const dashboardLabel =
    typeof candidate['dashboard-label'] === 'string' &&
    candidate['dashboard-label'].trim().length > 0
      ? candidate['dashboard-label']
      : candidate.label
  return dashboardHref
    ? {
        href: dashboardHref,
        label: dashboardLabel,
        externalHref: candidate.href,
      }
    : { href: candidate.href, label: candidate.label }
}

/**
 * Determines whether a resolved safe link points outside the dashboard (as
 * opposed to an internal `#`-prefixed navigation anchor). Every safe-link
 * anchor renderer in this module bases its `target`/`rel` wiring on this
 * check.
 * @param {SafeLink} link
 * @returns {boolean}
 */
function isExternalLink(link) {
  return !link.href.startsWith('#')
}

/**
 * Builds the shared anchor attribute set used by every safe-link renderer in
 * this module: an internal (`#`-prefixed) href renders a plain anchor, while
 * an external href adds `target="_blank"` and `rel="noopener noreferrer"`.
 * @param {SafeLink} link
 * @param {boolean} external
 * @returns {{ href: string, target: string | undefined, rel: string | undefined, 'aria-label': string }}
 */
function safeLinkAnchorAttrs(link, external) {
  return {
    href: link.href,
    target: external ? '_blank' : undefined,
    rel: external ? 'noopener noreferrer' : undefined,
    'aria-label': link.label,
  }
}

/**
 * Builds the attribute set for a plain external anchor (`target="_blank"`,
 * `rel="noopener noreferrer"`) for callers that already hold a raw href/label
 * pair rather than a resolved {@link SafeLink}. Shares the same
 * target/rel/aria-label wiring as every other safe-link anchor in this
 * module.
 * @param {string} href
 * @param {string} label
 * @returns {{ href: string, target: string | undefined, rel: string | undefined, 'aria-label': string }}
 */
export function externalAnchorAttrs(href, label) {
  return safeLinkAnchorAttrs({ href, label }, true)
}

/**
 * Renders a github.com Actions run URL as an external link labeled with its run ID.
 * @param {unknown} value
 * @returns {HTMLElement | null}
 */
export function renderWorkflowRunUrl(value) {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    const match = url.pathname.match(
      /^\/[^/]+\/[^/]+\/actions\/runs\/([1-9]\d*)\/?$/,
    )
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || !match)
      return null
    return renderExternalLink({ href: url.href, label: match[1] })
  } catch {
    return null
  }
}

/**
 * @param {SafeLink} link
 * @returns {HTMLElement}
 */
export function renderExternalLink(link) {
  const external = isExternalLink(link)
  return h(
    'a',
    safeLinkAnchorAttrs(link, external),
    link.label,
    ...(external ? [octicon('external-link')] : []),
  )
}

/**
 * Renders a safe link when present, falling back to plain content otherwise.
 * @param {SafeLink | null} link
 * @param {string} [labelOverride] Overrides the link's label when present.
 * @param {unknown} [fallback] Content rendered when no safe link is available.
 * @returns {HTMLElement | unknown}
 */
export function renderExternalLinkOrFallback(
  link,
  labelOverride,
  fallback = null,
) {
  return link
    ? renderExternalLink(
        labelOverride ? { ...link, label: labelOverride } : link,
      )
    : fallback
}

/**
 * Renders a workflow run label as a link when the row includes a safe run link.
 * @param {Record<string, unknown>} row
 * @param {string} label
 * @param {unknown} [trailingContent] Optional content appended to the linked label.
 * @returns {string | HTMLElement}
 */
export function renderWorkflowRunLink(row, label, trailingContent) {
  const link = findLink(row, 'run-link')
  return link
    ? h(
        'a',
        safeLinkAnchorAttrs(link, isExternalLink(link)),
        label,
        trailingContent,
      )
    : label
}

/**
 * Resolves a compact #identifier link from JSON-selected row fields.
 * @param {Record<string, unknown>} row
 * @param {unknown} config
 * @returns {SafeLink | null}
 */
export function resolveTitleLink(row, config) {
  if (!isPlainObject(config)) return null
  const hrefField = config['href-field']
  const identifierField = config['identifier-field']
  if (typeof hrefField !== 'string' || typeof identifierField !== 'string')
    return null
  const link = findLink(row, hrefField)
  const value = row[identifierField]
  const identifier =
    typeof value === 'string' || typeof value === 'number'
      ? String(value).trim()
      : ''
  if (!link || identifier.length === 0 || identifier.length > 100) return null
  return {
    href: link.externalHref ?? link.href,
    label: `#${identifier}`,
  }
}

/**
 * Renders a durable-output title as an internal detail link.
 * @param {Record<string, unknown>} row
 * @param {string} label
 * @returns {string | HTMLElement}
 */
export function renderOutcomeLink(row, label) {
  const outcomeId =
    typeof row['safe-output'] === 'string' ? row['safe-output'].trim() : ''
  return outcomeId && outcomeId.length <= 700
    ? h(
        'a',
        {
          href: `#page-outcome-detail?outcome=${encodeURIComponent(outcomeId)}`,
          title: label,
        },
        label,
      )
    : label
}

/**
 * Renders arbitrary content as a safe anchor when a link is available, otherwise returns the
 * content unchanged. Shares the external-link detection and target/rel/aria-label wiring used
 * by every safe-link renderer in the dashboard so anchor semantics stay consistent.
 * @param {string | HTMLElement} content
 * @param {SafeLink | null} link
 * @returns {string | HTMLElement}
 */
export function renderSafeLink(content, link) {
  if (!link) return content
  return h('a', safeLinkAnchorAttrs(link, isExternalLink(link)), content)
}

/**
 * @param {string | HTMLElement} value
 * @param {SafeLink | null} link
 * @returns {string | HTMLElement}
 */
export function renderLinkedValue(value, link) {
  return renderSafeLink(value, link)
}
