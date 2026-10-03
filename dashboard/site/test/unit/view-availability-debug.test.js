import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
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

describe('view-availability debug logging', () => {
  it('is disabled by default (no debug output) when the debug query is absent', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '');
    const { viewBackendAvailable, viewBackendUnavailableMessage } = await import('../../src/view-availability.js');

    viewBackendAvailable({ requires: 'not-an-object' }, 'static');
    viewBackendUnavailableMessage({ requires: { backend: 'hosted' } }, 'static');

    expect(debugFn).not.toHaveBeenCalled();
  });

  it('logs a malformed-requirement event with the predictable category, no view content', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '?debug=view-availability');
    const { viewBackendAvailable } = await import('../../src/view-availability.js');

    const available = viewBackendAvailable({ id: 'secret-view-id', requires: 'not-an-object' }, 'static');

    expect(available).toBe(false);
    expect(debugFn).toHaveBeenCalledWith('[cao:view-availability]', {
      event: 'malformed-requirement',
      backend: 'static'
    });
    for (const call of debugFn.mock.calls) {
      for (const value of Object.values(call[1])) {
        expect(typeof value).not.toBe('object');
      }
    }
  });

  it('logs view-unavailable with required/current backend and a custom-message flag, not the message text', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '?debug=view-availability');
    const { viewBackendUnavailableMessage } = await import('../../src/view-availability.js');

    const message = viewBackendUnavailableMessage({
      id: 'secret-view-id',
      requires: { backend: 'hosted', message: 'Only available with a live server backend.' }
    }, 'static');

    expect(message).toBe('Only available with a live server backend.');
    expect(debugFn).toHaveBeenCalledWith('[cao:view-availability]', {
      event: 'view-unavailable',
      requiredBackend: 'hosted',
      currentBackend: 'static',
      hasCustomMessage: true
    });
  });

  it('falls back to the generic message and reports hasCustomMessage: false when none is provided', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '?debug=view-availability');
    const { viewBackendUnavailableMessage } = await import('../../src/view-availability.js');

    const message = viewBackendUnavailableMessage({ requires: { backend: 'hosted' } }, 'static');

    expect(message).toBe('This view is unavailable on the current dashboard backend.');
    expect(debugFn).toHaveBeenCalledWith('[cao:view-availability]', {
      event: 'view-unavailable',
      requiredBackend: 'hosted',
      currentBackend: 'static',
      hasCustomMessage: false
    });
  });

  it('matches the ?debug=1 wildcard', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '?debug=1');
    const { viewBackendUnavailableMessage } = await import('../../src/view-availability.js');

    viewBackendUnavailableMessage({ requires: { backend: 'hosted' } }, 'static');

    expect(debugFn).toHaveBeenCalledWith('[cao:view-availability]', expect.objectContaining({ event: 'view-unavailable' }));
  });

  it('does not log for available views', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '?debug=view-availability');
    const { viewBackendAvailable, viewBackendUnavailableMessage } = await import('../../src/view-availability.js');

    expect(viewBackendAvailable({ requires: { backend: 'static' } }, 'static')).toBe(true);
    expect(viewBackendUnavailableMessage({ requires: { backend: 'static' } }, 'static')).toBeUndefined();
    expect(viewBackendAvailable('not-a-view', 'static')).toBe(true);

    expect(debugFn).not.toHaveBeenCalled();
  });
});
