// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderEntityRoute } from '../../src/components/entity-route.js';

const metadata = {
  'source-id': 'domains-fixture',
  'source-kind': 'fixture',
  'as-of': '2026-09-24T00:00:00Z',
  'retrieved-at': '2026-09-24T00:00:00Z',
  completeness: /** @type {'complete'} */ ('complete'),
  freshness: /** @type {'fresh'} */ ('fresh'),
  availability: /** @type {'available'} */ ('available')
};

function context() {
  return {
    pageId: 'domain-insights',
    title: 'Domain',
    sourceNames: ['domains'],
    contextDetails: [],
    routeParameter: 'domain',
    titleLink: {
      'href-field': 'run-link',
      'identifier-field': 'domain'
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

describe('entity route', () => {
  it('allocates the entity title and its native GitHub link', () => {
    const allocation = vi.fn();
    const rendered = renderEntityRoute(context());
    rendered.addEventListener('dashboard-route-allocation', allocation);
    rendered.dispatchEvent(new CustomEvent('dashboard-route-change', {
      detail: { parameter: 'domain', value: 'api.github.com' }
    }));

    expect(rendered.dataset.entity).toBe('api.github.com');
    expect(rendered.textContent).toBe('Insights for api.github.com');
    expect(allocation).toHaveBeenCalledOnce();
    expect(allocation.mock.calls[0][0].detail).toEqual({
      title: 'api.github.com',
      titleLink: {
        href: 'https://github.com/octo/repo/actions/runs/1',
        label: 'Open #api.github.com on GitHub'
      }
    });
  });

  it('renders an explicit empty state for an unknown entity', () => {
    const rendered = renderEntityRoute(context());
    rendered.dispatchEvent(new CustomEvent('dashboard-route-change', {
      detail: { parameter: 'domain', value: 'missing.example' }
    }));

    expect(rendered.textContent).toBe('Entity not found.');
  });
});

describe('entity route debug logging', () => {
  afterEach(() => {
    vi.doUnmock('../../src/debug.js');
    vi.resetModules();
  });

  it('stays silent by default and logs only scalar metadata under its predictable category', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) => actual.createDebug(category, { search: () => '?debug=entity-route', output })
      };
    });
    vi.resetModules();
    const { renderEntityRoute: renderEntityRouteWithDebug } = await import('../../src/components/entity-route.js');

    const rendered = renderEntityRouteWithDebug(context());
    expect(output.debug).toHaveBeenCalledWith('[cao:entity-route]', { event: 'initialized', pageId: 'domain-insights', rowCount: 1 });

    rendered.dispatchEvent(new CustomEvent('dashboard-route-change', {
      detail: { parameter: 'domain', value: 'api.github.com' }
    }));
    expect(output.debug).toHaveBeenCalledWith('[cao:entity-route]', { event: 'matched', pageId: 'domain-insights' });

    rendered.dispatchEvent(new CustomEvent('dashboard-route-change', {
      detail: { parameter: 'domain', value: 'missing.example' }
    }));
    expect(output.debug).toHaveBeenCalledWith('[cao:entity-route]', { event: 'not-found', pageId: 'domain-insights' });

    for (const call of output.debug.mock.calls) {
      const metadata = call[1];
      expect(Object.values(metadata).every((value) => typeof value !== 'object')).toBe(true);
    }
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
    const { renderEntityRoute: renderEntityRouteWithoutDebug } = await import('../../src/components/entity-route.js');

    const rendered = renderEntityRouteWithoutDebug(context());
    rendered.dispatchEvent(new CustomEvent('dashboard-route-change', {
      detail: { parameter: 'domain', value: 'api.github.com' }
    }));

    expect(output.debug).not.toHaveBeenCalled();
  });
});
