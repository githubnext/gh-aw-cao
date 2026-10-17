/**
 * Site-wide dashboard notices with volatile dismissal state.
 */

import { createDebug } from '../debug.js';
import { batch, effect, state } from '../reactive.js';
import { publishNotification, resolveNotification } from '../notification-service.js';
import { subscribeCalloutVisibility } from '../data/callouts.js';

const debugSiteCallout = createDebug('site-callout');

/**
 * @typedef {{ id: string, title: string, description: string, icon?: string, ['navigation-page']?: string, ['visible-when']?: { source: string, field: string, equals?: unknown, ['older-than-hours']?: number } }} SiteCallout
 */

/**
 * Presents worker-evaluated callout conditions without inspecting source rows.
 * @param {SiteCallout[] | undefined} callouts
 * @param {Record<string, import('../presenter.js').LogicalSourceInput>} sources
 * @param {import('../presenter.js').PageSourceLoader | undefined} loader
 * @param {AbortSignal} signal
 * @param {Array<{ id: string, title?: string }>} pages
 */
export function bindSiteCallouts(callouts, sources, loader, signal, pages) {
  if (!callouts?.length || signal.aborted) return null;
  const visibility = state(callouts.map((callout) => ({
    id: callout.id,
    visibility: /** @type {import('../data/queries/callouts.js').CalloutVisibility['visibility']} */ (
      callout['visible-when'] ? 'unavailable' : 'visible'
    )
  })));
  const failed = state(false);
  /** @type {Map<string, import('../notification-service.js').NotificationHandle>} */
  const handles = new Map();
  const failureId = 'site-callouts:unavailable';
  effect(() => {
    const conditions = visibility.get();
    let visibleCount = 0;
    for (const [index, callout] of callouts.entries()) {
      const id = `site-callout:${callout.id}`;
      const condition = conditions[index].visibility;
      if (failed.get() || condition !== 'visible') {
        if (failed.get() || condition === 'unavailable') handles.get(id)?.dismiss();
        else resolveNotification(id);
        handles.delete(id);
        continue;
      }
      visibleCount += 1;
      const page = callout['navigation-page'];
      const notification = {
        id,
        message: callout.title,
        description: callout.description,
        icon: callout.icon,
        jsonPath: `$.dashboard.callouts[${index}]`,
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
    debugSiteCallout({ event: 'rendered', declaredCount: callouts.length, visibleCount });
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
  if (callouts.some((callout) => callout['visible-when'])) {
    subscribeCalloutVisibility(callouts, sources, loader, signal, (result) => {
      batch(() => {
        visibility.set(result);
        failed.set(false);
      });
    }, (error) => {
      debugSiteCallout({ event: 'subscription-failed', errorName: error instanceof Error ? error.name : 'unknown' });
      failed.set(true);
    });
  }
  return null;
}
