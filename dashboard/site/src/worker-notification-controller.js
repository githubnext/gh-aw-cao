import { publishNotification } from './notification-service.js';

/**
 * @typedef {{
 *   id?: string,
 *   message?: string,
 *   icon?: 'download',
 *   detailsSubtitle?: string,
 *   tone?: 'info' | 'success' | 'warning' | 'error',
 *   duration?: number,
 *   details?: string[],
 *   dismissOnCollapse?: boolean,
 *   dismiss?: boolean,
 *   action?: { label?: unknown, operation?: unknown, placement?: unknown, requestId?: unknown }
 * }} WorkerNotification
 */

/**
 * Owns the lifecycle and main-thread actions for serializable notifications
 * published by the data worker.
 *
 * @param {{
 *   cancelRequest: (requestId: number) => boolean | number,
 *   publish?: typeof publishNotification
 * }} options
 */
export function createWorkerNotificationController({ cancelRequest, publish = publishNotification }) {
  /** @type {Map<string, ReturnType<typeof publishNotification>>} */
  const handles = new Map();
  const cancelledIds = new Set();

  /**
   * @param {unknown} input
   */
  const handle = (input) => {
    try {
      const notification = workerNotification(input);
      if (!notification) return;
      const id = typeof notification.id === 'string' ? notification.id : undefined;
      if (notification.dismiss === true) {
        if (id) {
          if (!cancelledIds.has(id)) handles.get(id)?.dismiss();
          handles.delete(id);
          cancelledIds.delete(id);
        }
        return;
      }
      if (typeof notification.message !== 'string') return;
      const display = { ...notification, message: notification.message };
      if (!id) {
        publish(displayNotification(display));
        return;
      }
      if (cancelledIds.has(id)) return;
      const current = handles.get(id);
      if (current) {
        current.update(displayNotification(display, id, current));
        return;
      }
      const next = publish(displayNotification(display, id));
      handles.set(id, next);
    } catch {
      // Ignore malformed worker notifications without disrupting data processing.
    }
  };

  /**
   * @param {WorkerNotification & { message: string }} notification
   * @param {string} [id]
   * @param {ReturnType<typeof publishNotification>} [handle]
   * @returns {Exclude<Parameters<typeof publishNotification>[0], string>}
   */
  const displayNotification = (notification, id, handle) => {
     const action = notification.action;
     const base = { ...notification };
     delete base.action;
     delete base.id;
     delete base.dismiss;
     if (!id || !action || typeof action !== 'object' || Array.isArray(action)
         || action.operation !== 'cancel-data-ingestion') {
       return /** @type {Exclude<Parameters<typeof publishNotification>[0], string>} */ (base);
    }
    const label = typeof action.label === 'string' && action.label.trim() ? action.label : 'Cancel';
    return {
      ...base,
      action: {
        label,
        ...(action.placement === 'details' ? { placement: /** @type {'details'} */ ('details') } : {}),
        run: () => {
          if (typeof action.requestId !== 'number' || !cancelRequest(action.requestId)) return;
          (handle ?? handles.get(id))?.update({
            ...base,
            message: 'Data ingestion cancelled.',
            tone: 'warning',
            action: undefined,
            dismissOnCollapse: true,
            duration: 0
          });
          cancelledIds.add(id);
        }
      }
    };
  };

  return {
    handle,
    reset() {
      for (const [id, notification] of handles) {
        if (!cancelledIds.has(id)) notification.dismiss();
      }
      handles.clear();
      cancelledIds.clear();
    }
  };
}

/** @param {unknown} input @returns {WorkerNotification | null} */
function workerNotification(input) {
  return input && typeof input === 'object' && !Array.isArray(input)
    ? /** @type {WorkerNotification} */ (input)
    : null;
}
