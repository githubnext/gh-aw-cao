// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { canonicalDatabaseName, DATABASE_NAME } from '../../src/data/storage/indexeddb.js';
import { clearScopedStorage, dashboardPagePath, scopedStorageKey } from '../../src/storage-scope.js';

beforeEach(() => {
  localStorage.clear();
});

describe('dashboard storage scope', () => {
  it('resolves the same deployment path for page and worker bundles', () => {
    const pagePath = dashboardPagePath(
      'https://example.github.io/control-a/src/main.js',
      '/control-a/index.html'
    );
    const workerPath = dashboardPagePath(
      'https://example.github.io/control-a/src/data-worker.js',
      undefined
    );

    expect(pagePath).toBe('/control-a/');
    expect(workerPath).toBe(pagePath);
  });

  it('falls back to the document path outside a deployed bundle', () => {
    expect(dashboardPagePath('file:///workspace/src/storage-scope.js', '/preview/')).toBe('/preview/');
    expect(dashboardPagePath('blob:https://example.com/id', undefined)).toBe('/');
  });

  it('uses distinct keys and databases for each Pages path', () => {
    expect(scopedStorageKey('setting', '/control-a/')).toBe('setting:%2Fcontrol-a%2F');
    expect(scopedStorageKey('setting', '/control-b/')).toBe('setting:%2Fcontrol-b%2F');
    expect(canonicalDatabaseName('/control-a/')).toBe(`${DATABASE_NAME}:%2Fcontrol-a%2F`);
    expect(canonicalDatabaseName('/control-b/')).toBe(`${DATABASE_NAME}:%2Fcontrol-b%2F`);
  });

  it('preserves the existing names for a root deployment', () => {
    expect(scopedStorageKey('setting', '/')).toBe('setting');
    expect(canonicalDatabaseName('/')).toBe(DATABASE_NAME);
  });

  it('clears only dashboard settings from the selected Pages path', () => {
    const baseKey = 'central-agentic-ops.dashboard.theme';
    const currentKey = scopedStorageKey(baseKey, '/control-a/');
    const otherKey = scopedStorageKey(baseKey, '/control-b/');
    localStorage.setItem(currentKey, 'dark');
    localStorage.setItem(otherKey, 'light');
    localStorage.setItem('unrelated-setting', 'value');

    clearScopedStorage(localStorage, '/control-a/');

    expect(localStorage.getItem(currentKey)).toBeNull();
    expect(localStorage.getItem(otherKey)).toBe('light');
    expect(localStorage.getItem('unrelated-setting')).toBe('value');
  });
});
