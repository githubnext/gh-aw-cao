import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

/**
 * Loads auth.js with a stubbed debug output so assertions can inspect emitted
 * metadata without depending on module state left over from other tests.
 * @param {string} search
 */
async function loadAuthWithDebug(search) {
  const output = { debug: vi.fn() };
  vi.doMock('../../src/debug.js', async () => {
    const actual = /** @type {typeof import('../../src/debug.js')} */ (
      await vi.importActual('../../src/debug.js')
    );
    return {
      ...actual,
      createDebug: (/** @type {string} */ category) => actual.createDebug(category, { search: () => search, output })
    };
  });
  vi.resetModules();
  const module = await import('../../src/auth.js');
  return { ...module, output };
}

/** @param {string} cookie */
function fakeDocument(cookie = '') {
  return /** @type {Document} */ (/** @type {unknown} */ ({ cookie, querySelector: () => null }));
}

/** @param {string} mode */
function fakeAuthModeDocument(mode) {
  return /** @type {Document} */ (/** @type {unknown} */ ({
    cookie: '',
    querySelector: (/** @type {string} */ selector) => (selector === 'meta[name="cao-auth-mode"]'
      ? { getAttribute: () => mode }
      : null)
  }));
}

describe('auth debug logging', () => {
  it('is disabled by default (no debug output) when the debug query is absent', async () => {
    const { usesGitHubAuthentication, csrfToken, csrfHeaders, output } = await loadAuthWithDebug('');

    usesGitHubAuthentication(fakeAuthModeDocument('github'));
    csrfToken(fakeDocument('cao_csrf=abc123'));
    csrfHeaders({}, fakeDocument(''));

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs mode, token, and header resolution under the predictable category name derived from the filename', async () => {
    const { usesGitHubAuthentication, csrfToken, csrfHeaders, output } = await loadAuthWithDebug('?debug=auth');

    expect(usesGitHubAuthentication(fakeAuthModeDocument('github'))).toBe(true);
    expect(output.debug).toHaveBeenCalledWith('[cao:auth]', { event: 'mode-resolved', mode: 'github' });

    expect(usesGitHubAuthentication(fakeAuthModeDocument('token'))).toBe(false);
    expect(output.debug).toHaveBeenCalledWith('[cao:auth]', { event: 'mode-resolved', mode: 'token' });

    expect(csrfToken(fakeDocument(''))).toBe('');
    expect(output.debug).toHaveBeenCalledWith('[cao:auth]', { event: 'csrf-token-resolved', found: false });

    expect(csrfToken(fakeDocument('cao_csrf=abc123'))).toBe('abc123');
    expect(output.debug).toHaveBeenCalledWith('[cao:auth]', { event: 'csrf-token-resolved', found: true });

    csrfHeaders({ Accept: 'application/json' }, fakeDocument(''));
    expect(output.debug).toHaveBeenCalledWith('[cao:auth]', { event: 'csrf-headers-applied', applied: false });

    csrfHeaders({ Accept: 'application/json' }, fakeDocument('cao_csrf=abc123'));
    expect(output.debug).toHaveBeenCalledWith('[cao:auth]', { event: 'csrf-headers-applied', applied: true });
  });

  it('never logs the raw cookie value or token, only scalar metadata', async () => {
    const { csrfToken, csrfHeaders, output } = await loadAuthWithDebug('?debug=auth');

    csrfToken(fakeDocument('cao_csrf=do-not-log-this-secret-token'));
    csrfHeaders({}, fakeDocument('cao_csrf=do-not-log-this-secret-token'));

    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      expect(JSON.stringify(payload)).not.toContain('do-not-log-this-secret');
      for (const value of Object.values(payload)) {
        expect(value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean').toBe(true);
      }
    }
  });
});
