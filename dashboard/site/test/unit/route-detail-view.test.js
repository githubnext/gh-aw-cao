import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderRouteDetailView } from '../../src/components/route-detail-view.js';

/** @type {import('../../src/components/ui-elements.js').ElementRenderContext} */
const context = {
  pageId: 'route-detail-fixture',
  title: 'Fixture',
  sourceNames: [],
  contextDetails: [],
  routeParameter: 'fixture',
  headingTag: /** @type {'h3'} */ ('h3'),
  sources: {}
};

/** @param {Record<string, unknown>} [overrides] */
function baseOptions(overrides = {}) {
  /** @type {import('../../src/components/route-detail-view.js').RouteDetailViewOptions} */
  const options = {
    category: 'route-detail-fixture',
    rootClassName: 'route-detail-fixture',
    datasetKey: 'fixture',
    selectMessage: 'Select a fixture.',
    notFoundMessage: 'Fixture not found.',
    rows: [{ id: 'a', label: 'Alpha' }],
    match: (rows, routeValue) => rows.find((row) => row.id === routeValue.trim()),
    allocation: (row) => ({ title: row.label }),
    renderContent: (row) => Object.assign(document.createElement('p'), { textContent: `Content for ${row.label}` }),
    ...overrides
  };
  return options;
}

describe('route detail view', () => {
  it('renders the select message before a route value is present', () => {
    const rendered = renderRouteDetailView(context, baseOptions());
    expect(rendered.className).toBe('route-detail-fixture');
    expect(rendered.textContent).toBe('Select a fixture.');
  });

  it('dispatches allocation and renders matched content for a matched route value', () => {
    const allocation = vi.fn();
    const rendered = renderRouteDetailView(context, baseOptions());
    rendered.addEventListener('dashboard-route-allocation', allocation);
    rendered.dispatchEvent(new CustomEvent('dashboard-route-change', {
      detail: { parameter: 'fixture', value: 'a' }
    }));

    expect(rendered.dataset.fixture).toBe('a');
    expect(rendered.textContent).toBe('Content for Alpha');
    expect(allocation).toHaveBeenCalledWith(expect.objectContaining({ detail: { title: 'Alpha' } }));
  });

  it('renders the not-found message when no row matches the route value', () => {
    const rendered = renderRouteDetailView(context, baseOptions());
    rendered.dispatchEvent(new CustomEvent('dashboard-route-change', {
      detail: { parameter: 'fixture', value: 'missing' }
    }));

    expect(rendered.textContent).toBe('Fixture not found.');
  });
});

describe('route detail view debug logging', () => {
  afterEach(() => {
    vi.doUnmock('../../src/debug.js');
    vi.resetModules();
  });

  it('logs only scalar metadata under the caller-supplied category', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) => actual.createDebug(category, { search: () => '?debug=route-detail-fixture', output })
      };
    });
    vi.resetModules();
    const { renderRouteDetailView: renderRouteDetailViewWithDebug } = await import('../../src/components/route-detail-view.js');

    const rendered = renderRouteDetailViewWithDebug(context, baseOptions());
    expect(output.debug).toHaveBeenCalledWith('[cao:route-detail-fixture]', { event: 'initialized', pageId: 'route-detail-fixture', rowCount: 1 });

    rendered.dispatchEvent(new CustomEvent('dashboard-route-change', {
      detail: { parameter: 'fixture', value: 'a' }
    }));
    expect(output.debug).toHaveBeenCalledWith('[cao:route-detail-fixture]', { event: 'matched', pageId: 'route-detail-fixture' });

    rendered.dispatchEvent(new CustomEvent('dashboard-route-change', {
      detail: { parameter: 'fixture', value: 'missing' }
    }));
    expect(output.debug).toHaveBeenCalledWith('[cao:route-detail-fixture]', { event: 'not-found', pageId: 'route-detail-fixture' });

    for (const call of output.debug.mock.calls) {
      const metadata = call[1];
      expect(Object.values(metadata).every((value) => typeof value !== 'object')).toBe(true);
    }
  });
});
