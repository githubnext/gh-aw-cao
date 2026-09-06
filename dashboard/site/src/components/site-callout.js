/**
 * Site-wide dashboard notices with volatile dismissal state.
 */

import { h } from '../dom.js';
import { renderCloseButton, renderIconSpan } from './ui-primitives.js';

const dismissedCalloutIds = new Set();

/**
 * @typedef {{ id: string, title: string, description: string, icon?: string, ['navigation-page']?: string, ['visible-when']?: { source: string, field: string, equals: unknown } }} SiteCallout
 */

/**
 * @typedef {{ rows?: Array<Record<string, unknown>> }} CalloutSource
 */

/**
 * @param {SiteCallout[] | undefined} callouts
 * @param {Record<string, CalloutSource>} sources
 * @returns {HTMLElement | null}
 */
export function renderSiteCallouts(callouts, sources) {
  if (!Array.isArray(callouts)) return null;
  const visibleCallouts = callouts.filter((callout) => (
    !dismissedCalloutIds.has(callout.id) && matchesVisibility(callout['visible-when'], sources)
  ));
  if (visibleCallouts.length === 0) return null;
  return h(
    'section',
    { className: 'site-callouts', 'aria-label': 'Dashboard notices' },
    visibleCallouts.map(renderSiteCallout)
  );
}

/**
 * @param {SiteCallout} callout
 * @returns {HTMLElement}
 */
export function renderSiteCallout(callout) {
  const headingId = `site-callout-${callout.id}-heading`;
  const descriptionId = `site-callout-${callout.id}-description`;
  const content = h(
    'span',
    { className: 'site-callout-content' },
    h('strong', { id: headingId }, callout.title),
    h('span', { id: descriptionId }, callout.description)
  );
  const linkedContent = callout['navigation-page']
    ? h('a', { href: `#page-${callout['navigation-page']}`, className: 'site-callout-link' }, content)
    : content;
  const element = h(
    'aside',
    {
      className: 'site-callout',
      role: 'status',
      'aria-labelledby': headingId,
      'aria-describedby': descriptionId,
      'data-site-callout': callout.id
    },
    renderIconSpan('site-callout-icon', typeof callout.icon === 'string' ? callout.icon : 'info'),
    linkedContent,
    renderCloseButton({
      className: 'site-callout-dismiss',
      label: `Dismiss ${callout.title}`,
      onClick: () => {
        dismissedCalloutIds.add(callout.id);
        element.remove();
      }
    })
  );
  return element;
}

/**
 * @param {SiteCallout['visible-when']} visibility
 * @param {Record<string, CalloutSource>} sources
 * @returns {boolean}
 */
function matchesVisibility(visibility, sources) {
  if (!visibility) return true;
  return (sources[visibility.source]?.rows ?? []).some((row) => row[visibility.field] === visibility.equals);
}
