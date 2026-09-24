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
    window.location.assign(result.loginUrl);
  } finally {
    button.disabled = false;
  }
}

/**
 * Renders the hosted dashboard's active GitHub identity and explicit account
 * chooser. Static and local-capability deployments do not render this control.
 * @returns {HTMLElement | null}
 */
export function renderAccountMenu() {
  if (!usesGitHubAuthentication()) return null;

  const loginLabel = h('strong', null, 'GitHub account');
  const switchButton = /** @type {HTMLButtonElement} */ (h(
    'button',
    { className: 'account-menu-action', type: 'button', 'data-switch-account': '' },
    octicon('people'),
    'Use another GitHub account'
  ));
  const menu = /** @type {HTMLDetailsElement} */ (h(
    'details',
    { className: 'account-menu', hidden: true },
    h(
      'summary',
      {
        className: 'account-menu-avatar',
        'aria-label': 'GitHub account',
        title: 'GitHub account'
      },
      octicon('person'),
      h('span', { className: 'sr-only action-label' }, 'GitHub account')
    ),
    h(
      'div',
      { className: 'account-menu-popover' },
      loginLabel,
      switchButton
    )
  ));

  switchButton.addEventListener('click', () => {
    void switchAccount(switchButton).catch((error) => {
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
