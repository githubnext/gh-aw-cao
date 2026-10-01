// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Loads renderFactoryRhythm with a stubbed debug output so assertions can
 * inspect emitted metadata without depending on module state left over from
 * other tests.
 * @param {string} search
 */
async function loadFactoryRhythmWithDebug(search) {
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
  const module = await import('../../src/components/factory-rhythm.js');
  return { ...module, output };
}

const VALID_DAY = { label: 'Mon', date: '2026-09-07', current: 3, previous: 1, reached: true };
const VALID_WEEK = Array.from({ length: 7 }, (_, index) => ({ ...VALID_DAY, label: `Day${index}` }));

/** @param {Record<string, unknown>[]} days */
function rhythmSource(days, pending = false) {
  return { rows: () => [{ rhythm: { days } }], pending: () => pending };
}

describe('factory-rhythm debug logging', () => {
  afterEach(async () => {
    vi.doUnmock('../../src/debug.js');
    vi.resetModules();
  });

  it('is disabled by default when the debug query is absent', async () => {
    const { renderFactoryRhythm, output } = await loadFactoryRhythmWithDebug('');
    const controller = new AbortController();

    renderFactoryRhythm(rhythmSource(VALID_WEEK), { signal: controller.signal });

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs composition and pending state under its predictable category', async () => {
    const { renderFactoryRhythm, output } = await loadFactoryRhythmWithDebug('?debug=factory-rhythm');
    const controller = new AbortController();

    renderFactoryRhythm(rhythmSource(VALID_WEEK, true), { signal: controller.signal });

    expect(output.debug).toHaveBeenCalledWith('[cao:factory-rhythm]', { event: 'composed' });
    expect(output.debug).toHaveBeenCalledWith('[cao:factory-rhythm]', { event: 'pending-changed', pending: true });

    for (const call of output.debug.mock.calls) {
      const category = call[0];
      const value = call[1];
      expect(category).toBe('[cao:factory-rhythm]');
      expect(Object.values(value).every((entry) => typeof entry !== 'object')).toBe(true);
    }
  });

  it('logs a payload fallback when the source does not supply a full week', async () => {
    const { renderFactoryRhythm, output } = await loadFactoryRhythmWithDebug('?debug=factory-rhythm');
    const controller = new AbortController();

    renderFactoryRhythm(rhythmSource([VALID_DAY]), { signal: controller.signal });

    expect(output.debug).toHaveBeenCalledWith('[cao:factory-rhythm]', {
      event: 'payload-fallback',
      receivedDayCount: 1
    });
  });

  it('does not log a payload fallback for a well-formed week', async () => {
    const { renderFactoryRhythm, output } = await loadFactoryRhythmWithDebug('?debug=factory-rhythm');
    const controller = new AbortController();

    renderFactoryRhythm(rhythmSource(VALID_WEEK), { signal: controller.signal });

    expect(output.debug).not.toHaveBeenCalledWith('[cao:factory-rhythm]', expect.objectContaining({ event: 'payload-fallback' }));
  });
});
