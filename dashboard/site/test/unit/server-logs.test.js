// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

const { fetchServerLogs, usesRemoteDataBackend } = vi.hoisted(() => ({
  fetchServerLogs: vi.fn(),
  usesRemoteDataBackend: vi.fn(() => true)
}));
vi.mock('../../src/remote-data-backend.js', () => ({ fetchServerLogs, usesRemoteDataBackend }));

import { renderServerLogsSetting, renderServerLogsView } from '../../src/components/server-logs.js';

afterEach(() => {
  document.body.replaceChildren();
  vi.clearAllMocks();
  usesRemoteDataBackend.mockReturnValue(true);
});

describe('administrator server logs', () => {
  it('hides the settings entry outside server mode and without admin access', async () => {
    usesRemoteDataBackend.mockReturnValue(false);
    expect(renderServerLogsSetting(() => {})).toBeNull();
    usesRemoteDataBackend.mockReturnValue(true);
    fetchServerLogs.mockRejectedValue(new Error('administrator access is required'));
    const section = renderServerLogsSetting(() => {});
    if (!section) throw new Error('server logs setting did not render');
    document.body.append(section);
    await vi.waitFor(() => expect(fetchServerLogs).toHaveBeenCalledOnce());
    expect(section.hidden).toBe(true);
  });

  it('opens only for authorized viewers and displays escaped full-width preformatted logs', async () => {
    fetchServerLogs.mockResolvedValue({ logs: [{ message: '<script>alert(1)</script>' }], redis: { status: 'ok' } });
    const open = vi.fn();
    const section = renderServerLogsSetting(open);
    if (!section) throw new Error('server logs setting did not render');
    document.body.append(section);
    await vi.waitFor(() => expect(section.hidden).toBe(false));
    expect(section.querySelector('h3')?.textContent).toBe('Logs');
    section.querySelector('button')?.click();
    expect(open).toHaveBeenCalledOnce();

    const back = vi.fn();
    const view = renderServerLogsView(back);
    document.body.append(view);
    await vi.waitFor(() => expect(view.querySelector('pre code')?.textContent).toContain('<script>alert(1)</script>'));
    expect(view.querySelector('script')).toBeNull();
    expect(view.querySelector('pre')?.textContent).toContain('"redis"');
    view.querySelector('button')?.click();
    expect(back).toHaveBeenCalledOnce();
  });

  it('reports failed refreshes and aborts in-flight requests on removal', async () => {
    fetchServerLogs.mockResolvedValueOnce({ logs: [] })
      .mockRejectedValueOnce(new Error('administrator access is required'));
    const view = renderServerLogsView(() => {});
    document.body.append(view);
    await vi.waitFor(() => expect(view.querySelector('pre')).not.toBeNull());
    view.querySelectorAll('button')[1].click();
    await vi.waitFor(() => expect(view.querySelector('[role="alert"]')?.textContent).toContain('administrator access is required'));
    fetchServerLogs.mockImplementationOnce(() => new Promise(() => {}));
    view.querySelectorAll('button')[1].click();
    const signal = fetchServerLogs.mock.lastCall?.[0];
    if (!signal) throw new Error('server logs request was not made');
    view.remove();
    await vi.waitFor(() => expect(signal.aborted).toBe(true));
  });
});
