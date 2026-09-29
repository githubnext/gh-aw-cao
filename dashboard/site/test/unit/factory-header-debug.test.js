// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { state } from '../../src/reactive.js';

/**
 * @param {{ pending?: boolean, unavailable?: boolean, rows?: Record<string, unknown>[] }} [options]
 */
function binding({ pending = false, unavailable = false, rows = [] } = {}) {
  return {
    rows: () => rows,
    pending: () => pending,
    unavailable: () => unavailable
  };
}

/**
 * Loads factory-header.js with a stubbed debug output so assertions can
 * inspect emitted metadata without depending on module state left over from
 * other tests.
 * @param {string} search
 */
async function loadFactoryHeaderWithDebug(search) {
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
  const module = await import('../../src/components/factory-header.js');
  return { ...module, output };
}

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

describe('factory-header debug logging', () => {
  it('is disabled by default when the debug query is absent', async () => {
    const { renderFactoryHeader, output } = await loadFactoryHeaderWithDebug('');
    const controller = new AbortController();
    const sources = {
      'overview-header-presentation': binding({ rows: [{ heading: 'Your campaigns are delivering value.' }] }),
      'overview-rhythm': binding()
    };

    renderFactoryHeader(sources, { signal: controller.signal }, {
      presentation: 'overview-header-presentation',
      rhythm: 'overview-rhythm'
    });

    expect(output.debug).not.toHaveBeenCalled();
    controller.abort();
  });

  it('logs predictable composition and settlement metadata under its category', async () => {
    const { renderFactoryHeader, output } = await loadFactoryHeaderWithDebug('?debug=factory-header');
    const controller = new AbortController();
    const sources = {
      'overview-header-presentation': binding({ rows: [{ heading: 'Your campaigns are delivering value.' }] }),
      'overview-rhythm': binding()
    };

    renderFactoryHeader(sources, { signal: controller.signal }, {
      presentation: 'overview-header-presentation',
      rhythm: 'overview-rhythm'
    });

    expect(output.debug).toHaveBeenCalledWith('[cao:factory-header]', {
      event: 'composed',
      presentationSource: 'overview-header-presentation',
      rhythmSource: 'overview-rhythm'
    });
    expect(output.debug).toHaveBeenCalledWith('[cao:factory-header]', {
      event: 'heading-settled',
      unavailable: false,
      hasHeading: true
    });
    expect(output.debug).toHaveBeenCalledWith('[cao:factory-header]', {
      event: 'summary-settled',
      hasSummary: false
    });

    for (const call of output.debug.mock.calls) {
      const metadata = call[1];
      expect(Object.values(metadata).every((value) => typeof value !== 'object')).toBe(true);
    }
    controller.abort();
  });

  it('logs unavailable settlement without leaking the source rows', async () => {
    const { renderFactoryHeader, output } = await loadFactoryHeaderWithDebug('?debug=factory-header');
    const controller = new AbortController();
    const presentation = state({ pending: false, unavailable: true, rows: [] });
    const sources = {
      'overview-header-presentation': {
        rows: () => presentation.get().rows,
        pending: () => presentation.get().pending,
        unavailable: () => presentation.get().unavailable
      },
      'overview-rhythm': binding()
    };

    renderFactoryHeader(sources, { signal: controller.signal }, {
      presentation: 'overview-header-presentation',
      rhythm: 'overview-rhythm'
    });

    expect(output.debug).toHaveBeenCalledWith('[cao:factory-header]', {
      event: 'heading-settled',
      unavailable: true,
      hasHeading: false
    });
    controller.abort();
  });
});
