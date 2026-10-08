import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

describe('campaign route composition debug logging', () => {
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
    const { campaignRouteComposition, normalizeCampaignRoute } =
      await import('../../src/components/campaign-route-composition.js');

    campaignRouteComposition('overview');
    normalizeCampaignRoute('not a valid campaign id!');

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs predictable composition resolution metadata under its category name when enabled', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=campaign-route-composition', output })
      };
    });
    vi.resetModules();
    const { campaignRouteComposition } = await import('../../src/components/campaign-route-composition.js');

    campaignRouteComposition('workflows');
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:campaign-route-composition]',
      { event: 'composition-resolved', tab: 'workflows', fellBackToDefault: false }
    );

    output.debug.mockClear();
    campaignRouteComposition('<unknown-with-sensitive-text>');
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:campaign-route-composition]',
      { event: 'composition-resolved', tab: 'insights', fellBackToDefault: true }
    );

    // Never log the raw, potentially sensitive requested body value itself.
    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      expect(JSON.stringify(payload)).not.toContain('sensitive-text');
    }
  });

  it('logs a rejected route outcome without the raw campaign id value', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=campaign-route-composition', output })
      };
    });
    vi.resetModules();
    const { normalizeCampaignRoute } = await import('../../src/components/campaign-route-composition.js');

    const result = normalizeCampaignRoute('<sensitive-text-with-invalid-chars>');
    expect(result).toBe('');
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:campaign-route-composition]',
      { event: 'route-rejected', length: '<sensitive-text-with-invalid-chars>'.length }
    );

    // Never log the raw, potentially sensitive route value itself.
    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      expect(JSON.stringify(payload)).not.toContain('sensitive-text');
    }

    output.debug.mockClear();
    const validResult = normalizeCampaignRoute('ambient-context');
    expect(validResult).toBe('ambient-context');
    expect(output.debug).not.toHaveBeenCalled();
  });
});
