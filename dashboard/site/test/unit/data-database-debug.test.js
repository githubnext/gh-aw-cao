import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DATABASE_NAME } from '../../src/data/storage/indexeddb.js';

const metadata = { 'as-of': '2026-09-09T05:00:00Z', 'artifact-generation': 'generation-a' };

/** @param {number} count */
function runRows(count) {
  return Array.from({ length: count }, (unused, index) => ({
    organization: 'githubnext',
    repository: 'gh-aw-cao',
    workflow: '.github/workflows/dashboard.md',
    run: String(index + 1),
    'run-attempt': 1,
    'run-status': 'completed',
    'run-conclusion': index % 3 === 0 ? 'failure' : 'success',
    'started-at': `2026-09-09T04:0${index % 10}:00Z`,
    'rollout-mode': 'review'
  }));
}

/** @param {number} count */
function fixtureSources(count) {
  return {
    runs: { rows: runRows(count), metadata },
    campaigns: { rows: [], metadata },
    repositories: { rows: [], metadata },
    workflows: { rows: [], metadata },
    tools: { rows: [], metadata },
    audits: { rows: [], metadata },
    domains: { rows: [], metadata },
    issues: { rows: [], metadata }
  };
}

async function resetDatabase() {
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE_NAME);
    request.onsuccess = () => resolve(undefined);
    request.onerror = () => reject(request.error);
  });
}

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

describe('database query debug logging', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('is disabled by default (no debug output) when the debug query is absent', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) => actual.createDebug(category, { search: () => '', output })
      };
    });
    vi.resetModules();
    const { loadDatabaseQuerySources: loadWithMockedDebug } = await import('../../src/data/queries/database.js');

    await loadWithMockedDebug(indexedDB, fixtureSources(3), { ingest: true });

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs the load, indexed-pushdown, and query-resolution boundaries under the "database" category when enabled', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=database', output })
      };
    });
    vi.resetModules();
    const { loadDatabaseQuerySources: loadWithMockedDebug, queryIndexedDatabaseSources: queryIndexedWithMockedDebug } =
      await import('../../src/data/queries/database.js');

    await loadWithMockedDebug(indexedDB, fixtureSources(3), { ingest: true });
    await queryIndexedWithMockedDebug(indexedDB, fixtureSources(3), [], new Set());

    const events = output.debug.mock.calls.map(([, payload]) => payload.event);
    expect(events).toContain('load-database-query-sources');
    expect(events).toContain('indexed-pushdown-resolved');
    expect(events).toContain('query-sources-resolved');
    for (const call of output.debug.mock.calls) {
      expect(call[0]).toBe('[cao:database]');
    }
  });

  it('never logs sensitive payload content, only scalar metadata', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=database', output })
      };
    });
    vi.resetModules();
    const { loadDatabaseQuerySources: loadWithMockedDebug } = await import('../../src/data/queries/database.js');

    await loadWithMockedDebug(indexedDB, fixtureSources(3), { ingest: true });

    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean').toBe(true);
      }
      expect(JSON.stringify(payload)).not.toContain('githubnext');
      expect(JSON.stringify(payload)).not.toContain('gh-aw-cao');
    }
  });
});
