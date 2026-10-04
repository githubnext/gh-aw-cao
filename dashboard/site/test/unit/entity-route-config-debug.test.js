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

/** @param {Record<string, unknown> | undefined} titleLink */
function context(titleLink) {
  return {
    pageId: 'domain-insights',
    title: 'Domain',
    sourceNames: ['domains'],
    contextDetails: [],
    routeParameter: 'domain',
    titleLink,
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

/** @param {{ debug: import('vitest').Mock }} output @param {string} search */
async function importWithDebug(output, search) {
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
  return import('../../src/components/entity-route.js');
}

describe('entity route config debug logging', () => {
  afterEach(() => {
    vi.doUnmock('../../src/debug.js');
    vi.resetModules();
  });

  it('is disabled by default', async () => {
    const output = { debug: vi.fn() };
    const { renderEntityRoute } = await importWithDebug(output, '');

    renderEntityRoute(context({ 'href-field': 'run-link', 'identifier-field': 'domain' }));

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs a scalar-only diagnostic when identifier-field is missing, under its predictable category', async () => {
    const output = { debug: vi.fn() };
    const { renderEntityRoute } = await importWithDebug(output, '?debug=entity-route-config');

    renderEntityRoute(context({ 'href-field': 'run-link' }));

    expect(output.debug).toHaveBeenCalledWith('[cao:entity-route-config]', {
      event: 'identifier-field-missing',
      pageId: 'domain-insights'
    });
    for (const call of output.debug.mock.calls) {
      for (const value of Object.values(call[1])) {
        expect(typeof value === 'object').toBe(false);
      }
    }
  });

  it('enables via the ?debug=1 wildcard', async () => {
    const output = { debug: vi.fn() };
    const { renderEntityRoute } = await importWithDebug(output, '?debug=1');

    renderEntityRoute(context(undefined));

    expect(output.debug).toHaveBeenCalledWith('[cao:entity-route-config]', {
      event: 'identifier-field-missing',
      pageId: 'domain-insights'
    });
  });

  it('logs hasTitleLink after a row matches, without logging the identifier value or row contents', async () => {
    const output = { debug: vi.fn() };
    const { renderEntityRoute } = await importWithDebug(output, '?debug=entity-route-config');

    const rendered = renderEntityRoute(context({ 'href-field': 'run-link', 'identifier-field': 'domain' }));
    rendered.dispatchEvent(new CustomEvent('dashboard-route-change', {
      detail: { parameter: 'domain', value: 'api.github.com' }
    }));

    expect(output.debug).toHaveBeenCalledWith('[cao:entity-route-config]', {
      event: 'allocated',
      pageId: 'domain-insights',
      hasTitleLink: true
    });
    for (const call of output.debug.mock.calls) {
      const serialized = JSON.stringify(call[1]);
      expect(serialized).not.toContain('api.github.com');
      expect(serialized).not.toContain('github.com/octo');
    }
  });

  it('logs hasTitleLink as false when the matched row has no resolvable title link', async () => {
    const output = { debug: vi.fn() };
    const { renderEntityRoute } = await importWithDebug(output, '?debug=entity-route-config');

    const rendered = renderEntityRoute(context({ 'href-field': 'missing-link', 'identifier-field': 'domain' }));
    rendered.dispatchEvent(new CustomEvent('dashboard-route-change', {
      detail: { parameter: 'domain', value: 'api.github.com' }
    }));

    expect(output.debug).toHaveBeenCalledWith('[cao:entity-route-config]', {
      event: 'allocated',
      pageId: 'domain-insights',
      hasTitleLink: false
    });
  });
});
