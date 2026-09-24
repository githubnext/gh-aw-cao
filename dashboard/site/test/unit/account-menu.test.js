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
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ login: 'octocat-enterprise' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ loginUrl: 'invalid-for-test' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const menu = renderAccountMenu();
    expect(menu).toBeInstanceOf(HTMLDetailsElement);
    if (!(menu instanceof HTMLDetailsElement)) throw new Error('account menu was not rendered');
    document.body.append(menu);
    await vi.waitFor(() => expect(menu.hidden).toBe(false));
    expect(menu.textContent).toContain('@octocat-enterprise');

    const switchButton = menu.querySelector('[data-switch-account]');
    expect(switchButton).toBeInstanceOf(HTMLButtonElement);
    if (!(switchButton instanceof HTMLButtonElement)) throw new Error('account switch button was not rendered');
    switchButton.click();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock).toHaveBeenLastCalledWith('/auth/switch-account', {
      method: 'POST',
      headers: { Accept: 'application/json' }
    });
  });
});
