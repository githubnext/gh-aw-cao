/**
 * Reusable presentation-only section and metadata chrome helpers for dashboard pages.
 */

import { h } from '../dom.js';
import { octicon } from '../octicons.js';
import { renderDlRow, renderListWithFallback, renderSectionHeading, renderTooltip } from './ui-primitives.js';
import { formatCount, titleCase } from './count-formatters.js';

/**
 * @param {string} pageId
 * @param {string} title
 * @param {HTMLElement[]} content
 * @param {'h3'|'h4'} [headingTag]
 * @param {string} [description]
 * @returns {HTMLElement}
 */
export function renderPageSection(pageId, title, content, headingTag = 'h3', description) {
  const headingId = `${pageId}-${slugifyText(title)}-heading`;
  const tooltip = description
    ? renderTooltip({
        id: `${headingId}-description`,
        label: `${title} explanation`,
        description,
        icon: octicon('question')
      })
    : null;
  tooltip?.classList.add('view-description-tooltip');
  return h(
    'section',
    {
      className: `page-section${tooltip ? ' view-description-section' : ''}`,
      tabIndex: 0,
      'aria-labelledby': headingId
    },
    h(headingTag, { id: headingId }, title),
    ...content,
    ...(tooltip ? [tooltip] : [])
  );
}

/**
 * @param {string} pageId
 * @param {string} title
 * @param {HTMLElement} content
 * @returns {HTMLElement}
 */
export function renderTitledRegion(pageId, title, content) {
  return renderPageSection(pageId, title, [content]);
}

/**
 * @param {string} pageId
 * @param {string} title
 * @param {string} listClassName
 * @param {Map<string, number>} counts
 * @returns {HTMLElement}
 */
export function renderSummaryRegion(pageId, title, listClassName, counts) {
  return renderTitledRegion(pageId, title, renderSummaryList(listClassName, counts));
}

/**
 * @param {string} listClassName
 * @param {Map<string, number>} counts
 * @returns {HTMLElement}
 */
export function renderSummaryList(listClassName, counts) {
  const entries = [...counts.entries()];
  return renderListWithFallback(listClassName, entries, ([name, count]) => `${name}: ${count}`, 'No data available.');
}

/**
 * @param {string[]} details
 * @returns {HTMLElement}
 */
export function renderContextList(details) {
  return h('ul', { className: 'view-context' }, details.map((detail) => h('li', null, detail)));
}

/**
 * @param {string} className
 * @param {Array<Record<string, unknown>>} rows
 * @returns {HTMLElement}
 */
export function renderDefinitionList(className, rows) {
  return h('dl', { className }, ...renderDefinitionListRows(rows));
}

/**
 * @param {Array<Record<string, unknown>>} rows
 * @returns {HTMLElement[]}
 */
export function renderDefinitionListRows(rows) {
  return rows.map((row) => renderDlRow(String(row.label ?? ''), String(row.value ?? '')));
}

/**
 * @param {string[]} contextDetails
 * @returns {HTMLElement[]}
 */
export function renderContextChrome(contextDetails) {
  return contextDetails.length > 0 ? [renderContextList(contextDetails)] : [];
}

/**
 * @param {string[]} lines
 * @returns {HTMLElement[]}
 */
export function renderViewChrome(lines) {
  return lines.map((line) => h('p', { className: 'view-metadata' }, line));
}

/**
 * @param {{ 'as-of': string, completeness: string, freshness: string }} metadata
 * @param {string[]} contextDetails
 * @returns {HTMLElement[]}
 */
export function renderViewSectionChrome(metadata, contextDetails) {
  return renderContextChrome(contextDetails);
}

/**
 * @param {'available'|'empty'|'unavailable'} availability
 * @returns {string}
 */
export function customViewAvailabilityMessage(availability) {
  return availability === 'available'
    ? 'Data available.'
    : availability === 'empty'
      ? 'No observations matched the effective context.'
      : 'This view is unavailable.';
}

/**
 * @param {string | null} sourceName
 * @param {string[]} contextDetails
 * @returns {HTMLElement[]}
 */
export function renderCustomViewStateDetails(sourceName, contextDetails) {
  const details = [];
  if (sourceName) {
    details.push(h('p', { className: 'view-source' }, `Affected source: ${sourceName}`));
  }
  details.push(...renderContextChrome(contextDetails));
  return details;
}

/**
 * @param {Array<{ sourceName: string, sourceId: string, sourceKind: string, asOf: string }>} items
 * @returns {HTMLElement}
 */
export function renderProvenanceList(items) {
  return renderListWithFallback(
    'provenance-list',
    items,
    (item) => `${item.sourceName}: ${item.sourceId} (${item.sourceKind}) — as of ${item.asOf}`,
    'No source provenance available for this page.'
  );
}

/**
 * @param {string} pageId
 * @param {Array<{ sourceName: string, sourceId: string, sourceKind: string, asOf: string }>} items
 * @returns {HTMLElement}
 */
export function renderProvenanceSection(pageId, items) {
  return renderTitledRegion(pageId, 'Provenance', renderProvenanceList(items));
}

/**
 * @param {string} title
 * @param {Node} content
 * @param {'h2'|'h3'|'h4'} [headingTag]
 * @returns {HTMLElement}
 */
export function renderMetadataSection(title, content, headingTag = 'h2') {
  return h('section', null, h(headingTag, null, title), content);
}

/**
 * @param {string} headingId
 * @param {string} heading
 * @param {Node[]} body
 * @param {{
 *   sectionClassName?: string,
 *   headingTag?: 'h2'|'h3'|'h4',
 *   bodyClassName?: string,
 *   bodyAttributes?: Record<string, unknown>
 * }} [options]
 * @returns {HTMLElement}
 */
export function renderTitledBodySection(headingId, heading, body, options = {}) {
  const {
    sectionClassName,
    headingTag = 'h3',
    bodyClassName,
    bodyAttributes = {}
  } = options;
  const bodyProps = bodyClassName ? { ...bodyAttributes, className: bodyClassName } : bodyAttributes;
  const headingProps = headingId ? { id: headingId } : null;
  return h(
    'section',
    sectionClassName ? { className: sectionClassName } : null,
    h(headingTag, headingProps, heading),
    h('div', bodyProps, ...body)
  );
}

/**
 * @param {string} pageId
 * @param {{ id: string, title?: string, description?: string, layout: 'full'|'wide'|'narrow', views: string[], ['count-source']?: string, ['count-label']?: string }} section
 * @param {number | null} count
 * @returns {HTMLElement}
 */
export function renderLayoutSectionChrome(pageId, section, count) {
  const title = section.title ?? titleCase(section.id);
  const headingId = `${pageId}-${section.id}-layout-heading`;
  const sectionHeading = renderSectionHeading({
    kicker: titleCase(section.id),
    id: headingId,
    title,
    description: section.description
  });
  return h(
    'header',
    { className: 'layout-section-header' },
    sectionHeading,
    count !== null && section['count-label']
      ? h('strong', null, `${formatCount(count)} ${section['count-label']}`)
      : null
  );
}

/**
 * @param {string} value
 * @returns {string}
 */
function slugifyText(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'section';
}
