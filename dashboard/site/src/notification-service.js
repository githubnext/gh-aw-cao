import { h, injectStyleOnce } from './dom.js';
import { octicon } from './octicons.js';
import { notificationStylesheet } from './styles.js';

const DEFAULT_DURATION = 5000;
const EXIT_DURATION = 180;
const MAX_DETAIL_MESSAGES = 100;
const TONES = new Set(['info', 'success', 'warning', 'error']);
let nextNotificationDetailId = 0;
/** @typedef {{ dismiss: () => void, update: (notification: string | Notification) => void }} NotificationHandle */
/** @typedef {{ publish: (notification: string | Notification) => NotificationHandle, connected: boolean, dispose: () => void }} NotificationService */
/** @type {WeakMap<Document, NotificationService>} */
const services = new WeakMap();

/**
 * @typedef {{
 *   message: string,
 *   icon?: 'download',
 *   detailsSubtitle?: string,
 *   tone?: 'info' | 'success' | 'warning' | 'error',
 *   duration?: number,
 *   details?: string[],
 *   action?: { label: string, run: () => void, placement?: 'details' },
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
    'aria-label': 'Notifications'
  });
  document.body.append(container);
  let disposed = false;
  /** @type {Set<ReturnType<typeof renderNotification>>} */
  const notifications = new Set();

  /**
   * @param {string | Notification} input
   */
  const publish = (input) => {
    if (disposed) throw new Error('Notification service has been disposed.');
    const notification = normalizeNotification(input);
    const rendered = renderNotification(notification, container, () => {
      notifications.delete(rendered);
      if (!container.childElementCount) container.hidden = true;
    });
    notifications.add(rendered);
    container.hidden = false;
    return rendered.handle;
  };

  return /** @type {NotificationService} */ ({
    publish,
    get connected() {
      return container.isConnected;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const notification of notifications) notification.remove();
      notifications.clear();
      container.remove();
      if (services.get(document)?.publish === publish) services.delete(document);
    }
  });
}

/**
 * Publishes a notification through the service owned by the document.
 * @param {string | Notification} notification
 * @param {Document} [document]
 */
export function publishNotification(notification, document = globalThis.document) {
  let service = services.get(document);
  if (!service || !service.connected) {
    service = createNotificationService(document);
    services.set(document, service);
  }
  return service.publish(notification);
}

/**
 * @param {string | Notification} input
 * @returns {Required<Pick<Notification, 'message' | 'tone' | 'duration' | 'details' | 'dismissOnCollapse'>> & Pick<Notification, 'action' | 'detailsSubtitle' | 'icon'>}
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
  const action = candidate.action
    && typeof candidate.action.label === 'string'
    && Boolean(candidate.action.label.trim())
    && typeof candidate.action.run === 'function'
      ? candidate.action
      : undefined;
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
  const icon = candidate.icon === 'download' ? candidate.icon : undefined;
  return { message: candidate.message.trim(), tone, duration, details, detailsSubtitle, icon, action, dismissOnCollapse };
}

/**
 * @param {ReturnType<typeof normalizeNotification>} initial
 * @param {HTMLElement} container
 * @param {() => void} onRemove
 */
function renderNotification(initial, container, onRemove) {
  const message = h('span', {
    className: 'dashboard-notification-message',
    role: initial.tone === 'error' ? 'alert' : 'status'
  }, initial.message);
  const icon = h('span', {
    className: 'dashboard-notification-icon',
    'aria-hidden': 'true'
  });
  const summary = h('span', { className: 'dashboard-notification-summary' }, icon, message);
  const detailId = `dashboard-notification-details-${++nextNotificationDetailId}`;
  const detailSubtitleId = `${detailId}-subtitle`;
  const toggle = h('button', {
    className: 'dashboard-notification-toggle',
    type: 'button',
    'aria-expanded': 'false',
    'aria-controls': `${detailSubtitleId} ${detailId}`,
    'aria-label': `${initial.message} Show ingestion progress history`
  }, summary, h('span', { className: 'dashboard-notification-chevron', 'aria-hidden': 'true' }));
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
  const action = h('button', {
    className: 'dashboard-notification-action',
    type: 'button'
  });
  const element = h('div', {
    className: `dashboard-notification dashboard-notification-${initial.tone} dashboard-notification-enter`
  }, content);
  let current = initial;
  let removed = false;
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
    const followsLatest = details.scrollTop + details.clientHeight >= details.scrollHeight - 1;
    const scrollTop = details.scrollTop;
    current.details.forEach((detail, index) => {
      const item = details.children[index] ?? h('li', {});
      item.textContent = detail;
      if (item.parentElement !== details) details.append(item);
    });
    while (details.children.length > current.details.length) details.lastElementChild?.remove();
    details.scrollTop = followsLatest ? details.scrollHeight : scrollTop;
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
      content.prepend(summary);
    }
    const expandedState = toggle.getAttribute('aria-expanded') === 'true';
    toggle.setAttribute(
      'aria-label',
      `${current.message} ${expandedState ? 'Hide' : 'Show'} ingestion progress history`
    );
  };
  const setAction = () => {
    action.remove();
    if (!current.action) return;
    action.textContent = current.action.label;
    action.onclick = () => current.action?.run();
    action.hidden = current.action.placement === 'details'
      && toggle.getAttribute('aria-expanded') !== 'true';
    (current.action.placement === 'details' ? content : element).append(action);
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
    action.hidden = Boolean(current.action?.placement === 'details' && expanded);
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
  const dismiss = () => {
    if (removed || element.classList.contains('dashboard-notification-exit')) return;
    element.classList.add('dashboard-notification-exit');
    element.addEventListener('transitionend', remove, { once: true });
    removalTimer = setTimeout(remove, EXIT_DURATION);
  };
  const handle = {
    dismiss,
    /** @param {string | Notification} next */
    update(next) {
      if (removed) return;
      current = normalizeNotification(next);
      message.textContent = current.message;
      element.className = `dashboard-notification dashboard-notification-${current.tone}`;
      message.setAttribute('role', current.tone === 'error' ? 'alert' : 'status');
      setIcon();
      setDetails();
      setAction();
      scheduleDismissal();
    }
  };

  setIcon();
  setDetails();
  setAction();
  container.append(element);
  requestAnimationFrame(() => element.classList.remove('dashboard-notification-enter'));
  scheduleDismissal();
  return { handle, remove };
}
