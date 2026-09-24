// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderAccountMenu } from '../../src/components/account-menu.js';

afterEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('hosted GitHub account menu', () => {
  it('is omitted outside the hosted GitHub authentication profile', () => {
    expect(renderAccountMenu()).toBeNull();
  });

  it('shows the current login and requests explicit account switching', async () => {
    document.head.innerHTML = '<meta name="cao-auth-mode" content="github">';
    const navigate = vi.fn();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ login: 'octocat-enterprise' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ loginUrl: '/auth/login?select_account=1' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    const menu = renderAccountMenu({ navigate });
    expect(menu).toBeInstanceOf(HTMLDetailsElement);
    if (!(menu instanceof HTMLDetailsElement)) throw new Error('account menu was not rendered');
    document.body.append(menu);
    await vi.waitFor(() => expect(menu.hidden).toBe(false));
    expect(menu.querySelector('summary')?.getAttribute('aria-label')).toBe('Open user view');
    expect(menu.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('User');
    expect(menu.textContent).toContain('Account');
    expect(menu.textContent).toContain('@octocat-enterprise');
    expect(menu.textContent).toContain('Log out');

    const switchButton = menu.querySelector('[data-switch-account]');
    expect(switchButton).toBeInstanceOf(HTMLButtonElement);
    if (!(switchButton instanceof HTMLButtonElement)) throw new Error('account switch button was not rendered');
    switchButton.click();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock).toHaveBeenLastCalledWith('/auth/switch-account', {
      method: 'POST',
      headers: { Accept: 'application/json' }
    });
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith('/auth/login?select_account=1'));

    const logoutButton = menu.querySelector('[data-logout]');
    expect(logoutButton).toBeInstanceOf(HTMLButtonElement);
    if (!(logoutButton instanceof HTMLButtonElement)) throw new Error('logout button was not rendered');
    logoutButton.click();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(fetchMock).toHaveBeenLastCalledWith('/auth/logout', {
      method: 'POST',
      headers: { Accept: 'application/json' }
    });
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledWith('/auth/logged-out'));
  });

  it('stays hidden when hosted metadata exists without a logged-in session', async () => {
    document.head.innerHTML = '<meta name="cao-auth-mode" content="github">';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 401 })));

    const menu = renderAccountMenu();
    expect(menu).toBeInstanceOf(HTMLDetailsElement);
    if (!(menu instanceof HTMLDetailsElement)) throw new Error('account menu was not rendered');
    document.body.append(menu);
    await vi.waitFor(() => expect(menu.dataset.error).toBeTruthy());

    expect(menu.hidden).toBe(true);
  });
});
