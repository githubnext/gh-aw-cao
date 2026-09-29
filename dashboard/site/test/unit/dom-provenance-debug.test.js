// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * @param {string} tag
 * @param {Record<string, unknown>} attrs
 */
function makeElement(tag, attrs = {}) {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    element.setAttribute(name, String(value));
  }
  return element;
}

function buildDashboardRoot() {
  const root = document.createElement('div');
  const page = makeElement('section', { 'data-page-id': 'overview' });
  const section = makeElement('div', { 'data-section-id': 'summary' });
  const view = makeElement('div', { 'data-view-id': 'view-1' });
  section.append(view);
  page.append(section);
  root.append(page);
  return root;
}

const presentationDocument = /** @type {import('../../src/presenter.js').PresentationDocument} */ (/** @type {unknown} */ ({
  dashboard: {
    callouts: [],
    pages: [
      {
        id: 'overview',
        kind: 'custom',
        sections: [{ id: 'summary' }],
        views: [{ id: 'view-1' }]
      }
    ]
  }
}));

const getBuiltInPagePayload = /** @type {(page: import('../../src/presenter.js').PresentableBuiltInPage) => import('../../src/presenter.js').PresentableCustomPage} */ (
  () => ({ id: 'unused', kind: 'custom', sections: [], views: [] })
);

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

describe('dom provenance debug logging', () => {
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
    const { enableDashboardDomProvenance } = await import('../../src/dom-provenance.js');

    const root = buildDashboardRoot();
    enableDashboardDomProvenance(root, presentationDocument, getBuiltInPagePayload);

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs initial and per-page annotation boundaries under its predictable category when enabled', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=dom-provenance', output })
      };
    });
    vi.resetModules();
    const { enableDashboardDomProvenance, annotatePageDom } = await import('../../src/dom-provenance.js');

    const root = buildDashboardRoot();
    enableDashboardDomProvenance(root, presentationDocument, getBuiltInPagePayload);

    expect(output.debug).toHaveBeenCalledWith(
      '[cao:dom-provenance]',
      { event: 'initial-annotation', pageCount: 1 }
    );
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:dom-provenance]',
      { event: 'page-annotated', pageId: 'overview', sectionCount: 1, viewCount: 1 }
    );

    output.debug.mockClear();
    const renderedPage = /** @type {Element} */ (root.querySelector('[data-page-id="overview"]'));
    annotatePageDom(renderedPage, presentationDocument.dashboard.pages[0], 0, getBuiltInPagePayload);
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:dom-provenance]',
      { event: 'page-annotated', pageId: 'overview', sectionCount: 1, viewCount: 1 }
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
          actual.createDebug(category, { search: () => '?debug=dom-provenance', output })
      };
    });
    vi.resetModules();
    const { enableDashboardDomProvenance } = await import('../../src/dom-provenance.js');

    const root = buildDashboardRoot();
    enableDashboardDomProvenance(root, presentationDocument, getBuiltInPagePayload);

    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean').toBe(true);
      }
    }
  });
});
