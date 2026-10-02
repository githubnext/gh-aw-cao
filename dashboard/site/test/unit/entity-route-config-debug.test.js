// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

const metadata = {
  'source-id': 'domains-fixture',
  'source-kind': 'fixture',
  'as-of': '2026-09-24T00:00:00Z',
  'retrieved-at': '2026-09-24T00:00:00Z',
  completeness: /** @type {'complete'} */ ('complete'),
  freshness: /** @type {'fresh'} */ ('fresh'),
  availability: /** @type {'available'} */ ('available')
};

/** @param {{ identifierField?: string }} [options] */
function context({ identifierField = 'domain' } = {}) {
  return {
    pageId: 'domain-insights',
    title: 'Domain',
    sourceNames: ['domains'],
    contextDetails: [],
    routeParameter: 'domain',
    titleLink: {
      'href-field': 'run-link',
      'identifier-field': identifierField
    },
    headingTag: /** @type {'h3'} */ ('h3'),
    sources: {
      domains: {
        source: 'domains',
        metadata,
        rows: [{
          domain: 'api.github.com',
          'run-link': {
            relation: 'run',
            href: 'https://github.com/octo/repo/actions/runs/1',
            label: 'View run'
          }
        }]
      }
    }
  };
}

/** @param {{ search: () => string }} options */
async function loadWithDebug({ search }) {
  const output = { debug: vi.fn() };
  vi.doMock('../../src/debug.js', async () => {
    const actual = /** @type {typeof import('../../src/debug.js')} */ (
      await vi.importActual('../../src/debug.js')
    );
    return {
      ...actual,
      createDebug: (/** @type {string} */ category) => actual.createDebug(category, { search, output })
    };
  });
  vi.resetModules();
  const module = await import('../../src/components/entity-route.js');
  return { renderEntityRoute: module.renderEntityRoute, output };
}

describe('entity route config debug logging', () => {
  afterEach(() => {
    vi.doUnmock('../../src/debug.js');
    vi.resetModules();
  });

  it('stays silent by default under the predictable entity-route-config category', async () => {
    const { renderEntityRoute, output } = await loadWithDebug({ search: () => '' });

    const rendered = renderEntityRoute(context());
    rendered.dispatchEvent(new CustomEvent('dashboard-route-change', {
      detail: { parameter: 'domain', value: 'api.github.com' }
    }));

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs scalar allocation metadata when enabled via ?debug=entity-route-config', async () => {
    const { renderEntityRoute, output } = await loadWithDebug({ search: () => '?debug=entity-route-config' });

    const rendered = renderEntityRoute(context());
    rendered.dispatchEvent(new CustomEvent('dashboard-route-change', {
      detail: { parameter: 'domain', value: 'api.github.com' }
    }));

    expect(output.debug).toHaveBeenCalledWith(
      '[cao:entity-route-config]',
      { event: 'allocated', pageId: 'domain-insights', hasTitleLink: true }
    );
    for (const call of output.debug.mock.calls) {
      const payload = call[1];
      expect(Object.values(payload).every((value) => typeof value !== 'object')).toBe(true);
    }
  });

  it('logs the silent identifier-field-missing gap instead of failing without a signal', async () => {
    const { renderEntityRoute, output } = await loadWithDebug({ search: () => '?debug=entity-route-config' });

    renderEntityRoute(context({ identifierField: '' }));

    expect(output.debug).toHaveBeenCalledWith(
      '[cao:entity-route-config]',
      { event: 'identifier-field-missing', pageId: 'domain-insights' }
    );
  });

  it('is enabled via the wildcard ?debug=1 pattern as well', async () => {
    const { renderEntityRoute, output } = await loadWithDebug({ search: () => '?debug=1' });

    renderEntityRoute(context({ identifierField: '' }));

    expect(output.debug).toHaveBeenCalledWith(
      '[cao:entity-route-config]',
      { event: 'identifier-field-missing', pageId: 'domain-insights' }
    );
  });
});
