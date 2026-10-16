/**
 * Site-wide dashboard notices with volatile dismissal state.
 */

import { h } from '../dom.js';
import { renderCloseButton, renderIconSpan } from './ui-primitives.js';
import { createDebug } from '../debug.js';
import { render, state } from '../reactive.js';
import { timestampMilliseconds } from '../data/model/schema.js';

const debugSiteCallout = createDebug('site-callout');

const dismissedCalloutIds = state(new Set());

/**
 * @typedef {{ id: string, title: string, description: string, icon?: string, ['navigation-page']?: string, ['visible-when']?: { source: string, field: string, equals?: unknown, ['older-than-hours']?: number } }} SiteCallout
 */

/**
 * @typedef {{ rows?: Array<Record<string, unknown>>, metadata?: { availability?: string } }} CalloutSource
 */

/**
 * Clock-based visibility is shell presentation; source selection and the newest
 * evidence timestamp are produced by the declared worker query.
 * @param {SiteCallout[] | undefined} callouts
 * @param {Record<string, import('../presenter.js').LogicalSourceInput>} sources
 * @param {import('../presenter.js').PageSourceLoader | undefined} loader
 * @param {AbortSignal} signal
 * @param {Array<{ id: string, title?: string }>} pages
 */
export function bindSiteCallouts(callouts, sources, loader, signal, pages) {
  if (!callouts?.length || signal.aborted) return null;
  const element = h('div', { className: 'site-callouts-host' });
  const current = state(sources);
  const clock = state(Date.now());
  const failed = state(false);
  render(element, () => failed.get()
    ? h('p', { className: 'site-callouts', role: 'status' },
      'Dashboard notice data is unavailable. Freshness could not be checked.')
    : renderSiteCallouts(callouts, current.get(), {
      now: clock.get(),
      pageTitles: Object.fromEntries(pages.map((page) => [page.id, page.title ?? page.id]))
    }), { signal });
  if (callouts.some((callout) => callout['visible-when']?.['older-than-hours'] !== undefined)) {
    const timer = setInterval(() => clock.set(Date.now()), 60_000);
    signal.addEventListener('abort', () => clearInterval(timer), { once: true });
  }
  const names = [...new Set(callouts.flatMap((callout) => (
    callout['visible-when'] ? [callout['visible-when'].source] : []
  )))];
  if (loader?.subscribeBackgroundSources && names.length && !signal.aborted) {
    /** @param {Record<string, import('../presenter.js').LogicalSourceInput>} next */
    const update = (next) => {
      if (!signal.aborted) {
        failed.set(false);
        current.set(next);
      }
    };
    void loader.subscribeBackgroundSources(names, { signal, onUpdate: update })
      .then(update)
      .catch((error) => {
        if (signal.aborted) return;
        debugSiteCallout({ event: 'subscription-failed', errorName: error instanceof Error ? error.name : 'unknown' });
        failed.set(true);
      });
  }
  return element;
}

/**
 * @param {SiteCallout[] | undefined} callouts
 * @param {Record<string, CalloutSource>} sources
 * @param {{ now?: number, pageTitles?: Record<string, string> }} [options]
 * @returns {HTMLElement | null}
 */
export function renderSiteCallouts(callouts, sources, options = {}) {
  if (!Array.isArray(callouts)) return null;
  const visibleCallouts = callouts.filter((callout) => (
    !dismissedCalloutIds.get().has(callout.id) && matchesVisibility(callout['visible-when'], sources, options.now ?? Date.now())
  ));
  debugSiteCallout({
    event: 'rendered',
    declaredCount: callouts.length,
    visibleCount: visibleCallouts.length
  });
  if (visibleCallouts.length === 0) return null;
  return h(
    'section',
    { className: 'site-callouts', 'aria-label': 'Dashboard notices' },
    visibleCallouts.map((callout) => renderSiteCallout(callout, options.pageTitles?.[callout['navigation-page'] ?? '']))
  );
}

/**
 * @param {SiteCallout} callout
 * @param {string} [pageTitle]
 * @returns {HTMLElement}
 */
export function renderSiteCallout(callout, pageTitle) {
  const headingId = `site-callout-${callout.id}-heading`;
  const descriptionId = `site-callout-${callout.id}-description`;
  const content = h(
    'span',
    { className: 'site-callout-content' },
    h('strong', { id: headingId }, callout.title),
    h('span', { id: descriptionId }, callout.description),
    callout['navigation-page']
      ? h(
          'a',
          { href: `#page-${callout['navigation-page']}`, className: 'site-callout-link' },
          `View ${pageTitle ?? callout['navigation-page'].replaceAll('-', ' ')}`
        )
      : null
  );
  const element = h(
    'aside',
    {
      className: 'site-callout',
      role: 'status',
      'aria-labelledby': headingId,
      'aria-describedby': descriptionId,
      'data-key': callout.id,
      'data-site-callout': callout.id
    },
    renderIconSpan('site-callout-icon', typeof callout.icon === 'string' ? callout.icon : 'info'),
    content,
    renderCloseButton({
      className: 'site-callout-dismiss',
      label: `Dismiss ${callout.title}`,
      onClick: () => {
        dismissedCalloutIds.set((current) => new Set([...current, callout.id]));
        debugSiteCallout({ event: 'dismissed', id: callout.id });
        element.remove();
      }
    })
  );
  return element;
}

/**
 * @param {SiteCallout['visible-when']} visibility
 * @param {Record<string, CalloutSource>} sources
 * @param {number} now
 * @returns {boolean}
 */
function matchesVisibility(visibility, sources, now) {
  if (!visibility) return true;
  const source = sources[visibility.source];
  if (source?.metadata?.availability === 'unavailable') return false;
  return (source?.rows ?? []).some((row) => {
    if (visibility['older-than-hours'] === undefined) return row[visibility.field] === visibility.equals;
    const value = row[visibility.field];
    const timestamp = typeof value === 'number' && Number.isFinite(value) ? value : timestampMilliseconds(value);
    return timestamp !== null && now - timestamp >= visibility['older-than-hours'] * 3_600_000;
  });
}
