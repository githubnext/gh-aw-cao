// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetSourceStore } from '../../src/source-store.js';

/** @type {import('../../src/presenter.js').SourceMetadata} */
const metadata = {
  'source-id': 'fixture',
  'source-kind': 'fixture',
  'as-of': '2026-09-11T12:00:00Z',
  'retrieved-at': '2026-09-11T12:00:00Z',
  availability: 'available',
  completeness: 'complete',
  freshness: 'unknown'
};

/** @param {string} name @param {Record<string, unknown>[]} rows */
function source(name, rows) {
  return { source: name, rows, metadata };
}

/**
 * Loads renderFactoryFloor/renderFactoryFloorElement with a stubbed debug
 * output so assertions can inspect emitted metadata without depending on
 * module state left over from other tests.
 * @param {string} search
 */
async function loadFactoryFloorWithDebug(search) {
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
  const module = await import('../../src/components/factory-floor.js');
  return { ...module, output };
}

/** @param {AbortSignal} [signal] */
function scope(signal = new AbortController().signal) {
  return { signal };
}

describe('factory-floor debug logging', () => {
  beforeEach(resetSourceStore);
  afterEach(async () => {
    resetSourceStore();
    vi.doUnmock('../../src/debug.js');
    vi.resetModules();
  });

  it('is disabled by default when the debug query is absent', async () => {
    const { renderFactoryFloor, output } = await loadFactoryFloorWithDebug('');

    renderFactoryFloor(
      {
        'overview-campaign-station': {
          rows: () => [{ value: 1 }],
          pending: () => false,
          unavailable: () => false
        },
        'overview-repository-station': {
          rows: () => [{ value: 0.5 }],
          pending: () => false,
          unavailable: () => false
        }
      },
      false,
      scope(),
      { campaigns: 'overview-campaign-station', repositories: 'overview-repository-station' },
      ['campaigns', 'repositories']
    );

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs scalar composition metadata under its predictable category', async () => {
    const { renderFactoryFloor, output } = await loadFactoryFloorWithDebug('?debug=factory-floor');

    renderFactoryFloor(
      {
        'overview-campaign-station': {
          rows: () => [{ value: 1 }],
          pending: () => false,
          unavailable: () => false
        },
        'overview-repository-station': {
          rows: () => [{ value: 0.5 }],
          pending: () => false,
          unavailable: () => false
        }
      },
      true,
      scope(),
      { campaigns: 'overview-campaign-station', repositories: 'overview-repository-station' },
      ['campaigns', 'repositories']
    );

    expect(output.debug).toHaveBeenCalledWith('[cao:factory-floor]', {
      event: 'composed',
      stationCount: 2,
      animate: true
    });

    for (const call of output.debug.mock.calls) {
      const category = call[0];
      const value = call[1];
      expect(category).toBe('[cao:factory-floor]');
      expect(Object.values(value).every((entry) => typeof entry !== 'object')).toBe(true);
    }
  });

  it('logs the selected element configuration without leaking row data', async () => {
    const { renderFactoryFloorElement, output } = await loadFactoryFloorWithDebug('?debug=factory-floor');

    renderFactoryFloorElement({
      pageId: 'overview',
      viewId: 'overview-floor',
      viewIndex: 1,
      title: 'Campaign overview',
      sourceNames: ['overview-campaign-station', 'overview-repository-station'],
      sources: {
        'overview-campaign-station': source('overview-campaign-station', [{ value: 1 }]),
        'overview-repository-station': source('overview-repository-station', [{ value: 0.5 }])
      },
      elementConfig: { stations: ['campaigns', 'repositories'] },
      contextDetails: [],
      headingTag: /** @type {const} */ ('h3')
    });

    expect(output.debug).toHaveBeenCalledWith('[cao:factory-floor]', {
      event: 'element-selected',
      pageId: 'overview',
      viewId: 'overview-floor',
      stations: 'campaigns,repositories'
    });
    expect(output.debug).not.toHaveBeenCalledWith('[cao:factory-floor]', expect.objectContaining({ event: 'station-config-filtered' }));
  });

  it('logs when configured stations are filtered to the recognized set', async () => {
    const { renderFactoryFloorElement, output } = await loadFactoryFloorWithDebug('?debug=factory-floor');

    renderFactoryFloorElement({
      pageId: 'overview',
      viewId: 'overview-floor',
      viewIndex: 1,
      title: 'Campaign overview',
      sourceNames: ['overview-campaign-station'],
      sources: {
        'overview-campaign-station': source('overview-campaign-station', [{ value: 1 }])
      },
      elementConfig: { stations: ['campaigns', 'unknown-station'] },
      contextDetails: [],
      headingTag: /** @type {const} */ ('h3')
    });

    expect(output.debug).toHaveBeenCalledWith('[cao:factory-floor]', {
      event: 'station-config-filtered',
      pageId: 'overview',
      viewId: 'overview-floor',
      configuredCount: 2,
      selectedCount: 1
    });
  });
});
