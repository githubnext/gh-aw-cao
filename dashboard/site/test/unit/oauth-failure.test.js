// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// @ts-expect-error jsdom does not ship TypeScript declarations in this project.
import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';

const html = readFileSync(resolve(process.cwd(), '../../server/internal/server/oauth_failure.html'), 'utf8');

/** @param {typeof globalThis.fetch} fetch */
function loadFailurePage(fetch) {
  return new JSDOM(html, {
    url: 'https://dashboard.example.com/auth/callback',
    runScripts: 'dangerously',
    beforeParse(/** @type {Window & typeof globalThis} */ window) { window.fetch = fetch; }
  });
}

describe('hosted OAuth failure page', () => {
  it('restores an expired CSRF cookie before sign-out', async () => {
    /** @type {{ window: Window & typeof globalThis }} */
    let page;
    const fetch = vi.fn().mockImplementation((path) => {
      if (path === '/api/auth/session') {
        page.window.document.cookie = 'cao_csrf=restored-token; Path=/';
        return Promise.resolve({ ok: true, status: 200 });
      }
      return Promise.resolve({ ok: false, status: 403 });
    });
    page = loadFailurePage(fetch);
    page.window.document.getElementById('sign-out')?.click();

    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(fetch.mock.calls[0]).toEqual(['/api/auth/session', {
      credentials: 'same-origin', cache: 'no-store'
    }]);
    expect(fetch.mock.calls[1]).toEqual(['/auth/logout', {
      method: 'POST', credentials: 'same-origin', headers: { 'X-CSRF-Token': 'restored-token' }
    }]);
    page.window.close();
  });

  it('does not post logout if the CSRF cookie is still missing', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const page = loadFailurePage(fetch);
    page.window.document.getElementById('sign-out').click();

    await vi.waitFor(() => expect(page.window.document.getElementById('recovery-error').hidden).toBe(false));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe('/api/auth/session');
    page.window.close();
  });

  it('uses the existing CSRF cookie without a recovery request', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: false, status: 403 });
    const page = loadFailurePage(fetch);
    page.window.document.cookie = 'cao_csrf=existing-token; Path=/';
    page.window.document.getElementById('sign-out').click();

    await vi.waitFor(() => expect(page.window.document.getElementById('recovery-error').hidden).toBe(false));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toBe('/auth/logout');
    expect(fetch.mock.calls[0][1].headers).toEqual({ 'X-CSRF-Token': 'existing-token' });
    page.window.close();
  });
});
