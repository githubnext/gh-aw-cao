import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const temporaryDirectories = /** @type {string[]} */ ([]);

function temporaryDatabase() {
  const directory = mkdtempSync(join(tmpdir(), 'cao-sqlite-doctor-debug-'));
  temporaryDirectories.push(directory);
  return join(directory, 'dashboard.sqlite');
}

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * @param {ReturnType<typeof vi.fn>} debugFn
 * @param {string} search
 */
function mockDebugModule(debugFn, search) {
  const output = /** @type {Pick<Console, 'debug'>} */ ({ debug: debugFn });
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
}

describe('sqlite-doctor debug logging', () => {
  it('is disabled by default (no debug output) when the debug query is absent', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '');
    const { doctorSqliteDatabase } = await import('../../src/data/storage/sqlite-doctor.js');
    const { installSqliteIndexedDB: install } = await import('../../src/data/storage/sqlite-indexeddb.js');
    const { normalize: normalizeCanonical } = await import('../../src/data/normalize/index.js');
    const { upsertCanonicalBatch: upsert } = await import('../../src/data/storage/indexeddb.js');

    const filename = temporaryDatabase();
    const indexedDB = install(filename);
    await upsert(indexedDB, normalizeCanonical([]));

    await doctorSqliteDatabase(filename);

    expect(debugFn).not.toHaveBeenCalled();
  });

  it('logs the diagnosis and completion events under the predictable category when enabled', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '?debug=sqlite-doctor');
    const { doctorSqliteDatabase } = await import('../../src/data/storage/sqlite-doctor.js');
    const { installSqliteIndexedDB: install } = await import('../../src/data/storage/sqlite-indexeddb.js');
    const { normalize: normalizeCanonical } = await import('../../src/data/normalize/index.js');
    const { upsertCanonicalBatch: upsert } = await import('../../src/data/storage/indexeddb.js');

    const filename = temporaryDatabase();
    const indexedDB = install(filename);
    await upsert(indexedDB, normalizeCanonical([]));

    await doctorSqliteDatabase(filename);

    expect(debugFn).toHaveBeenCalledWith(
      '[cao:sqlite-doctor]',
      'diagnosed database',
      expect.objectContaining({ event: 'diagnosed', needsRepair: expect.any(Boolean) })
    );
    expect(debugFn).toHaveBeenCalledWith(
      '[cao:sqlite-doctor]',
      'completed doctor run',
      expect.objectContaining({ event: 'completed', healthy: expect.any(Boolean) })
    );
  });

  it('never logs record content, only scalar metadata', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '?debug=sqlite-doctor');
    const { doctorSqliteDatabase } = await import('../../src/data/storage/sqlite-doctor.js');
    const { installSqliteIndexedDB: install } = await import('../../src/data/storage/sqlite-indexeddb.js');
    const { normalize: normalizeCanonical } = await import('../../src/data/normalize/index.js');
    const { upsertCanonicalBatch: upsert } = await import('../../src/data/storage/indexeddb.js');

    const filename = temporaryDatabase();
    const indexedDB = install(filename);
    const canonical = normalizeCanonical([]);
    canonical.repositories.push({ id: 'repository:secret-name' });
    await upsert(indexedDB, canonical);

    await doctorSqliteDatabase(filename);

    for (const call of debugFn.mock.calls) {
      const [, , payload] = call;
      for (const value of Object.values(payload)) {
        expect(typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean').toBe(true);
      }
      expect(JSON.stringify(payload)).not.toContain('secret-name');
      expect(JSON.stringify(payload)).not.toContain(filename);
    }
  });
});
