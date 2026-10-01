// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderAccountMenu } from '../../src/components/account-menu.js';

afterEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  document.cookie = 'cao_csrf=; Max-Age=0; Path=/';
  vi.restoreAllMocks();
});

describe('hosted GitHub account menu', () => {
  it('uses only fixed, value-free authentication debug events', () => {
    const source = readFileSync(`${process.cwd()}/src/components/account-menu.js`, 'utf8');
    const argumentsList = [...source.matchAll(/\bdebug\(([^)]*)\)/g)].map((match) => match[1]);

    expect(argumentsList.length).toBeGreaterThan(0);
    expect(argumentsList.every((argument) => /^'[a-z_]+\.[a-z_]+'$/.test(argument))).toBe(true);
  });

  it('is omitted outside the hosted GitHub authentication profile', () => {
    const debug = vi.fn();
    expect(renderAccountMenu({ debug })).toBeNull();
    expect(debug).toHaveBeenCalledWith('profile.not_hosted');
  });

  it('shows the current login and requests explicit account switching', async () => {
    document.head.innerHTML = '<meta name="cao-auth-mode" content="github">';
    document.cookie = 'cao_csrf=account-csrf-token; Path=/';
    const navigate = vi.fn();
    const debug = vi.fn();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        login: 'octocat-enterprise',
        avatarUrl: 'https://avatars.githubusercontent.com/u/583231?v=4'
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ loginUrl: '/auth/login?select_account=1' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    const menu = renderAccountMenu({ navigate, debug });
    expect(menu).toBeInstanceOf(HTMLDetailsElement);
    if (!(menu instanceof HTMLDetailsElement)) throw new Error('account menu was not rendered');
    document.body.append(menu);
    await vi.waitFor(() => expect(menu.hidden).toBe(false));
    expect(menu.querySelector('summary')?.getAttribute('aria-label')).toBe('Open user view for @octocat-enterprise');
    expect(menu.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('User');
    expect(menu.textContent).toContain('Account');
    expect(menu.textContent).toContain('@octocat-enterprise');
    expect(menu.textContent).toContain('Log out');
    const avatar = menu.querySelector('.account-menu-avatar-image');
    const avatarFallback = menu.querySelector('.account-menu-avatar-fallback');
    expect(avatar).toBeInstanceOf(HTMLImageElement);
    if (!(avatar instanceof HTMLImageElement)) throw new Error('account avatar was not rendered');
    expect(avatar.src).toBe('https://avatars.githubusercontent.com/u/583231?v=4');
    expect(avatar.hidden).toBe(true);
    avatar.dispatchEvent(new Event('load'));
    await vi.waitFor(() => expect(avatar.hidden).toBe(false));
    expect(avatarFallback?.hasAttribute('hidden')).toBe(true);

    const switchButton = menu.querySelector('[data-switch-account]');
    expect(switchButton).toBeInstanceOf(HTMLButtonElement);
    if (!(switchButton instanceof HTMLButtonElement)) throw new Error('account switch button was not rendered');
    switchButton.click();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock).toHaveBeenLastCalledWith('/auth/switch-account', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'X-CSRF-Token': 'account-csrf-token'
      }
    });
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith('/auth/login?select_account=1'));

    const logoutButton = menu.querySelector('[data-logout]');
    expect(logoutButton).toBeInstanceOf(HTMLButtonElement);
    if (!(logoutButton instanceof HTMLButtonElement)) throw new Error('logout button was not rendered');
    logoutButton.click();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock).toHaveBeenLastCalledWith('/auth/logout', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'X-CSRF-Token': 'account-csrf-token'
      }
    });
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith('/auth/logged-out'));
    expect(debug.mock.calls.map(([event]) => event)).toEqual([
      'profile.hosted',
      'session.request_started',
      'session.available',
      'switch.request_started',
      'switch.succeeded',
      'switch.navigation_started',
      'logout.request_started',
      'logout.succeeded',
      'logout.navigation_started'
    ]);
    expect(JSON.stringify(debug.mock.calls)).not.toContain('octocat-enterprise');
  });

  it('stays hidden when hosted metadata exists without a logged-in session', async () => {
    document.head.innerHTML = '<meta name="cao-auth-mode" content="github">';
    const debug = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 401 })));

    const menu = renderAccountMenu({ debug });
    expect(menu).toBeInstanceOf(HTMLDetailsElement);
    if (!(menu instanceof HTMLDetailsElement)) throw new Error('account menu was not rendered');
    document.body.append(menu);
    await vi.waitFor(() => expect(menu.dataset.error).toBeTruthy());

    expect(menu.hidden).toBe(true);
    expect(debug.mock.calls.map(([event]) => event)).toEqual([
      'profile.hosted',
      'session.request_started',
      'session.response_rejected',
      'session.unavailable'
    ]);
  });

  it('keeps the person icon when the session has no usable avatar URL', async () => {
    document.head.innerHTML = '<meta name="cao-auth-mode" content="github">';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ login: 'octocat', avatarUrl: 'javascript:alert(1)' }), { status: 200 })
    ));

    const menu = renderAccountMenu();
    if (!(menu instanceof HTMLDetailsElement)) throw new Error('account menu was not rendered');
    document.body.append(menu);
    await vi.waitFor(() => expect(menu.hidden).toBe(false));

    expect(menu.querySelector('.account-menu-avatar-image')?.hasAttribute('src')).toBe(false);
    expect(menu.querySelector('.account-menu-avatar-fallback')?.hasAttribute('hidden')).toBe(false);
  });

  it('logs invalid null payloads without throwing unclassified errors', async () => {
    document.head.innerHTML = '<meta name="cao-auth-mode" content="github">';
    const debug = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('null', { status: 200, headers: { 'Content-Type': 'application/json' } })
    ));

    const menu = renderAccountMenu({ debug });
    if (!(menu instanceof HTMLDetailsElement)) throw new Error('account menu was not rendered');
    document.body.append(menu);
    await vi.waitFor(() => expect(menu.dataset.error).toBe('GitHub account session is unavailable'));

    expect(debug.mock.calls.map(([event]) => event)).toEqual([
      'profile.hosted',
      'session.request_started',
      'session.payload_invalid',
      'session.unavailable'
    ]);
  });

  it('classifies a null account-switch payload as invalid', async () => {
    document.head.innerHTML = '<meta name="cao-auth-mode" content="github">';
    document.cookie = 'cao_csrf=account-csrf-token; Path=/';
    const debug = vi.fn();
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ login: 'octocat' }), { status: 200 }))
      .mockResolvedValueOnce(new Response('null', { status: 200 })));

    const menu = renderAccountMenu({ debug });
    if (!(menu instanceof HTMLDetailsElement)) throw new Error('account menu was not rendered');
    document.body.append(menu);
    await vi.waitFor(() => expect(menu.hidden).toBe(false));
    const switchButton = menu.querySelector('[data-switch-account]');
    if (!(switchButton instanceof HTMLButtonElement)) throw new Error('account switch button was not rendered');
    switchButton.click();
    await vi.waitFor(() => expect(menu.dataset.error).toBe('Unable to switch GitHub account'));

    expect(debug.mock.calls.map(([event]) => event)).toContain('switch.payload_invalid');
  });

  it('logs fixed failure branches without response or error details', async () => {
    document.head.innerHTML = '<meta name="cao-auth-mode" content="github">';
    document.cookie = 'cao_csrf=account-csrf-token; Path=/';
    const debug = vi.fn();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ login: 'sensitive-login' }), { status: 200 }))
      .mockResolvedValueOnce(new Response('sensitive-switch-response', { status: 500 }))
      .mockRejectedValueOnce(new Error('sensitive-network-error'));
    vi.stubGlobal('fetch', fetchMock);

    const menu = renderAccountMenu({ debug });
    if (!(menu instanceof HTMLDetailsElement)) throw new Error('account menu was not rendered');
    document.body.append(menu);
    await vi.waitFor(() => expect(menu.hidden).toBe(false));

    const switchButton = menu.querySelector('[data-switch-account]');
    const logoutButton = menu.querySelector('[data-logout]');
    if (!(switchButton instanceof HTMLButtonElement) || !(logoutButton instanceof HTMLButtonElement)) {
      throw new Error('account actions were not rendered');
    }
    switchButton.click();
    await vi.waitFor(() => expect(menu.dataset.error).toBe('Unable to switch GitHub account'));
    delete menu.dataset.error;
    logoutButton.click();
    await vi.waitFor(() => expect(menu.dataset.error).toBe('Unable to log out'));

    expect(debug.mock.calls.map(([event]) => event)).toEqual([
      'profile.hosted',
      'session.request_started',
      'session.available',
      'switch.request_started',
      'switch.response_rejected',
      'switch.failed',
      'logout.request_started',
      'logout.request_failed',
      'logout.failed'
    ]);
    const logs = JSON.stringify(debug.mock.calls);
    expect(logs).not.toContain('sensitive-login');
    expect(logs).not.toContain('sensitive-switch-response');
    expect(logs).not.toContain('sensitive-network-error');
  });

  it('recovers an expired CSRF cookie before account actions', async () => {
    document.head.innerHTML = '<meta name="cao-auth-mode" content="github">';
    const navigate = vi.fn();
    const fetchMock = vi.fn().mockImplementation((url) => {
      if (url === '/api/auth/session') {
        document.cookie = 'cao_csrf=restored-token; Path=/';
        return Promise.resolve(new Response(JSON.stringify({ login: 'octocat' }), { status: 200 }));
      }
      if (url === '/auth/switch-account') {
        return Promise.resolve(new Response(JSON.stringify({ loginUrl: '/auth/login?select_account=1' }), { status: 200 }));
      }
      return Promise.resolve(new Response(null, { status: 204 }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const menu = renderAccountMenu({ navigate });
    if (!(menu instanceof HTMLDetailsElement)) throw new Error('account menu was not rendered');
    document.body.append(menu);
    await vi.waitFor(() => expect(menu.hidden).toBe(false));
    document.cookie = 'cao_csrf=; Max-Age=0; Path=/';
    const switchButton = menu.querySelector('[data-switch-account]');
    if (!(switchButton instanceof HTMLButtonElement)) throw new Error('account switch button was not rendered');
    switchButton.click();
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith('/auth/login?select_account=1'));
    document.cookie = 'cao_csrf=; Max-Age=0; Path=/';
    const logoutButton = menu.querySelector('[data-logout]');
    if (!(logoutButton instanceof HTMLButtonElement)) throw new Error('logout button was not rendered');
    logoutButton.click();
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith('/auth/logged-out'));

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/auth/session', '/api/auth/session', '/auth/switch-account',
      '/api/auth/session', '/auth/logout',
    ]);
    expect(fetchMock.mock.calls[2][1].headers).toHaveProperty('X-CSRF-Token', 'restored-token');
    expect(fetchMock.mock.calls[4][1].headers).toHaveProperty('X-CSRF-Token', 'restored-token');
  });

  it('stops reacting to session state once the menu detaches from the document', async () => {
    document.head.innerHTML = '<meta name="cao-auth-mode" content="github">';
    const debug = vi.fn();
    const fetchMock = vi.fn().mockImplementation(() => new Promise(() => {}));
    vi.stubGlobal('fetch', fetchMock);

    const menu = renderAccountMenu({ debug });
    if (!(menu instanceof HTMLDetailsElement)) throw new Error('account menu was not rendered');
    document.body.append(menu);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    menu.remove();
    // Let the MutationObserver microtask backing createFactoryScope run.
    await new Promise((resolve) => queueMicrotask(() => resolve(undefined)));

    document.body.append(menu);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ login: 'late-arrival' }), { status: 200 }));

    // The effect stopped when the menu detached, so a resolved session after
    // reattachment no longer reveals the menu or updates its login label.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(menu.hidden).toBe(true);
    expect(menu.textContent).not.toContain('@late-arrival');
  });
});
