/**
 * Presentation-only reusable UI primitives shared across dashboard components.
 */

import { h } from '../dom.js';
import { octicon } from '../octicons.js';

/**
 * @typedef {{
 *   kicker: string,
 *   id: string,
 *   title: string,
 *   description?: string,
 *   summary?: string,
 *   headingTag?: 'h2'|'h3'|'h4'
 * }} SectionHeadingOptions
 */

/**
 * @param {SectionHeadingOptions} options
 * @returns {HTMLElement}
 */
export function renderSectionHeading({
  kicker,
  id,
  title,
  description,
  summary,
  headingTag = 'h3'
}) {
  return h(
    'div',
    { className: 'section-heading' },
    h(
      'div',
      null,
      h('span', { className: 'scope-kicker' }, kicker),
      h(headingTag, { id }, title),
      description ? h('p', null, description) : null
    ),
    summary ? h('strong', null, summary) : null
  );
}

/**
 * Renders a panel `<header>` containing an id-anchored heading and an
 * optional descriptive paragraph. Shared by the package summary,
 * package utilization, unavailable-trend, and value-history panels, which
 * all pair one `aria-labelledby` heading with plain descriptive copy.
 * @param {string} headingId
 * @param {string} heading
 * @param {string} [description]
 * @param {{ className?: string }} [options]
 * @returns {HTMLElement}
 */
export function renderPanelHeader(headingId, heading, description, options = {}) {
  return h(
    'header',
    options.className ? { className: options.className } : null,
    h('h3', { id: headingId }, heading),
    description ? h('p', null, description) : null
  );
}

/**
 * Renders a `<tr>` of `<th scope="col">` header cells from plain label
 * strings. Shared by the package summary table and the workflow
 * operational-value observation table, which both build a single header
 * row from a flat list of column labels.
 * @param {string[]} labels
 * @returns {HTMLElement}
 */
export function renderTableHeadRow(labels) {
  return h('tr', null, ...labels.map((label) => h('th', { scope: 'col' }, label)));
}

/**
 * Renders a single `<div><dt>{term}</dt><dd>{description}</dd></div>` row for
 * use inside a `<dl>`, optionally followed by a trailing detail paragraph.
 * Shared by vital-stat metrics, metadata summary rows, and definition-list
 * rows across the dashboard.
 * @param {Node | string | Array<Node | string | null>} term
 * @param {unknown} description
 * @param {string} [detail]
 * @returns {HTMLElement}
 */
export function renderDlRow(term, description, detail) {
  return h('div', null, h('dt', null, ...(Array.isArray(term) ? term : [term])), h('dd', null, description), detail ? h('p', null, detail) : null);
}

/**
 * @param {string} label
 * @param {unknown} value
 * @param {string} [detail]
 * @returns {HTMLElement}
 */
export function renderVitalStat(label, value, detail) {
  return renderDlRow(label, value, detail);
}

/**
 * @param {{ id: string, label: string, description: string, icon: Node, content?: Node }} options
 * @returns {HTMLElement}
 */
export function renderTooltip({ id, label, description, icon, content }) {
  return h(
    'span',
    { className: 'tooltip-help' },
    h(
      'button',
      {
        type: 'button',
        className: 'tooltip-trigger',
        'aria-label': label,
        'aria-describedby': id
      },
      icon
    ),
    h(
      'span',
      { id, className: 'tooltip-content', role: 'tooltip' },
      h('span', { className: 'tooltip-description' }, description),
      content
    )
  );
}

/**
 * Computes the whole-hour span between a metadata object's `coverage-start`
 * and `coverage-end` fields, or `null` when either bound is missing, invalid,
 * or non-increasing.
 * @param {{ 'coverage-start'?: unknown, 'coverage-end'?: unknown } | undefined} metadata
 * @returns {number | null}
 */
export function coverageWindowHours(metadata) {
  const start = Date.parse(String(metadata?.['coverage-start'] ?? ''));
  const end = Date.parse(String(metadata?.['coverage-end'] ?? ''));
  return Number.isFinite(start) && Number.isFinite(end) && end > start
    ? Math.round((end - start) / 3_600_000)
    : null;
}

/**
 * Builds a short caveat sentence for a source's `completeness` metadata,
 * describing a named subject (e.g. `'usage'`, `'run'`) as partially or
 * unknowingly covered. Returns an empty string for complete or unrecognized
 * completeness values.
 * @param {string | undefined} completeness
 * @param {string} subject
 * @returns {string}
 */
export function completenessCaveat(completeness, subject) {
  if (completeness === 'partial') return `Partial ${subject} coverage.`;
  if (completeness === 'unknown') return `${subject[0].toUpperCase()}${subject.slice(1)} coverage is unknown.`;
  return '';
}

/**
 * Formats a `Date` or millisecond timestamp as a medium-date, short-time,
 * UTC string (e.g. `Aug 30, 2026, 10:00 AM`). Callers are responsible for
 * validating their input; invalid input renders `Invalid Date`.
 * @param {Date | number} input
 * @returns {string}
 */
export function formatMediumUtcDateTime(input) {
  return new Intl.DateTimeFormat('en', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC'
  }).format(input instanceof Date ? input : new Date(input));
}

/**
 * Formats a `Date` or millisecond timestamp as a medium-date-only, UTC
 * string (e.g. `Aug 30, 2026`), with no time-of-day component. Callers are
 * responsible for validating their input; invalid input renders `Invalid
 * Date`.
 * @param {Date | number} input
 * @returns {string}
 */
export function formatMediumUtcDate(input) {
  return new Intl.DateTimeFormat('en', {
    dateStyle: 'medium',
    timeZone: 'UTC'
  }).format(input instanceof Date ? input : new Date(input));
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function formatUtcDateTime(value) {
  const parsed = Date.parse(value == null ? '' : String(value));
  if (!Number.isFinite(parsed)) return 'Time unavailable';
  return formatMediumUtcDateTime(parsed);
}

/**
 * Renders the shared "no data" placeholder used by table-summary cells when
 * a column has no values eligible for summarization.
 * @param {string} message
 * @returns {HTMLElement}
 */
export function renderTableSummaryEmpty(message) {
  return h('span', { className: 'table-summary-empty' }, message);
}

/**
 * Renders the shared "empty" placeholder paragraph used across route views and
 * panels when there is no data to display.
 * @param {string} message
 * @param {Record<string, unknown>} [extraAttrs]
 * @returns {HTMLElement}
 */
export function renderEmptyMessage(message, extraAttrs) {
  return h('p', { className: 'empty', ...extraAttrs }, message);
}

/**
 * Renders the shared "single `<td>` spanning the full table width" empty-body
 * row used by table regions and package summary tables when there is no data
 * to display.
 * @param {number} colSpan
 * @param {string} message
 * @returns {HTMLElement}
 */
export function renderEmptyTableRow(colSpan, message) {
  return h('tr', null, h('td', { colSpan }, message));
}

/**
 * Renders the shared "`<ul>` of items, or a single fallback `<li>`" pattern
 * used by summary and provenance lists when there is no data to display.
 * @template T
 * @param {string} className
 * @param {T[]} items
 * @param {(item: T) => Node | string} renderItem
 * @param {string} fallbackMessage
 * @returns {HTMLElement}
 */
export function renderListWithFallback(className, items, renderItem, fallbackMessage) {
  return h(
    'ul',
    { className },
    items.length > 0 ? items.map((item) => h('li', null, renderItem(item))) : [h('li', null, fallbackMessage)]
  );
}

/**
 * Renders the shared "icon plus name" identity link used for package/entity
 * references (package summary rows, utilization cards, package status
 * cards), wrapping the label text in the caller-selected inline element.
 * @param {{ href: string, icon: string, label: string, className?: string, labelTag?: 'span'|'strong' }} options
 * @returns {HTMLElement}
 */
export function renderIdentityLink({ href, icon, label, className, labelTag = 'span' }) {
  return h('a', className ? { href, className } : { href }, octicon(icon), h(labelTag, null, label));
}

/**
 * Renders the shared decorative legend swatch (`<i>` with a series-specific
 * class and `aria-hidden`) used to color-key chart and trend legend entries.
 * @param {string} className
 * @returns {HTMLElement}
 */
export function renderLegendSwatch(className) {
  return h('i', { className, 'aria-hidden': 'true' });
}

/**
 * Renders the shared `<ul class="chart-legend ...">` of `<li>` entries, each
 * pairing a color-keyed {@link renderLegendSwatch} with caller-supplied
 * content. Shared by the line/bar series legend, the pie-chart legend, and
 * the outcome-diagnostic legend, which all build one list item per series
 * from a swatch class name and the series' own label markup.
 * @template T
 * @param {string} className full `className` for the `<ul>` element
 * @param {T[]} items
 * @param {(item: T, index: number) => string} swatchClassName
 * @param {(item: T, index: number) => Array<Node | string | null>} renderContent
 * @param {Record<string, unknown>} [extraAttrs]
 * @returns {HTMLElement}
 */
export function renderLegendList(className, items, swatchClassName, renderContent, extraAttrs) {
  return h(
    'ul',
    { className, ...extraAttrs },
    items.map((item, index) => h(
      'li',
      null,
      renderLegendSwatch(swatchClassName(item, index)),
      ...renderContent(item, index)
    ))
  );
}

/**
 * Renders a `<span>` wrapping a single octicon, used by the attention-domain
 * cards, readiness-verdict hero, and signal-list rows to present one
 * decorative or semantic icon inside a component-specific class name.
 * @param {string} className
 * @param {string} iconName
 * @param {{ ariaHidden?: boolean }} [options]
 * @returns {HTMLElement}
 */
export function renderIconSpan(className, iconName, options = {}) {
  return h(
    'span',
    options.ariaHidden ? { className, 'aria-hidden': 'true' } : { className },
    octicon(iconName)
  );
}

/**
 * Renders the shared dismiss/close icon button used by overlay-style
 * components (dialogs, callouts) that need a labelled "x" trigger with
 * matching `title` and `aria-label` text.
 * @param {{ className: string, label: string, onClick: (event: MouseEvent) => void }} options
 * @returns {HTMLButtonElement}
 */
export function renderCloseButton({ className, label, onClick }) {
  return /** @type {HTMLButtonElement} */ (h(
    'button',
    {
      type: 'button',
      className,
      title: label,
      'aria-label': label,
      onClick
    },
    octicon('x')
  ));
}

/**
 * Renders the shared `<label><span>{label}</span>{control}</label>` pattern
 * used to associate a visible text label with a form control (search
 * inputs, facet selects, time-window inputs) across the filter bar and
 * table region toolbars.
 * @param {string} label
 * @param {Node} control
 * @param {{ className?: string, prefix?: Node }} [options]
 * @returns {HTMLLabelElement}
 */
export function renderLabeledControl(label, control, options = {}) {
  return /** @type {HTMLLabelElement} */ (h(
    'label',
    options.className ? { className: options.className } : null,
    options.prefix,
    h('span', null, label),
    control
  ));
}

/**
 * Writes text to the clipboard via the async Clipboard API, resolving to
 * whether the copy succeeded. Shared by the table intent-action dialog and
 * the raw-policy panel, which both need a best-effort clipboard write that
 * degrades to a boolean result instead of throwing.
 * @param {string} content
 * @returns {Promise<boolean>}
 */
export async function copyTextToClipboard(content) {
  if (typeof navigator?.clipboard?.writeText !== 'function') return false;
  try {
    await navigator.clipboard.writeText(content);
    return true;
  } catch {
    return false;
  }
}

/**
 * Checks whether a value is a URL string using the https protocol with no embedded
 * credentials, the safety bar every dashboard link and href renderer applies before
 * trusting externally-sourced link data.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isSafeHttpsUrl(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
