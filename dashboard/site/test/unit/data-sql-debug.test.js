import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

/** @param {{ search: string, output: { debug: import('vitest').Mock } }} options */
async function importSqlWithDebug({ search, output }) {
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
  return import('../../src/data/storage/sql.js');
}

describe('SQL query builder debug logging', () => {
  it('is disabled by default (no debug output) when the debug query is absent', async () => {
    const output = { debug: vi.fn() };
    const module = await importSqlWithDebug({ search: '', output });

    expect(() => module.identifier('')).toThrow();
    expect(() => module.sql`SELECT ${undefined}`).toThrow();

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('is selected by the predictable "sql" category derived from the filename, not enabled by unrelated categories', async () => {
    const output = { debug: vi.fn() };
    const module = await importSqlWithDebug({ search: '?debug=some-other-category', output });

    expect(() => module.identifier('')).toThrow();

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs a reason when a SQL identifier is rejected', async () => {
    const output = { debug: vi.fn() };
    const module = await importSqlWithDebug({ search: '?debug=sql', output });

    expect(() => module.identifier('')).toThrow();
    expect(output.debug).toHaveBeenCalledWith('[cao:sql]', {
      event: 'identifier-rejected',
      reason: 'empty'
    });

    output.debug.mockClear();
    expect(() => module.identifier('bad\0name')).toThrow();
    expect(output.debug).toHaveBeenCalledWith('[cao:sql]', {
      event: 'identifier-rejected',
      reason: 'contains-nul'
    });

    output.debug.mockClear();
    expect(() => module.identifier(/** @type {any} */ (42))).toThrow();
    expect(output.debug).toHaveBeenCalledWith('[cao:sql]', {
      event: 'identifier-rejected',
      reason: 'not-a-string'
    });
  });

  it('logs the index and type when an unsupported SQL parameter is rejected', async () => {
    const output = { debug: vi.fn() };
    const module = await importSqlWithDebug({ search: '?debug=sql', output });

    expect(() => module.sql`SELECT ${undefined}`).toThrow();
    expect(output.debug).toHaveBeenCalledWith('[cao:sql]', {
      event: 'parameter-rejected',
      index: 0,
      valueType: 'undefined'
    });

    output.debug.mockClear();
    expect(() => module.sql`SELECT ${'ok'}, ${Infinity}`).toThrow();
    expect(output.debug).toHaveBeenCalledWith('[cao:sql]', {
      event: 'parameter-rejected',
      index: 1,
      valueType: 'number'
    });
  });

  it('logs when sql is not invoked as a tagged template', async () => {
    const output = { debug: vi.fn() };
    const module = await importSqlWithDebug({ search: '?debug=sql', output });

    expect(() => /** @type {any} */ (module.sql)('not', 'a', 'template')).toThrow();
    expect(output.debug).toHaveBeenCalledWith('[cao:sql]', {
      event: 'sql-call-rejected',
      reason: 'not-a-tagged-template'
    });
  });

  it('never logs the identifier name, parameter value, or SQL text, only scalar metadata', async () => {
    const output = { debug: vi.fn() };
    const module = await importSqlWithDebug({ search: '?debug=sql', output });

    expect(() => module.identifier('bad\0secret-value')).toThrow();
    expect(() => module.sql`SELECT ${{ secret: 'secret-value' }}`).toThrow();

    expect(output.debug.mock.calls.length).toBeGreaterThan(0);
    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean').toBe(true);
      }
      expect(JSON.stringify(payload)).not.toContain('secret');
    }
  });
});
