// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetSourceStore } from '../../src/source-store.js';

const metadata = {
  'source-id': 'fixture',
  'source-kind': 'fixture',
  'as-of': '2026-08-31T18:00:00Z',
  'retrieved-at': '2026-08-31T18:01:00Z',
  completeness: /** @type {'complete'} */ ('complete'),
  freshness: /** @type {'fresh'} */ ('fresh'),
  availability: /** @type {'available'} */ ('available')
};

const workflows = [{
  campaign: 'ambient-context',
  'campaign-name': 'Ambient Context',
  organization: 'githubnext',
  repository: 'gh-aw-cao',
  workflow: '.github/workflows/ambient-context.md',
  'workflow-name': 'Ambient Context',
  'workflow-role': 'orchestrator',
  'rollout-mode': 'review'
}];

/** @param {string} [body] */
function context(body) {
  return {
    pageId: 'campaign-detail',
    title: 'Orchestrator and workers',
    sourceNames: ['workflows'],
    contextDetails: [],
    routeParameter: 'campaign',
    headingTag: /** @type {'h3'} */ ('h3'),
    elementConfig: body !== undefined ? { body } : undefined,
    sources: {
      workflows: { source: 'workflows', metadata, rows: workflows }
    }
  };
}

/**
 * @param {ReturnType<typeof vi.fn>} debugFn
 * @param {string} search
 */
function mockDebugModule(debugFn, search) {
  const output = /** @type {Pick<Console, 'debug'>} */ ({ debug: debugFn });
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
}

afterEach(() => {
  resetSourceStore();
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

describe('campaign-route-view debug logging', () => {
  it('is disabled by default (no debug output) when the debug query is absent', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '');
    const { renderCampaignRouteView, renderCampaignRouteVariant } = await import('../../src/components/campaign-route-view.js');

    renderCampaignRouteView(context('overview'));
    renderCampaignRouteVariant(context(), 'workflows');

    expect(debugFn).not.toHaveBeenCalled();
  });

  it('logs the resolved body source and value for element-config renders under its predictable category', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '?debug=campaign-route-view');
    const { renderCampaignRouteView } = await import('../../src/components/campaign-route-view.js');

    renderCampaignRouteView(context('workflows'));

    expect(debugFn).toHaveBeenCalledWith('[cao:campaign-route-view]', {
      event: 'render',
      bodySource: 'element-config',
      body: 'workflows'
    });
  });

  it('reports an unset body as "unset" instead of omitting the field', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '?debug=campaign-route-view');
    const { renderCampaignRouteView } = await import('../../src/components/campaign-route-view.js');

    renderCampaignRouteView(context());

    expect(debugFn).toHaveBeenCalledWith('[cao:campaign-route-view]', {
      event: 'render',
      bodySource: 'element-config',
      body: 'unset'
    });
  });

  it('logs explicit-variant renders with the requested variant', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '?debug=campaign-route-view');
    const { renderCampaignRouteVariant } = await import('../../src/components/campaign-route-view.js');

    renderCampaignRouteVariant(context(), 'problems');

    expect(debugFn).toHaveBeenCalledWith('[cao:campaign-route-view]', {
      event: 'render',
      bodySource: 'explicit-variant',
      body: 'problems'
    });
  });

  it('never logs record content, only scalar metadata', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '?debug=campaign-route-view');
    const { renderCampaignRouteView, renderCampaignRouteVariant } = await import('../../src/components/campaign-route-view.js');

    renderCampaignRouteView(context('workflows'));
    renderCampaignRouteVariant(context(), 'problems');

    for (const call of debugFn.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(typeof value === 'string' || typeof value === 'number').toBe(true);
      }
      expect(JSON.stringify(payload)).not.toContain('ambient-context.md');
      expect(JSON.stringify(payload)).not.toContain('githubnext');
    }
  });
});
