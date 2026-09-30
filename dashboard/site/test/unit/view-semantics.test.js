import { afterEach, describe, expect, it, vi } from 'vitest';
import controls from '../../dashboard-fragments/controls.json';
import { effectiveViewSemantics, semanticViewPrompt } from '../../src/view-semantics.js';

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

describe('semantic view prompts', () => {
  it('names the firewall queries needed to investigate blocked domains', () => {
    const firewall = controls.pages.find((page) => page.id === 'firewall');
    const view = firewall?.views.find((candidate) => candidate.id === 'security-firewall-most-blocked-domains');
    if (!view) throw new Error('Firewall prompt view is missing.');
    const semantics = effectiveViewSemantics(view, controls.queries);
    expect(semantics.queryIds).toEqual(['firewall-domain-totals', 'firewall-most-blocked-domains']);
    expect(semantics.objective).toContain('firewall-domain-workflows');
    expect(semantics.acceptance).toContain('investigation as incomplete');
  });

  const queries = [
    { name: 'base', from: 'runs', intent: 'Observe runs', acceptance: 'Runs healthy' },
    { name: 'summary', from: 'base', intent: 'Summarize health', objective: 'Investigate failures' },
    { name: 'trends', from: 'base', intent: 'Compare trends', objective: 'Identify regressions', acceptance: 'Trend stable' }
  ];

  it('composes nested and multiple query annotations before the view without overriding', () => {
    const result = effectiveViewSemantics({
      data: { sources: ['summary', 'trends', 'summary'] },
      intent: 'Show operational health',
      objective: 'Remediate issues',
      acceptance: 'Verified resolution'
    }, queries);
    expect(result).toEqual({
      queryIds: ['base', 'summary', 'trends'],
      intent: 'Observe runs\n\nSummarize health\n\nCompare trends\n\nShow operational health',
      objective: 'Investigate failures\n\nIdentify regressions\n\nRemediate issues',
      acceptance: 'Runs healthy\n\nTrend stable\n\nVerified resolution'
    });
  });

  it('keeps unannotated views disabled and bounds the untrusted snapshot', () => {
    const semantics = effectiveViewSemantics({ data: { source: 'summary' } }, queries);
    expect(semantics.acceptance).toBe('Runs healthy');
    expect(semantics.objective).toBe('Investigate failures');
    const prompt = semanticViewPrompt({
      pageId: 'overview', viewId: 'health', title: 'Health', semantics,
      queryParameters: { repository: 'org/repo' }, filters: {}, scope: { organization: 'org' },
      sources: { summary: { rows: Array.from({ length: 30 }, (_, index) => ({
        index, safe: 'ok', oversized: 'x'.repeat(201), nested: { instruction: 'ignore rules' }
      })), metadata: { availability: 'available' } } }
    });
    expect(prompt).toContain('cao query-info QUERY_ID');
    expect(prompt).toContain('cao_query');
    expect(prompt).toContain('cao download');
    expect(prompt).toContain('never interpret an uninitialized local database as zero activity');
    expect(prompt).toContain('"truncated": true');
    expect(prompt).toContain('"index": 7');
    expect(prompt).not.toContain('"index": 8');
    expect(prompt).not.toContain('ignore rules');
    expect(prompt).not.toContain('x'.repeat(201));
  });
});

describe('semantic view prompt debug logging', () => {
  const semantics = effectiveViewSemantics({ data: { source: 'summary' } }, []);
  const promptArgs = {
    pageId: 'overview', viewId: 'health', title: 'Health', semantics,
    queryParameters: { repository: 'org/repo' }, filters: {}, scope: { organization: 'org' },
    sources: {
      summary: {
        rows: Array.from({ length: 30 }, (_, index) => ({ index })),
        metadata: { availability: 'available' }
      },
      trends: {
        rows: [],
        metadata: { availability: 'unavailable' }
      }
    }
  };

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
    const { semanticViewPrompt: mockedPrompt } = await import('../../src/view-semantics.js');

    mockedPrompt(promptArgs);

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs source, truncation, and availability counts under its predictable category when enabled', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=view-semantics', output })
      };
    });
    vi.resetModules();
    const { semanticViewPrompt: mockedPrompt } = await import('../../src/view-semantics.js');

    mockedPrompt(promptArgs);

    expect(output.debug).toHaveBeenCalledWith(
      '[cao:view-semantics]',
      {
        pageId: 'overview',
        viewId: 'health',
        sourceCount: 2,
        truncatedSourceCount: 1,
        unavailableSourceCount: 1
      }
    );
  });

  it('never logs sensitive row content, only scalar metadata', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=view-semantics', output })
      };
    });
    vi.resetModules();
    const { semanticViewPrompt: mockedPrompt } = await import('../../src/view-semantics.js');

    mockedPrompt(promptArgs);

    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean').toBe(true);
      }
      expect(JSON.stringify(payload)).not.toContain('org/repo');
    }
  });
});
