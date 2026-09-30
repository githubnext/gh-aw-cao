const CSRF_COOKIE_NAME = 'cao_csrf';

export function usesGitHubAuthentication(document = globalThis.document) {
  return document
    ?.querySelector?.('meta[name="cao-auth-mode"]')
    ?.getAttribute('content') === 'github';
}

export function csrfToken(document = globalThis.document) {
  const prefix = `${CSRF_COOKIE_NAME}=`;
  const cookie = document?.cookie
    ?.split(';')
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(prefix));
  if (!cookie) return '';
  return decodeURIComponent(cookie.slice(prefix.length));
}

export function csrfHeaders(headers = {}, document = globalThis.document) {
  const token = csrfToken(document);
  return token ? { ...headers, 'X-CSRF-Token': token } : headers;
}
