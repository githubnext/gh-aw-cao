import { h } from './dom.js';

const DEFAULT_DURATION = 5000;
const EXIT_DURATION = 180;
const TONES = new Set(['info', 'success', 'warning', 'error']);
/** @typedef {{ dismiss: () => void, update: (notification: string | Notification) => void }} NotificationHandle */
/** @typedef {{ publish: (notification: string | Notification) => NotificationHandle, connected: boolean, dispose: () => void }} NotificationService */
/** @type {WeakMap<Document, NotificationService>} */
const services = new WeakMap();

/**
 * @typedef {{
 *   message: string,
 *   tone?: 'info' | 'success' | 'warning' | 'error',
 *   duration?: number,
 *   action?: { label: string, run: () => void }
 * }} Notification
 */

/**
 * @param {Document} document
 */
export function createNotificationService(document) {
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
 * @returns {Required<Pick<Notification, 'message' | 'tone' | 'duration'>> & Pick<Notification, 'action'>}
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
  return { message: candidate.message.trim(), tone, duration, action };
}

/**
 * @param {ReturnType<typeof normalizeNotification>} initial
 * @param {HTMLElement} container
 * @param {() => void} onRemove
 */
function renderNotification(initial, container, onRemove) {
  const message = h('span', { className: 'dashboard-notification-message' }, initial.message);
  const action = h('button', {
    className: 'dashboard-notification-action',
    type: 'button'
  });
  const element = h('div', {
    className: `dashboard-notification dashboard-notification-${initial.tone} dashboard-notification-enter`,
    role: initial.tone === 'error' ? 'alert' : 'status'
  }, message);
  let current = initial;
  let removed = false;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let dismissTimer;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let removalTimer;

  const setAction = () => {
    action.remove();
    if (!current.action) return;
    action.textContent = current.action.label;
    action.onclick = () => current.action?.run();
    element.append(action);
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
      element.setAttribute('role', current.tone === 'error' ? 'alert' : 'status');
      setAction();
      scheduleDismissal();
    }
  };

  setAction();
  container.append(element);
  requestAnimationFrame(() => element.classList.remove('dashboard-notification-enter'));
  scheduleDismissal();
  return { handle, remove };
}
