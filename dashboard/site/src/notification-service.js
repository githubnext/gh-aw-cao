import { button, h, injectStyleOnce, span } from './dom.js';
import { octicon } from './octicons.js';
import { notificationStylesheet } from './styles.js';
import { createDebug } from './debug.js';
import { renderCloseButton } from './components/ui-primitives.js';
import { DASHBOARD_THEME_CHANGE_EVENT, restoreDashboardTheme } from './components/theme-settings.js';
import { batch, effect, onCleanup, render, state, untracked } from './reactive.js';
import { createFactoryScope } from './components/factory-elements.js';

const debug = createDebug('notification-service');

const DEFAULT_DURATION = 5000;
const EXIT_DURATION = 180;
const MAX_DETAIL_MESSAGES = 100;
const TONES = new Set(['info', 'success', 'warning', 'error']);
let nextNotificationDetailId = 0;
/** @typedef {{ dismiss: () => void, update: (notification: string | Notification) => void }} NotificationHandle */
/** @typedef {{ publish: (notification: string | Notification) => NotificationHandle, resolve: (id: string) => void, connected: boolean, dispose: () => void }} NotificationService */
/** @type {WeakMap<Document, NotificationService>} */
const services = new WeakMap();

/**
 * @typedef {{
 *   id?: string,
 *   message: string,
 *   description?: string,
 *   href?: string,
 *   linkLabel?: string,
 *   jsonPath?: string,
 *   icon?: string,
 *   detailsSubtitle?: string,
 *   tone?: 'info' | 'success' | 'warning' | 'error',
 *   duration?: number,
 *   details?: string[],
 *   action?: { label: string, run: () => void, placement?: 'details' },
 *   actions?: Array<{ label: string, run: () => void, placement?: 'details' }>,
 *   dismissOnCollapse?: boolean
 * }} Notification
 */

/**
 * @param {Document} document
 */
export function createNotificationService(document) {
  injectStyleOnce(document, 'dashboard-notification-styles', notificationStylesheet());
  const container = h('div', {
    className: 'dashboard-notifications',
    'aria-label': 'Notifications',
    role: 'region',
    hidden: true
  });
  document.body.append(container);
  const syncTheme = () => restoreDashboardTheme(container);
  syncTheme();
  document.addEventListener(DASHBOARD_THEME_CHANGE_EVENT, syncTheme);
  let disposed = false;
  /** @type {Set<ReturnType<typeof renderNotification>>} */
  const notifications = new Set();
  /** @type {Map<string, { rendered: ReturnType<typeof renderNotification>, owner: symbol }>} */
  const keyed = new Map();
  const dismissed = new Set();

  /**
   * @param {string | Notification} input
   */
  const publish = (input) => {
    if (disposed) throw new Error('Notification service has been disposed.');
    const notification = normalizeNotification(input);
    const id = typeof input === 'object' ? input.id : undefined;
    if (id !== undefined && (typeof id !== 'string' || !id.trim())) {
      throw new TypeError('Notification ID must be a non-empty string.');
    }
    if (id && dismissed.has(id)) return { dismiss() {}, update() {} };
    const owner = Symbol();
    const existing = id ? keyed.get(id) : undefined;
    const handleFor = (/** @type {ReturnType<typeof renderNotification>} */ rendered) => ({
      dismiss() {
        if (!id || keyed.get(id)?.owner === owner) untracked(() => rendered.handle.dismiss());
      },
      /** @param {string | Notification} next */
      update(next) {
        if (!id || keyed.get(id)?.owner === owner) untracked(() => rendered.handle.update(next));
      }
    });
    if (existing && id) {
      keyed.set(id, { rendered: existing.rendered, owner });
      existing.rendered.handle.update(input);
      return handleFor(existing.rendered);
    }
    const rendered = renderNotification(notification, container, () => {
      notifications.delete(rendered);
      if (!container.childElementCount) container.hidden = true;
      debug({ event: 'dismissed', tone: notification.tone, activeCount: notifications.size });
    }, (userDismissed) => {
      if (id && keyed.get(id)?.rendered === rendered) keyed.delete(id);
      if (id && userDismissed) dismissed.add(id);
    });
    notifications.add(rendered);
    if (id) {
      keyed.set(id, { rendered, owner });
      rendered.element.dataset.notificationId = id;
    }
    container.hidden = false;
    debug({ event: 'published', tone: notification.tone, duration: notification.duration, activeCount: notifications.size });
    return handleFor(rendered);
  };

  return /** @type {NotificationService} */ ({
    publish,
    resolve(id) {
      dismissed.delete(id);
      untracked(() => keyed.get(id)?.rendered.handle.dismiss());
    },
    get connected() {
      return container.isConnected;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      const activeCount = notifications.size;
      for (const notification of notifications) notification.remove();
      notifications.clear();
      keyed.clear();
      dismissed.clear();
      document.removeEventListener(DASHBOARD_THEME_CHANGE_EVENT, syncTheme);
      container.remove();
      if (services.get(document)?.publish === publish) services.delete(document);
      debug({ event: 'disposed', activeCount });
    }
  });
}

/**
 * Publishes a notification through the service owned by the document.
 * An ID deduplicates updates and retains user dismissal until resolved.
 * The returned handle belongs to this publication; older owners cannot
 * update or dismiss a notice adopted by a newer publisher.
 * @param {string | Notification} notification
 * @param {Document} [document]
 */
export function publishNotification(notification, document = globalThis.document) {
  return notificationService(document).publish(notification);
}

/** Resolving a condition also permits a later recurrence to notify again.
 * @param {string} id
 * @param {Document} [document]
 */
export function resolveNotification(id, document = globalThis.document) {
  services.get(document)?.resolve(id);
}

/** @param {Document} document */
function notificationService(document) {
  let service = services.get(document);
  if (!service || !service.connected) {
    service?.dispose();
    service = createNotificationService(document);
    services.set(document, service);
  }
  return service;
}

/**
 * @param {string | Notification} input
 * @returns {Required<Pick<Notification, 'message' | 'tone' | 'duration' | 'details' | 'dismissOnCollapse' | 'actions'>> & Pick<Notification, 'detailsSubtitle' | 'icon' | 'href' | 'description' | 'linkLabel' | 'jsonPath'>}
 */
function normalizeNotification(input) {
  const candidate = typeof input === 'string' ? { message: input } : input;
  if (!candidate || typeof candidate.message !== 'string' || !candidate.message.trim()) {
    throw new TypeError('Notification message must be a non-empty string.');
  }
  const tone = TONES.has(candidate.tone ?? '')
    ? /** @type {'info' | 'success' | 'warning' | 'error'} */ (candidate.tone)
    : 'info';
  const duration = Number.isFinite(candidate.duration) && Number(candidate.duration) >= 0
    ? Number(candidate.duration)
    : DEFAULT_DURATION;
  const actionCandidates = Array.isArray(candidate.actions) ? candidate.actions : [candidate.action];
  const actions = actionCandidates.flatMap((action) =>
    action
      && typeof action.label === 'string'
      && Boolean(action.label.trim())
      && typeof action.run === 'function'
      ? [action]
      : []
  );
  const dismissOnCollapse = candidate.dismissOnCollapse === true;
  const details = Array.isArray(candidate.details)
    ? candidate.details
        .filter((detail) => typeof detail === 'string' && Boolean(detail.trim()))
        .map((detail) => detail.trim())
        .slice(-MAX_DETAIL_MESSAGES)
    : [];
  const detailsSubtitle = typeof candidate.detailsSubtitle === 'string' && candidate.detailsSubtitle.trim()
    ? candidate.detailsSubtitle.trim()
    : undefined;
  const icon = typeof candidate.icon === 'string' && candidate.icon.trim() ? candidate.icon : undefined;
  if (candidate.href !== undefined && (typeof candidate.href !== 'string'
    || !/^#page-[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(candidate.href))) {
    throw new TypeError('Notification links must reference a dashboard page.');
  }
  if (candidate.href && details.length) {
    throw new TypeError('Linked notifications cannot contain expandable details.');
  }
  return { message: candidate.message.trim(), tone, duration, details, detailsSubtitle, icon, actions, dismissOnCollapse,
    href: candidate.href, description: candidate.description, linkLabel: candidate.linkLabel, jsonPath: candidate.jsonPath };
}

/** @param {HTMLElement} details @param {string[]} messages */
export function updateNotificationDetails(details, messages) {
  const followsLatest = details.scrollTop + details.clientHeight >= details.scrollHeight - 1;
  const scrollTop = details.scrollTop;
  messages.forEach((detail, index) => {
    const item = details.children[index] ?? h('li', {});
    item.textContent = detail;
    if (item.parentElement !== details) details.append(item);
  });
  while (details.children.length > messages.length) details.lastElementChild?.remove();
  details.scrollTop = followsLatest ? details.scrollHeight : scrollTop;
}

/** @param {HTMLElement} element @param {Array<{ label: string, run: () => void }>} actions */
export function updateNotificationActions(element, actions) {
  actions.forEach((action, index) => {
    const control = /** @type {HTMLButtonElement} */ (element.children[index] ?? button({
      className: 'dashboard-notification-action',
      type: 'button'
    }));
    control.textContent = action.label;
    control.onclick = action.run;
    if (control.parentElement !== element) element.append(control);
  });
  while (element.children.length > actions.length) element.lastElementChild?.remove();
}

/**
 * @param {ReturnType<typeof normalizeNotification>} initial
 * @param {HTMLElement} container
 * @param {() => void} onRemove
 * @param {(userDismissed: boolean) => void} onDismiss
 */
function renderNotification(initial, container, onRemove, onDismiss) {
  const lifetime = new AbortController();
  const scope = createFactoryScope({ signal: lifetime.signal });
  const current = state(initial);
  const expanded = state(false);
  const entering = state(true);
  const dismissing = state(false);
  const element = h('div', {});
  const detailId = `dashboard-notification-details-${++nextNotificationDetailId}`;
  const detailSubtitleId = `${detailId}-subtitle`;
  let removed = false;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let removalTimer;
  const remove = () => {
    if (removed) return;
    removed = true;
    if (!dismissing.get()) onDismiss(false);
    if (removalTimer) clearTimeout(removalTimer);
    lifetime.abort();
    element.remove();
    onRemove();
  };
  const dismiss = (userDismissed = false) => {
    if (removed || dismissing.get()) return;
    onDismiss(userDismissed);
    dismissing.set(true);
    element.addEventListener('transitionend', remove, { once: true });
    removalTimer = setTimeout(remove, EXIT_DURATION);
  };
  let followsLatest = true;
  let scrollTop = 0;
  let wasExpanded = false;
  render(element, () => {
    const value = current.get();
    const open = expanded.get();
    const details = element.querySelector('.dashboard-notification-details');
    followsLatest = !details || (open && !wasExpanded)
      || details.scrollTop + details.clientHeight >= details.scrollHeight - 1;
    scrollTop = details?.scrollTop ?? 0;
    wasExpanded = open;
    const link = value.href ? h('a', {
      className: 'dashboard-notification-link', href: value.href
    }, value.linkLabel ?? value.message) : null;
    const summary = span({ className: 'dashboard-notification-summary', dataset: { key: 'summary' } },
      span({ className: 'dashboard-notification-icon', 'aria-hidden': 'true', hidden: !value.icon },
        value.icon ? octicon(value.icon) : null),
      span({
        className: 'dashboard-notification-message',
        role: value.tone === 'error' ? 'alert' : 'status',
        ...(value.description ? { 'aria-describedby': `${detailId}-description` } : {})
      }, link && !value.linkLabel ? link : value.message));
    const detailsActions = value.actions.every((action) => action.placement === 'details');
    const actions = value.actions.length ? h('div', {
      className: 'dashboard-notification-actions', dataset: { key: 'actions' },
      hidden: detailsActions && !open
    }, ...value.actions.map((action, index) => button({
      className: 'dashboard-notification-action', type: 'button',
      dataset: { key: `action-${index}` }, onClick: action.run
    }, action.label))) : null;
    return [
      h('div', { className: 'dashboard-notification-content', dataset: { key: 'content' } },
        value.details.length ? button({
          className: 'dashboard-notification-toggle', type: 'button',
          dataset: { key: 'toggle' },
          'aria-expanded': String(open), 'aria-controls': `${detailSubtitleId} ${detailId}`,
          'aria-label': `${value.message} ${open ? 'Hide' : 'Show'} ingestion progress history`,
          onClick: () => {
            if (expanded.get() && current.get().dismissOnCollapse) dismiss();
            else expanded.set((previous) => !previous);
          }
        }, summary, span({ className: 'dashboard-notification-chevron', 'aria-hidden': 'true' })) : summary,
        h('p', { className: 'dashboard-notification-description', id: `${detailId}-description`, hidden: !value.description }, value.description),
        value.linkLabel ? link : null,
        value.details.length && value.detailsSubtitle ? h('p', {
          className: 'dashboard-notification-details-subtitle', id: detailSubtitleId, hidden: !open
        }, value.detailsSubtitle) : null,
        value.details.length ? h('ul', {
          className: 'dashboard-notification-details', id: detailId, hidden: !open,
          onWheel: (/** @type {WheelEvent} */ event) => {
            const target = /** @type {HTMLElement} */ (event.currentTarget);
            const max = target.scrollHeight - target.clientHeight;
            if (max <= 0 || !event.deltaY) return;
            const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? target.clientHeight : 1;
            target.scrollTop = Math.max(0, Math.min(max, target.scrollTop + event.deltaY * scale));
            event.preventDefault();
          }
        }, ...value.details.map((detail, index) => h('li', { dataset: { key: `detail-${index}` } }, detail))) : null,
        detailsActions ? actions : null),
      detailsActions ? null : actions,
      renderCloseButton({
        className: 'dashboard-notification-dismiss', label: `Dismiss ${value.message}`,
        onClick: () => dismiss(true)
      })
    ];
  }, { signal: scope.signal });
  effect(() => {
    const value = current.get();
    element.className = `dashboard-notification dashboard-notification-${value.tone}${entering.get() ? ' dashboard-notification-enter' : ''}${dismissing.get() ? ' dashboard-notification-exit' : ''}`;
  }, { signal: scope.signal });
  effect(() => {
    const value = current.get();
    expanded.get();
    const details = element.querySelector('.dashboard-notification-details');
    if (details) details.scrollTop = followsLatest ? details.scrollHeight : scrollTop;
    const search = element.ownerDocument.defaultView?.location.search ?? '';
    const jsonPath = value.jsonPath;
    if (jsonPath && new URLSearchParams(search).get('debug') === '1') {
      void import('./dom-provenance.js').then(({ annotateDomTree }) => {
        if (!scope.signal.aborted && current.get().jsonPath === jsonPath) annotateDomTree(element, jsonPath);
      });
    }
  }, { signal: scope.signal });
  effect(() => {
    const value = current.get();
    if (dismissing.get() || !value.duration) return;
    const timer = setTimeout(() => dismiss(), value.duration);
    onCleanup(() => clearTimeout(timer));
  }, { signal: scope.signal });
  const frame = requestAnimationFrame(() => entering.set(false));
  scope.signal.addEventListener('abort', () => {
    cancelAnimationFrame(frame);
    remove();
  }, { once: true });
  const handle = {
    dismiss: () => dismiss(),
    /** @param {string | Notification} next */
    update(next) {
      if (removed || dismissing.get()) return;
      batch(() => {
        current.set(normalizeNotification(next));
        entering.set(false);
      });
    }
  };
  container.append(element);
  scope.bind(element);
  return { handle, remove, element };
}
