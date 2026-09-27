import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * @param {import('../../src/data/model/schema.js').EntityKind} kind
 * @param {string} sourceId
 * @param {string} observedAt
 * @param {Record<string, unknown>} data
 * @param {string} [source]
 * @returns {import('../../src/data/model/schema.js').CanonicalObservation}
 */
function observation(kind, sourceId, observedAt, data, source = 'dashboard-source') {
  return { kind, source, sourceId, observedAt, data };
}

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

describe('canonical normalize debug logging', () => {
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
    const { normalize } = await import('../../src/data/normalize/index.js');

    normalize([observation('repository', 'source-id', '2026-09-26T00:00:00Z', { id: 'github:repository:1' })]);
    expect(() => normalize([observation(
      /** @type {any} */ ('unsupported-kind'),
      'source-id',
      '2026-09-26T00:00:00Z',
      {}
    )])).toThrow();

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs start and completion counts under its predictable category when enabled', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=normalize:index', output })
      };
    });
    vi.resetModules();
    const { normalize } = await import('../../src/data/normalize/index.js');

    const batch = normalize([
      observation('repository', 'source-id-1', '2026-09-26T00:00:00Z', { id: 'github:repository:1' }),
      observation('repository', 'source-id-1', '2026-09-26T00:01:00Z', { id: 'github:repository:1' })
    ]);
    const entityCount = Object.values(batch).reduce((total, records) => total + records.length, 0);

    expect(output.debug).toHaveBeenCalledWith(
      '[cao:normalize:index]',
      { event: 'normalize-start', observationCount: 2 }
    );
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:normalize:index]',
      { event: 'normalize-complete', observationCount: 2, entityCount, mergedCount: 2 - entityCount }
    );
  });

  it('logs an unsupported-kind failure without the observation payload', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=normalize:index', output })
      };
    });
    vi.resetModules();
    const { normalize } = await import('../../src/data/normalize/index.js');

    expect(() => normalize([observation(
      /** @type {any} */ ('unsupported-kind'),
      'source-id',
      '2026-09-26T00:00:00Z',
      { secretToken: 'should-not-be-logged' }
    )])).toThrow();

    expect(output.debug).toHaveBeenCalledWith(
      '[cao:normalize:index]',
      { event: 'normalize-failed', reason: 'unsupported-kind', kind: 'unsupported-kind' }
    );
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
          actual.createDebug(category, { search: () => '?debug=normalize:index', output })
      };
    });
    vi.resetModules();
    const { normalize } = await import('../../src/data/normalize/index.js');

    normalize([observation('repository', 'source-id', '2026-09-26T00:00:00Z', {
      id: 'github:repository:1',
      token: 'super-secret-value'
    })]);

    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean').toBe(true);
      }
      expect(JSON.stringify(payload)).not.toContain('super-secret-value');
    }
  });
});
