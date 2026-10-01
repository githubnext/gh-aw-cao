import { publishNotification } from './notification-service.js';

const rateLimitedPolicies = new Set();
/** @type {ReturnType<typeof publishNotification> | undefined} */
let rateLimitNotification;

/** @param {string} path @param {number} status */
export function updateRateLimitNotification(path, status) {
  const policy = path === '/api/v1/query' ? 'query' : 'general';
  if (status === 429) {
    rateLimitedPolicies.add(policy);
    rateLimitNotification ??= publishNotification({
      message: 'Dashboard is rate limited. Please try again shortly.',
      tone: 'error',
      duration: 0,
    });
  } else if (status >= 200 && status < 300) {
    rateLimitedPolicies.delete(policy);
    if (rateLimitedPolicies.size === 0) {
      rateLimitNotification?.dismiss();
      rateLimitNotification = undefined;
    }
  }
}
