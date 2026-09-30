import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

describe('attention rules debug logging', () => {
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
    const { buildAttentionItems } = await import('../../src/components/attention-rules.js');

    buildAttentionItems({ 'admission-blocked': { count: 2, list: 'a, b' } });

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs predictable rule/build metadata under its category name when enabled', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=attention-rules', output })
      };
    });
    vi.resetModules();
    const { buildAttentionItems } = await import('../../src/components/attention-rules.js');

    buildAttentionItems({ 'admission-blocked': { count: 2, list: 'sensitive-repo-name' } });
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:attention-rules]',
      { event: 'items-built', ruleCount: 9, firedCount: 1 }
    );

    output.debug.mockClear();
    buildAttentionItems({});
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:attention-rules]',
      { event: 'items-built', ruleCount: 9, firedCount: 0 }
    );

    // Never log the raw, potentially sensitive metric values themselves.
    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      expect(JSON.stringify(payload)).not.toContain('sensitive-repo-name');
    }
  });
});
