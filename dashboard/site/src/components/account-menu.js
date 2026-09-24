import { h } from '../dom.js';
import { octicon } from '../octicons.js';
import { enableDetailsMenuDismissal } from './ui-primitives.js';

function usesGitHubAuthentication() {
  return document.querySelector('meta[name="cao-auth-mode"]')?.getAttribute('content') === 'github';
}

/**
 * @param {HTMLDetailsElement} menu
 * @param {HTMLElement} loginLabel
 */
async function loadAccount(menu, loginLabel) {
  const response = await fetch('/api/auth/session', { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error('GitHub account session is unavailable');
  const account = await response.json();
  if (typeof account.login !== 'string' || account.login.length === 0) {
    throw new Error('GitHub account session has no login');
  }
  loginLabel.textContent = `@${account.login}`;
  menu.hidden = false;
}

/** @param {HTMLButtonElement} button */
async function switchAccount(button) {
  button.disabled = true;
  try {
    const response = await fetch('/auth/switch-account', {
      method: 'POST',
      headers: { Accept: 'application/json' }
    });
    if (!response.ok) throw new Error('Unable to switch GitHub account');
    const result = await response.json();
    if (typeof result.loginUrl !== 'string' || !result.loginUrl.startsWith('/auth/login?')) {
      throw new Error('GitHub account selection URL is unavailable');
    }
    return result.loginUrl;
  } finally {
    button.disabled = false;
  }
}

/** @param {HTMLButtonElement} button */
async function logout(button) {
  button.disabled = true;
  try {
    const response = await fetch('/auth/logout', {
      method: 'POST',
      headers: { Accept: 'application/json' }
    });
    if (!response.ok) throw new Error('Unable to log out');
  } finally {
    button.disabled = false;
  }
}

/**
 * Renders the hosted dashboard's active GitHub identity and user actions.
 * Static and local-capability deployments do not render this control.
 * @param {{ navigate?: (url: string) => void }} [options]
 * @returns {HTMLElement | null}
 */
export function renderAccountMenu(options = {}) {
  if (!usesGitHubAuthentication()) return null;
  const navigate = options.navigate ?? ((url) => window.location.assign(url));

  const loginLabel = h('strong', null, 'GitHub account');
  const switchButton = /** @type {HTMLButtonElement} */ (h(
    'button',
    { className: 'account-menu-action', type: 'button', 'data-switch-account': '' },
    octicon('people'),
    'Use another GitHub account'
  ));
  const logoutButton = /** @type {HTMLButtonElement} */ (h(
    'button',
    { className: 'account-menu-action', type: 'button', 'data-logout': '' },
    octicon('sign-out'),
    'Log out'
  ));
  const menu = /** @type {HTMLDetailsElement} */ (h(
    'details',
    { className: 'account-menu', hidden: true },
    h(
      'summary',
      {
        className: 'account-menu-avatar',
        'aria-label': 'Open user view',
        title: 'User'
      },
      octicon('person'),
      h('span', { className: 'sr-only action-label' }, 'GitHub account')
    ),
    h(
      'div',
      { className: 'account-menu-popover', role: 'dialog', 'aria-label': 'User' },
      h('span', { className: 'account-menu-heading' }, 'Account'),
      loginLabel,
      switchButton,
      logoutButton
    )
  ));

  switchButton.addEventListener('click', () => {
    void switchAccount(switchButton).then((result) => {
      navigate(result);
    }).catch((error) => {
      menu.dataset.error = String(error?.message ?? error);
    });
  });
  logoutButton.addEventListener('click', () => {
    void logout(logoutButton).then(() => {
      navigate('/auth/logged-out');
    }).catch((error) => {
      menu.dataset.error = String(error?.message ?? error);
    });
  });
  queueMicrotask(() => {
    if (document.body) enableDetailsMenuDismissal(document.body, menu, '.account-menu-action');
    void loadAccount(menu, loginLabel).catch((error) => {
      menu.dataset.error = String(error?.message ?? error);
    });
  });
  return menu;
}
