import { publishNotification } from './notification-service.js';
import { effect, state } from './reactive.js';

const rateLimitedPolicies = state(new Set());
/** @type {ReturnType<typeof publishNotification> | undefined} */
let rateLimitNotification;

effect(() => {
  if (rateLimitedPolicies.get().size > 0) {
    rateLimitNotification ??= publishNotification({
      message: 'Dashboard is rate limited. Please try again shortly.',
      tone: 'error',
      duration: 0,
    });
  } else {
    rateLimitNotification?.dismiss();
    rateLimitNotification = undefined;
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
    return next;
  });
}
