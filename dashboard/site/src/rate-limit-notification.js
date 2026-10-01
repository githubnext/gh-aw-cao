import { publishNotification } from './notification-service.js';
import { effect, state } from './reactive.js';
import { createDebug } from './debug.js';

const debug = createDebug('rate-limit-notification');

const rateLimitedPolicies = state(new Set());
/** @type {ReturnType<typeof publishNotification> | undefined} */
let rateLimitNotification;

export function isDashboardRateLimited() {
  return rateLimitedPolicies.get().size > 0;
}

effect(() => {
  if (isDashboardRateLimited()) {
    if (!rateLimitNotification) {
      rateLimitNotification = publishNotification({
        message: 'Dashboard is rate limited. Please try again shortly.',
        tone: 'error',
        duration: 0,
      });
      debug({ event: 'notification-shown', policyCount: rateLimitedPolicies.get().size });
    }
  } else if (rateLimitNotification) {
    rateLimitNotification.dismiss();
    rateLimitNotification = undefined;
    debug({ event: 'notification-dismissed' });
  }
});

/** @param {string} path @param {number} status */
export function updateRateLimitNotification(path, status) {
  if (status !== 429 && (status < 200 || status >= 300)) return;
  const policy = path === '/api/v1/query' ? 'query' : 'general';
  rateLimitedPolicies.set((current) => {
    if (current.has(policy) === (status === 429)) return current;
    const next = new Set(current);
    if (status === 429) next.add(policy);
    else next.delete(policy);
    debug({ event: 'policy-changed', policy, rateLimited: status === 429, activePolicyCount: next.size });
    return next;
  });
}
