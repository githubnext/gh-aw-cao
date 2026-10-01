import { createDebug } from './debug.js';
import { updateRateLimitNotification } from './rate-limit-notification.js';

const CSRF_COOKIE_NAME = 'cao_csrf';

const debugAuth = createDebug('auth');

export function usesGitHubAuthentication(document = globalThis.document) {
  const oauth = document
    ?.querySelector?.('meta[name="cao-auth-mode"]')
    ?.getAttribute('content') === 'github';
  debugAuth({ event: 'mode-resolved', mode: oauth ? 'github' : 'token' });
  return oauth;
}

export function csrfToken(document = globalThis.document) {
  const prefix = `${CSRF_COOKIE_NAME}=`;
  const cookie = document?.cookie
    ?.split(';')
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(prefix));
  debugAuth({ event: 'csrf-token-resolved', found: Boolean(cookie) });
  if (!cookie) return '';
  return decodeURIComponent(cookie.slice(prefix.length));
}

export function csrfHeaders(headers = {}, document = globalThis.document) {
  const token = csrfToken(document);
  const applied = Boolean(token);
  debugAuth({ event: 'csrf-headers-applied', applied });
  return applied ? { ...headers, 'X-CSRF-Token': token } : headers;
}

/** @param {AbortSignal} [signal] */
export async function ensureCsrfToken(signal) {
  if (csrfToken()) return;
  const response = await fetch('/api/auth/session', {
    cache: 'no-store',
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
    signal
  });
  updateRateLimitNotification('/api/auth/session', response.status);
  if (!response.ok || !csrfToken()) {
    throw new Error('GitHub authentication cookie could not be renewed');
  }
}
