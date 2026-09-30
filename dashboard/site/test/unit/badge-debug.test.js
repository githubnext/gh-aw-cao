// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

/**
 * Loads badge.js with a stubbed debug output so assertions can inspect
 * emitted metadata without depending on module state left over from other
 * tests.
 * @param {string} search
 */
async function loadBadgeWithDebug(search) {
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
  const module = await import('../../src/components/badge.js');
  return { ...module, output };
}

describe('badge debug logging', () => {
  it('is disabled by default (no debug output) when the debug query is absent', async () => {
    const { renderStatusBadge, renderGraderStatusBadge, renderModeBadge, output } =
      await loadBadgeWithDebug('');

    renderStatusBadge('totally-unrecognized-status');
    renderGraderStatusBadge('totally-unrecognized-status');
    renderModeBadge('totally-unrecognized-mode');

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs a status-unmatched event under the predictable category name derived from the filename', async () => {
    const { renderStatusBadge, output } = await loadBadgeWithDebug('?debug=badge');

    const badge = renderStatusBadge('Totally-Unrecognized-Status');

    expect(badge.className).toBe('status status-muted');
    expect(output.debug).toHaveBeenCalledWith('[cao:badge]', {
      event: 'status-unmatched',
      normalized: 'totally-unrecognized-status',
      statusClass: 'status-muted'
    });
  });

  it('does not log when a status value matches a known classification', async () => {
    const { renderStatusBadge, output } = await loadBadgeWithDebug('?debug=badge');

    renderStatusBadge('success');
    renderStatusBadge('attention');
    renderStatusBadge('failure');

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs a grader-status-unmatched event for unrecognized grader status values', async () => {
    const { renderGraderStatusBadge, output } = await loadBadgeWithDebug('?debug=badge');

    renderGraderStatusBadge('unexpected');

    expect(output.debug).toHaveBeenCalledWith('[cao:badge]', {
      event: 'grader-status-unmatched',
      normalized: 'unexpected',
      statusClass: 'status-attention'
    });
  });

  it('does not log when a grader status matches a known value', async () => {
    const { renderGraderStatusBadge, output } = await loadBadgeWithDebug('?debug=badge');

    renderGraderStatusBadge('pass');
    renderGraderStatusBadge('fail');
    renderGraderStatusBadge('error');

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs a mode-unmatched event for unrecognized rollout mode values', async () => {
    const { renderModeBadge, output } = await loadBadgeWithDebug('?debug=badge');

    renderModeBadge('unknown-mode');

    expect(output.debug).toHaveBeenCalledWith('[cao:badge]', {
      event: 'mode-unmatched',
      normalized: 'unknown-mode'
    });
  });

  it('does not log when a rollout mode matches a known value', async () => {
    const { renderModeBadge, output } = await loadBadgeWithDebug('?debug=badge');

    renderModeBadge('live');
    renderModeBadge('review');

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('never logs the raw source value, only scalar metadata', async () => {
    const { renderStatusBadge, renderGraderStatusBadge, renderModeBadge, output } =
      await loadBadgeWithDebug('?debug=badge');

    renderStatusBadge('Do_Not_Log_This_Secret_Value');
    renderGraderStatusBadge('Do_Not_Log_This_Secret_Value_Either');
    renderModeBadge('Nor_This_One');

    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean').toBe(true);
      }
    }
  });
});
