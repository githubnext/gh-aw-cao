import { h, injectStyleOnce } from './dom.js';
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
 *   tone?: 'info' | 'success' | 'warning' | 'error',
 *   duration?: number,
 *   details?: string[],
 *   action?: { label: string, run: () => void }
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
 * @returns {Required<Pick<Notification, 'message' | 'tone' | 'duration' | 'details'>> & Pick<Notification, 'action'>}
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
  const details = Array.isArray(candidate.details)
    ? candidate.details
        .filter((detail) => typeof detail === 'string' && Boolean(detail.trim()))
        .map((detail) => detail.trim())
        .slice(-MAX_DETAIL_MESSAGES)
    : [];
  return { message: candidate.message.trim(), tone, duration, details, action };
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
  const detailId = `dashboard-notification-details-${++nextNotificationDetailId}`;
  const toggle = h('button', {
    className: 'dashboard-notification-toggle',
    type: 'button',
    'aria-expanded': 'false',
    'aria-controls': detailId,
    'aria-label': `${initial.message} Show ingestion progress history`
  }, message, h('span', { className: 'dashboard-notification-chevron', 'aria-hidden': 'true' }));
  const details = h('ul', {
    className: 'dashboard-notification-details',
    id: detailId,
    hidden: true
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
      if (message.parentElement !== toggle) toggle.prepend(message);
      if (!toggle.isConnected) content.prepend(toggle);
      details.hidden = !expanded;
      if (!details.isConnected) content.append(details);
    } else {
      toggle.remove();
      details.remove();
      content.prepend(message);
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
    element.append(action);
  };
  toggle.onclick = () => {
    const expanded = toggle.getAttribute('aria-expanded') === 'true';
    toggle.setAttribute('aria-expanded', String(!expanded));
    toggle.setAttribute(
      'aria-label',
      `${current.message} ${expanded ? 'Show' : 'Hide'} ingestion progress history`
    );
    details.hidden = expanded;
    if (!expanded) details.scrollTop = details.scrollHeight;
  };
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
      setDetails();
      setAction();
      scheduleDismissal();
    }
  };

  setDetails();
  setAction();
  container.append(element);
  requestAnimationFrame(() => element.classList.remove('dashboard-notification-enter'));
  scheduleDismissal();
  return { handle, remove };
}
