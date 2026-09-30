import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

const sourceMetadata = /** @type {import('../../src/presenter.js').SourceMetadata} */ ({
  'source-id': 'fixture',
  'source-kind': 'fixture',
  'as-of': '2026-09-03T12:00:00Z',
  'retrieved-at': '2026-09-03T12:01:00Z',
  completeness: 'complete',
  freshness: 'fresh',
  availability: 'available'
});

/**
 * Loads data-health.js with a stubbed debug output so assertions can inspect
 * emitted metadata without depending on module state left over from other tests.
 * @param {string} search
 */
async function loadDataHealthWithDebug(search) {
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
  const module = await import('../../src/data-health.js');
  return { ...module, output };
}

describe('data-health debug logging', () => {
  it('is disabled by default (no debug output) when the debug query is absent', async () => {
    const { deriveDataHealthSources, output } = await loadDataHealthWithDebug('');

    deriveDataHealthSources({
      runs: { source: 'runs', rows: [{ attempts: 1 }], metadata: sourceMetadata }
    });

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs a schema-derived summary under its category name when enabled', async () => {
    const { deriveDataHealthSources, output } = await loadDataHealthWithDebug('?debug=data-health');

    deriveDataHealthSources({
      runs: { source: 'runs', rows: [{ attempts: 1 }], metadata: sourceMetadata },
      issues: { source: 'issues', rows: [{ title: 'x' }], metadata: sourceMetadata }
    });

    expect(output.debug).toHaveBeenCalledWith('[cao:data-health]', {
      event: 'schema-derived',
      sourceCount: 2,
      truncatedCount: 0,
      completeness: 'complete',
      freshness: 'fresh'
    });
  });

  it('logs a no-sources-observed event when given no sources', async () => {
    const { deriveDataHealthSources, output } = await loadDataHealthWithDebug('?debug=data-health');

    deriveDataHealthSources({});

    expect(output.debug).toHaveBeenCalledWith('[cao:data-health]', { event: 'no-sources-observed' });
  });

  it('logs a sample-truncated event with counts when a source exceeds the sampling cap', async () => {
    const { deriveDataHealthSources, output } = await loadDataHealthWithDebug('?debug=data-health');
    const rows = Array.from({ length: 60 }, (_, index) => ({ index }));

    deriveDataHealthSources({
      runs: { source: 'runs', rows, metadata: sourceMetadata }
    });

    expect(output.debug).toHaveBeenCalledWith('[cao:data-health]', {
      event: 'sample-truncated',
      source: 'runs',
      totalRows: 60,
      sampledRows: 50
    });
    expect(output.debug).toHaveBeenCalledWith('[cao:data-health]', {
      event: 'schema-derived',
      sourceCount: 1,
      truncatedCount: 1,
      completeness: 'complete',
      freshness: 'fresh'
    });
  });

  it('never logs raw row content, only scalar metadata', async () => {
    const { deriveDataHealthSources, output } = await loadDataHealthWithDebug('?debug=data-health');

    deriveDataHealthSources({
      runs: { source: 'runs', rows: [{ secret: 'do-not-log-this' }], metadata: sourceMetadata }
    });

    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      expect(JSON.stringify(payload)).not.toContain('do-not-log-this');
      for (const value of Object.values(payload)) {
        expect(value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean').toBe(true);
      }
    }
  });
});
