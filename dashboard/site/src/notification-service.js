import { button, h, injectStyleOnce, span } from './dom.js';
import { octicon } from './octicons.js';
import { notificationStylesheet } from './styles.js';
import { createDebug } from './debug.js';
import { renderCloseButton } from './components/ui-primitives.js';
import { DASHBOARD_THEME_CHANGE_EVENT, restoreDashboardTheme } from './components/theme-settings.js';

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
        if (!id || keyed.get(id)?.owner === owner) rendered.handle.dismiss();
      },
      /** @param {string | Notification} next */
      update(next) {
        if (!id || keyed.get(id)?.owner === owner) rendered.handle.update(next);
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
      keyed.get(id)?.rendered.handle.dismiss();
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
  const message = span({
    className: 'dashboard-notification-message',
    role: initial.tone === 'error' ? 'alert' : 'status'
  }, initial.message);
  const icon = span({
    className: 'dashboard-notification-icon',
    'aria-hidden': 'true'
  });
  const summary = span({ className: 'dashboard-notification-summary' }, icon, message);
  const detailId = `dashboard-notification-details-${++nextNotificationDetailId}`;
  const detailSubtitleId = `${detailId}-subtitle`;
  const toggle = button({
    className: 'dashboard-notification-toggle',
    type: 'button',
    'aria-expanded': 'false',
    'aria-controls': `${detailSubtitleId} ${detailId}`,
    'aria-label': `${initial.message} Show ingestion progress history`
  }, summary, span({ className: 'dashboard-notification-chevron', 'aria-hidden': 'true' }));
  const details = h('ul', {
    className: 'dashboard-notification-details',
    id: detailId,
    hidden: true
  });
  const detailsSubtitle = h('p', {
    className: 'dashboard-notification-details-subtitle',
    id: detailSubtitleId
  });
  const content = h('div', { className: 'dashboard-notification-content' });
  const description = h('p', { className: 'dashboard-notification-description' });
  description.id = `${detailId}-description`;
  content.append(description);
  const actions = h('div', { className: 'dashboard-notification-actions' });
  const element = h('div', {
    className: `dashboard-notification dashboard-notification-${initial.tone} dashboard-notification-enter`
  }, content);
  let current = initial;
  const annotate = () => {
    const search = element.ownerDocument.defaultView?.location.search ?? '';
    if (!current.jsonPath || new URLSearchParams(search).get('debug') !== '1') return;
    void import('./dom-provenance.js').then(({ annotateDomTree }) => {
      if (!removed && current.jsonPath) annotateDomTree(element, current.jsonPath);
    });
  };
  const messageLink = h('a', { className: 'dashboard-notification-link' });
  const setMessage = () => {
    if (current.href && !current.linkLabel) {
      messageLink.setAttribute('href', current.href);
      messageLink.textContent = current.message;
      if (messageLink.parentElement !== message) message.replaceChildren(messageLink);
    } else {
      message.textContent = current.message;
    }
    description.textContent = current.description ?? '';
    description.hidden = !current.description;
    if (current.description) message.setAttribute('aria-describedby', description.id);
    else message.removeAttribute('aria-describedby');
    if (current.href && current.linkLabel) {
      messageLink.setAttribute('href', current.href);
      messageLink.textContent = current.linkLabel;
      if (messageLink.parentElement !== content) content.append(messageLink);
    } else if (messageLink.parentElement === content) {
      messageLink.remove();
    }
  };
  let removed = false;
  let dismissing = false;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let dismissTimer;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let removalTimer;

  const setIcon = () => {
    icon.replaceChildren(...(current.icon ? [octicon(current.icon)] : []));
    icon.hidden = !current.icon;
  };
  const setDetails = () => {
    const expanded = toggle.getAttribute('aria-expanded') === 'true';
    updateNotificationDetails(details, current.details);
    if (current.details.length > 0) {
      if (summary.parentElement !== toggle) toggle.prepend(summary);
      if (!toggle.isConnected) content.prepend(toggle);
      details.hidden = !expanded;
      detailsSubtitle.textContent = current.detailsSubtitle ?? '';
      detailsSubtitle.hidden = !expanded || !current.detailsSubtitle;
      if (current.detailsSubtitle && !detailsSubtitle.isConnected) content.append(detailsSubtitle);
      if (!current.detailsSubtitle) detailsSubtitle.remove();
      if (!details.isConnected) content.append(details);
    } else {
      toggle.remove();
      detailsSubtitle.remove();
      details.remove();
      if (summary.parentElement !== content) content.prepend(summary);
    }
    const expandedState = toggle.getAttribute('aria-expanded') === 'true';
    toggle.setAttribute(
      'aria-label',
      `${current.message} ${expandedState ? 'Hide' : 'Show'} ingestion progress history`
    );
  };
  const setActions = () => {
    const placement = current.actions.every((action) => action.placement === 'details')
      ? 'details'
      : 'summary';
    updateNotificationActions(actions, current.actions);
    if (!current.actions.length) {
      actions.remove();
      return;
    }
    actions.hidden = placement === 'details'
      && toggle.getAttribute('aria-expanded') !== 'true';
    const parent = placement === 'details' ? content : element;
    if (actions.parentElement !== parent) parent.append(actions);
  };
  toggle.onclick = () => {
    const expanded = toggle.getAttribute('aria-expanded') === 'true';
    toggle.setAttribute('aria-expanded', String(!expanded));
    toggle.setAttribute(
      'aria-label',
      `${current.message} ${expanded ? 'Show' : 'Hide'} ingestion progress history`
    );
    details.hidden = expanded;
    detailsSubtitle.hidden = expanded || !current.detailsSubtitle;
    actions.hidden = Boolean(current.actions.length
      && current.actions.every((action) => action.placement === 'details')
      && expanded);
    if (!expanded) details.scrollTop = details.scrollHeight;
    if (expanded && current.dismissOnCollapse) dismiss();
  };
  details.addEventListener('wheel', (event) => {
    const maxScrollTop = details.scrollHeight - details.clientHeight;
    if (maxScrollTop <= 0 || event.deltaY === 0) return;
    const scale = event.deltaMode === 1
      ? 16
      : event.deltaMode === 2
        ? details.clientHeight
        : 1;
    details.scrollTop = Math.max(0, Math.min(maxScrollTop, details.scrollTop + event.deltaY * scale));
    event.preventDefault();
  }, { passive: false });
  const scheduleDismissal = () => {
    if (dismissTimer) clearTimeout(dismissTimer);
    dismissTimer = current.duration > 0 ? setTimeout(dismiss, current.duration) : undefined;
  };
  const remove = () => {
    if (removed) return;
    removed = true;
    if (dismissTimer) clearTimeout(dismissTimer);
    if (removalTimer) clearTimeout(removalTimer);
    element.remove();
    onRemove();
  };
  const dismiss = (userDismissed = false) => {
    if (removed || dismissing) return;
    dismissing = true;
    if (dismissTimer) clearTimeout(dismissTimer);
    onDismiss(userDismissed);
    element.classList.add('dashboard-notification-exit');
    element.addEventListener('transitionend', remove, { once: true });
    removalTimer = setTimeout(remove, EXIT_DURATION);
  };
  const close = renderCloseButton({
    className: 'dashboard-notification-dismiss',
    label: `Dismiss ${current.message}`,
    onClick: () => dismiss(true)
  });
  const handle = {
    dismiss: () => dismiss(),
    /** @param {string | Notification} next */
    update(next) {
      if (removed || dismissing) return;
      current = normalizeNotification(next);
      setMessage();
      element.className = `dashboard-notification dashboard-notification-${current.tone}`;
      message.setAttribute('role', current.tone === 'error' ? 'alert' : 'status');
      setIcon();
      setDetails();
      setActions();
      close.setAttribute('aria-label', `Dismiss ${current.message}`);
      close.setAttribute('title', `Dismiss ${current.message}`);
      annotate();
      scheduleDismissal();
    }
  };

  setMessage();
  setIcon();
  setDetails();
  setActions();
  element.append(close);
  container.append(element);
  annotate();
  requestAnimationFrame(() => element.classList.remove('dashboard-notification-enter'));
  scheduleDismissal();
  return { handle, remove, element };
}
