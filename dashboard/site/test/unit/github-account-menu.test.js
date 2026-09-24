// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { enableGitHubAccountMenu, renderGitHubAccountMenu } from '../../src/components/github-account-menu.js';

afterEach(() => {
  document.head.replaceChildren();
  document.body.replaceChildren();
});

describe('GitHub account menu', () => {
  it('shows the active user and switches between authenticated accounts', async () => {
    const marker = document.createElement('meta');
    marker.name = 'dashboard-authentication';
    marker.content = 'github';
    document.head.append(marker);
    const menu = /** @type {HTMLElement} */ (renderGitHubAccountMenu());
    document.body.append(menu);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        authenticated: true,
        active: { login: 'octocat', name: 'Octo Cat', avatarUrl: 'https://avatars.example/octocat', active: true },
        accounts: [
          { login: 'octocat', name: 'Octo Cat', avatarUrl: 'https://avatars.example/octocat', active: true },
          { login: 'hubot', name: 'Hubot', avatarUrl: 'https://avatars.example/hubot', active: false }
        ]
      }))
      .mockResolvedValueOnce(jsonResponse({
        authenticated: true,
        active: { login: 'hubot', name: 'Hubot', active: true },
        accounts: []
      }));
    const location = { reload: vi.fn(), assign: vi.fn() };
    const controller = new AbortController();

    enableGitHubAccountMenu(document.body, controller.signal, {
      fetch: fetchMock,
      location: /** @type {Location} */ (/** @type {unknown} */ (location))
    });

    await vi.waitFor(() => expect(menu.hidden).toBe(false));
    expect(menu.querySelector('summary')?.getAttribute('aria-label')).toBe('Open user view');
    expect(menu.textContent).toContain('Octo Cat');
    const hubot = [...menu.querySelectorAll('.account-menu-action')]
      .find((candidate) => candidate.textContent?.includes('Hubot'));
    expect(hubot).toBeInstanceOf(HTMLButtonElement);
    hubot?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await vi.waitFor(() => expect(location.reload).toHaveBeenCalledOnce());
    expect(fetchMock).toHaveBeenLastCalledWith('/api/v1/auth/switch', expect.objectContaining({
      method: 'POST',
      credentials: 'same-origin'
    }));
    expect(JSON.parse(String(fetchMock.mock.calls.at(-1)?.[1]?.body))).toEqual({ login: 'hubot' });
    controller.abort();
  });

  it('signs out and returns to login when no account remains', async () => {
    const marker = document.createElement('meta');
    marker.name = 'dashboard-authentication';
    marker.content = 'github';
    document.head.append(marker);
    const menu = /** @type {HTMLElement} */ (renderGitHubAccountMenu());
    document.body.append(menu);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        authenticated: true,
        active: { login: 'octocat', active: true },
        accounts: [{ login: 'octocat', active: true }]
      }))
      .mockResolvedValueOnce(jsonResponse({ authenticated: false, accounts: [] }));
    const location = { reload: vi.fn(), assign: vi.fn() };

    enableGitHubAccountMenu(document.body, new AbortController().signal, {
      fetch: fetchMock,
      location: /** @type {Location} */ (/** @type {unknown} */ (location))
    });

    await vi.waitFor(() => expect(menu.hidden).toBe(false));
    const signOut = menu.querySelector('.account-menu-sign-out');
    signOut?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await vi.waitFor(() => expect(location.assign).toHaveBeenCalledWith('/auth/login'));
  });
});

/** @param {unknown} value */
function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}
