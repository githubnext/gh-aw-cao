// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

const { fetchServerLogs, usesRemoteDataBackend } = vi.hoisted(() => ({
  fetchServerLogs: vi.fn(),
  usesRemoteDataBackend: vi.fn(() => true)
}));
vi.mock('../../src/remote-data-backend.js', () => ({ fetchServerLogs, usesRemoteDataBackend }));
const { usesGitHubAuthentication } = vi.hoisted(() => ({
  usesGitHubAuthentication: vi.fn(() => true)
}));
vi.mock('../../src/auth.js', () => ({ usesGitHubAuthentication }));

afterEach(() => {
  document.body.replaceChildren();
  vi.clearAllMocks();
  usesRemoteDataBackend.mockReturnValue(true);
  usesGitHubAuthentication.mockReturnValue(true);
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

describe('server logs debug logging', () => {
  it('is disabled by default (no debug output) when the debug query is absent', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '');
    fetchServerLogs.mockResolvedValue({ logs: [{ message: 'hello' }] });
    const { renderServerLogsSetting } = await import('../../src/components/server-logs.js');

    const section = renderServerLogsSetting(() => {});
    if (!section) throw new Error('server logs setting did not render');
    document.body.append(section);
    await vi.waitFor(() => expect(section.hidden).toBe(false));

    expect(debugFn).not.toHaveBeenCalled();
  });

  it('logs an availability-checked event under its predictable category', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '?debug=server-logs');
    fetchServerLogs.mockResolvedValue({ logs: [{ message: 'hello' }] });
    const { renderServerLogsSetting } = await import('../../src/components/server-logs.js');

    const section = renderServerLogsSetting(() => {});
    if (!section) throw new Error('server logs setting did not render');
    document.body.append(section);
    await vi.waitFor(() => expect(section.hidden).toBe(false));

    expect(debugFn).toHaveBeenCalledWith('[cao:server-logs]', { event: 'availability-checked', available: true });
  });

  it('logs a load-succeeded event with a scalar count when logs load', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '?debug=server-logs');
    fetchServerLogs.mockResolvedValue({ logs: [{ message: 'one' }, { message: 'two' }] });
    const { renderServerLogsView } = await import('../../src/components/server-logs.js');

    const view = renderServerLogsView(() => {});
    document.body.append(view);
    await vi.waitFor(() => expect(view.querySelector('pre')).not.toBeNull());

    expect(debugFn).toHaveBeenCalledWith('[cao:server-logs]', { event: 'load-succeeded', count: 2 });
  });

  it('logs a load-failed event with only a sanitized error name, never the raw message', async () => {
    const debugFn = vi.fn();
    mockDebugModule(debugFn, '?debug=server-logs');
    fetchServerLogs.mockRejectedValue(new Error('administrator access is required'));
    const { renderServerLogsView } = await import('../../src/components/server-logs.js');

    const view = renderServerLogsView(() => {});
    document.body.append(view);
    await vi.waitFor(() => expect(view.querySelector('[role="alert"]')).not.toBeNull());

    expect(debugFn).toHaveBeenCalledWith('[cao:server-logs]', { event: 'load-failed', error: 'Error' });
    for (const call of debugFn.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean').toBe(true);
      }
      expect(JSON.stringify(payload)).not.toContain('administrator access is required');
    }
  });
});
