// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// @ts-expect-error jsdom does not ship TypeScript declarations in this project.
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DATABASE_NAME } from '../../src/data/storage/indexeddb.js';

const html = readFileSync(resolve(process.cwd(), '../../server/internal/server/oauth_logged_out.html'), 'utf8');

function loadSignedOutPage() {
  return new JSDOM(html, {
    runScripts: 'dangerously',
    beforeParse(/** @type {Window & typeof globalThis} */ window) { window.indexedDB = indexedDB; }
  });
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('hosted OAuth signed-out page', () => {
  it('uses the sign-in error page visual treatment', () => {
    expect(html).toContain('<section class="signed-out-card" aria-labelledby="signed-out-title">');
    expect(html).toContain('Central Agentic Ops');
    expect(html).toContain('@media (prefers-color-scheme: dark)');
    expect(html).toContain('@media (max-width: 480px)');
    expect(html).toContain('.sign-in[hidden] { display: none; }');
  });

  it('deletes the canonical IndexedDB database before offering sign-in', async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    database.close();
    const page = loadSignedOutPage();
    const signIn = page.window.document.getElementById('sign-in');
    expect(signIn.hidden).toBe(true);

    await vi.waitFor(() => expect(signIn.hidden).toBe(false));
    expect((await indexedDB.databases()).some(({ name }) => name === DATABASE_NAME)).toBe(false);
    page.window.close();
  });

  it('does not offer sign-in while another tab blocks deletion', async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const page = loadSignedOutPage();
    await vi.waitFor(() => expect(page.window.document.getElementById('cleanup-status').textContent).toContain('Close other open'));
    expect(page.window.document.getElementById('sign-in').hidden).toBe(true);
    database.close();
    await vi.waitFor(() => expect(page.window.document.getElementById('sign-in').hidden).toBe(false));
    page.window.close();
  });
});
