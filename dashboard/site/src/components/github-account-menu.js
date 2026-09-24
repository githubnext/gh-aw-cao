import { h } from '../dom.js';
import { octicon } from '../octicons.js';
import { render, state } from '../reactive.js';

/** @typedef {{ login: string, name?: string, avatarUrl?: string, active: boolean }} GitHubAccount */
/** @typedef {{ authenticated: boolean, active?: GitHubAccount, accounts: GitHubAccount[] }} GitHubAccountState */

export function renderGitHubAccountMenu() {
  if (document.querySelector('meta[name="dashboard-authentication"]')?.getAttribute('content') !== 'github') return null;
  return h(
    'details',
    { className: 'account-menu sidebar-account-menu', hidden: true },
    h(
      'summary',
      { className: 'account-menu-avatar', 'aria-label': 'Open user view', title: 'User' },
      h('span', { className: 'account-menu-avatar-content' }, octicon('person')),
      h('span', { className: 'nav-label action-label' }, 'User')
    ),
    h('div', { className: 'account-menu-popover', 'aria-label': 'GitHub accounts' })
  );
}

/**
 * @param {HTMLElement} root
 * @param {AbortSignal} signal
 * @param {{ fetch?: typeof globalThis.fetch, location?: Location }} [dependencies]
 */
export function enableGitHubAccountMenu(root, signal, dependencies = {}) {
  if (document.querySelector('meta[name="dashboard-authentication"]')?.getAttribute('content') !== 'github') return;
  const menu = root.querySelector('.sidebar-account-menu');
  const content = menu?.querySelector('.account-menu-popover');
  const avatar = menu?.querySelector('.account-menu-avatar-content');
  if (!(menu instanceof HTMLDetailsElement) || !(content instanceof HTMLElement) || !(avatar instanceof HTMLElement)) return;

  const request = dependencies.fetch ?? globalThis.fetch.bind(globalThis);
  const location = dependencies.location ?? globalThis.location;
  const accountState = state(/** @type {GitHubAccountState | null} */ (null));
  const pending = state(false);
  const error = state('');

  /** @param {string} path @param {RequestInit} [init] */
  const updateAccount = async (path, init = {}) => {
    pending.set(true);
    error.set('');
    try {
      const response = await request(path, { ...init, cache: 'no-store', credentials: 'same-origin' });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error || `GitHub account request failed: ${response.status}`);
      accountState.set(payload);
      return payload;
    } catch (requestError) {
      error.set(requestError instanceof Error ? requestError.message : String(requestError));
      return null;
    } finally {
      pending.set(false);
    }
  };

  render(content, () => {
    const current = accountState.get();
    const isPending = pending.get();
    const message = error.get();
    if (!current) return h('span', { className: 'account-menu-status' }, isPending ? 'Loading account…' : message);
    return [
      h(
        'div',
        { className: 'account-menu-profile' },
        accountAvatar(current.active),
        h(
          'span',
          { className: 'account-menu-profile-text' },
          h('strong', null, current.active?.name || current.active?.login || 'GitHub user'),
          current.active?.name ? h('span', null, `@${current.active.login}`) : null
        )
      ),
      h('div', { className: 'account-menu-accounts', role: 'list', 'aria-label': 'Signed in accounts' },
        ...(current.accounts ?? []).map((account) => h(
          'button',
          {
            className: 'account-menu-action',
            type: 'button',
            disabled: account.active || isPending,
            'aria-current': account.active ? 'true' : undefined,
            onclick: async () => {
              const updated = await updateAccount('/api/v1/auth/switch', {
                method: 'POST',
                body: JSON.stringify({ login: account.login }),
                headers: { 'Content-Type': 'application/json' }
              });
              if (updated) location.reload();
            }
          },
          accountAvatar(account),
          h('span', null, account.name || `@${account.login}`),
          account.active ? octicon('check') : null
        ))
      ),
      h('a', { className: 'account-menu-action', href: '/auth/login?select_account=1' }, octicon('person-add'), h('span', null, 'Add another account')),
      h(
        'button',
        {
          className: 'account-menu-action account-menu-sign-out',
          type: 'button',
          disabled: isPending,
          onclick: async () => {
            const updated = await updateAccount('/auth/logout', { method: 'POST' });
            if (updated?.authenticated) location.reload();
            else location.assign('/auth/login');
          }
        },
        octicon('sign-out'),
        h('span', null, 'Sign out')
      ),
      message ? h('p', { className: 'account-menu-error', role: 'alert' }, message) : null
    ];
  }, { signal });

  void updateAccount('/api/v1/auth/session').then((current) => {
    if (!current?.authenticated) return;
    menu.hidden = false;
    avatar.replaceChildren(accountAvatar(current.active));
  });
}

/** @param {GitHubAccount | undefined} account */
function accountAvatar(account) {
  if (account?.avatarUrl) {
    return h('img', {
      className: 'account-menu-avatar-image',
      src: account.avatarUrl,
      alt: '',
      width: 20,
      height: 20,
      referrerPolicy: 'no-referrer'
    });
  }
  return octicon('person');
}
