// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  document.body.replaceChildren();
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

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

describe('site callout debug logging', () => {
  it('is disabled by default (no debug output) when the debug query is absent', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '');
    const { renderSiteCallouts } = await import('../../src/components/site-callout.js');

    const callouts = [{ id: 'default-off', title: 'Notice', description: 'Some notice' }];
    const element = renderSiteCallouts(callouts, {});
    document.body.append(element ?? document.createElement('div'));
    element?.querySelector('.site-callout-dismiss')?.dispatchEvent(new MouseEvent('click'));

    expect(debugFn).not.toHaveBeenCalled();
  });

  it('logs a rendered event with declared and visible counts under its predictable category', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '?debug=site-callout');
    const { renderSiteCallouts } = await import('../../src/components/site-callout.js');

    const callouts = [
      { id: 'always-visible', title: 'Always', description: 'Always visible' },
      {
        id: 'conditionally-hidden',
        title: 'Conditional',
        description: 'Hidden by source mismatch',
        'visible-when': { source: 'health', field: 'status', equals: 'critical' }
      }
    ];
    renderSiteCallouts(callouts, { health: { rows: [{ status: 'ok' }] } });

    expect(debugFn).toHaveBeenCalledWith('[cao:site-callout]', {
      event: 'rendered',
      declaredCount: 2,
      visibleCount: 1
    });
  });

  it('logs a dismissed event with the callout id when the dismiss button is clicked', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '?debug=site-callout');
    const { renderSiteCallouts } = await import('../../src/components/site-callout.js');

    const callouts = [{ id: 'dismiss-me', title: 'Dismiss me', description: 'A dismissible notice' }];
    const element = renderSiteCallouts(callouts, {});
    document.body.append(/** @type {HTMLElement} */ (element));
    const dismissButton = /** @type {HTMLButtonElement | null} */ (element?.querySelector('.site-callout-dismiss'));
    dismissButton?.click();

    expect(debugFn).toHaveBeenCalledWith('[cao:site-callout]', { event: 'dismissed', id: 'dismiss-me' });
  });

  it('never logs record content, only scalar metadata', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '?debug=site-callout');
    const { renderSiteCallouts } = await import('../../src/components/site-callout.js');

    const callouts = [{ id: 'scalar-only', title: 'Title', description: 'Description text' }];
    const element = renderSiteCallouts(callouts, {});
    document.body.append(/** @type {HTMLElement} */ (element));
    element?.querySelector('.site-callout-dismiss')?.dispatchEvent(new MouseEvent('click'));

    for (const call of debugFn.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean').toBe(true);
      }
    }
  });
});
