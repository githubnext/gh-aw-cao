/**
 * Site-wide dashboard notices with volatile dismissal state.
 */

import { createDebug } from '../debug.js';
import { effect, state } from '../reactive.js';
import { timestampMilliseconds } from '../data/model/schema.js';
import { publishNotification, resolveNotification } from '../notification-service.js';

const debugSiteCallout = createDebug('site-callout');

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
  const current = state(sources);
  const clock = state(Date.now());
  const failed = state(false);
  /** @type {Map<string, import('../notification-service.js').NotificationHandle>} */
  const handles = new Map();
  const failureId = 'site-callouts:unavailable';
  effect(() => {
    const visible = failed.get() ? [] : visibleSiteCallouts(callouts, current.get(), clock.get());
    for (const callout of callouts) {
      const id = `site-callout:${callout.id}`;
      if (!visible.includes(callout)) {
        // An unavailable query is not evidence that the condition resolved.
        const visibility = callout['visible-when'];
        const source = visibility ? current.get()[visibility.source] : undefined;
        if (failed.get() || (visibility && (!source || source.metadata?.availability === 'unavailable'))) handles.get(id)?.dismiss();
        else resolveNotification(id);
        handles.delete(id);
        continue;
      }
      const page = callout['navigation-page'];
      const notification = {
        id,
        message: callout.title,
        description: callout.description,
        icon: callout.icon,
        jsonPath: `$.dashboard.callouts[${callouts.indexOf(callout)}]`,
        tone: /** @type {const} */ ('warning'),
        duration: 0,
        ...(page ? {
          href: `#page-${page}`,
          linkLabel: `View ${pages.find((entry) => entry.id === page)?.title ?? page.replaceAll('-', ' ')}`
        } : {})
      };
      const handle = handles.get(id);
      if (handle) handle.update(notification);
      else handles.set(id, publishNotification(notification));
    }
    if (failed.get()) {
      handles.set(failureId, publishNotification({
        id: failureId,
        message: 'Dashboard notice data is unavailable. Freshness could not be checked.',
        tone: 'warning', duration: 0
      }));
    } else {
      resolveNotification(failureId);
      handles.delete(failureId);
    }
  }, { signal });
  signal.addEventListener('abort', () => {
    for (const handle of handles.values()) handle.dismiss();
    handles.clear();
  }, { once: true });
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
  return null;
}

/**
 * @param {SiteCallout[] | undefined} callouts
 * @param {Record<string, CalloutSource>} sources
 * @param {number} [now]
 * @returns {SiteCallout[]}
 */
export function visibleSiteCallouts(callouts, sources, now = Date.now()) {
  if (!Array.isArray(callouts)) return [];
  const visibleCallouts = callouts.filter((callout) => (
    matchesVisibility(callout['visible-when'], sources, now)
  ));
  debugSiteCallout({
    event: 'rendered',
    declaredCount: callouts.length,
    visibleCount: visibleCallouts.length
  });
  return visibleCallouts;
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
