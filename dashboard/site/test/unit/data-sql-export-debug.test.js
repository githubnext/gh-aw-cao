import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

function fixture() {
  return JSON.parse(readFileSync(resolve('test/fixtures/sql-export-v5.json'), 'utf8'));
}

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

describe('SQL export adapter debug logging', () => {
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
    const { adaptSqlExport } = await import('../../src/data/adapters/sql-export.js');

    adaptSqlExport(fixture());
    expect(() => adaptSqlExport({ ...fixture(), schema_version: 1 })).toThrow();

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs start and completion row/observation counts under its predictable category when enabled', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=data:adapters:sql-export', output })
      };
    });
    vi.resetModules();
    const { adaptSqlExport } = await import('../../src/data/adapters/sql-export.js');

    const input = fixture();
    const adapted = adaptSqlExport(input);

    expect(output.debug).toHaveBeenCalledWith(
      '[cao:data:adapters:sql-export]',
      { event: 'adapt-start', rowCount: input.rows.length }
    );
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:data:adapters:sql-export]',
      { event: 'adapt-complete', rowCount: input.rows.length, observationCount: adapted.observations.length }
    );
  });

  it('logs a failure event for an unsupported schema version without the document payload', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=data:adapters:sql-export', output })
      };
    });
    vi.resetModules();
    const { adaptSqlExport } = await import('../../src/data/adapters/sql-export.js');

    expect(() => adaptSqlExport({ ...fixture(), schema_version: 1 })).toThrow();

    expect(output.debug).toHaveBeenCalledWith(
      '[cao:data:adapters:sql-export]',
      { event: 'adapt-failed', reason: 'unsupported-schema-version' }
    );
  });

  it('never logs sensitive row content, only scalar metadata', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=data:adapters:sql-export', output })
      };
    });
    vi.resetModules();
    const { adaptSqlExport } = await import('../../src/data/adapters/sql-export.js');

    const input = fixture();
    input.rows.push({
      entity_kind: 'audit',
      source_id: 'secret-row',
      observed_at: '2026-09-09T05:00:00Z',
      github_run_id: '303',
      run_attempt: 1,
      event_source: 'user',
      event_type: 'message.user',
      event_summary: 'super-secret-value'
    });
    adaptSqlExport(input);

    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean').toBe(true);
      }
      expect(JSON.stringify(payload)).not.toContain('super-secret-value');
    }
  });
});
