import { csrfHeaders, usesGitHubAuthentication } from '../auth.js';
import { h } from '../dom.js';
import { createDebug } from '../debug.js';
import { octicon } from '../octicons.js';
import { effect, state } from '../reactive.js';
import { createFactoryScope } from './factory-elements.js';
import { enableDetailsMenuDismissal, renderActionLabel } from './ui-primitives.js';

const debugAuth = createDebug('auth');

/**
 * @param {(event: string) => void} debug
 * @returns {Promise<string>} the logged-in account's login
 */
async function loadAccount(debug) {
  debug('session.request_started');
  let response;
  try {
    response = await fetch('/api/auth/session', { headers: { Accept: 'application/json' } });
  } catch {
    debug('session.request_failed');
    throw new Error('GitHub account session is unavailable');
  }
  if (!response.ok) {
    debug('session.response_rejected');
    throw new Error('GitHub account session is unavailable');
  }
  let account;
  try {
    account = await response.json();
  } catch {
    debug('session.payload_decode_failed');
    throw new Error('GitHub account session is unavailable');
  }
  if (!account || typeof account !== 'object' ||
      typeof account.login !== 'string' || account.login.length === 0) {
    debug('session.payload_invalid');
    throw new Error('GitHub account session has no login');
  }
  debug('session.available');
  return account.login;
}

/**
 * @param {HTMLButtonElement} button
 * @param {(event: string) => void} debug
 */
async function switchAccount(button, debug) {
  button.disabled = true;
  debug('switch.request_started');
  try {
    let response;
    try {
      response = await fetch('/auth/switch-account', {
        method: 'POST',
        headers: csrfHeaders({ Accept: 'application/json' })
      });
    } catch {
      debug('switch.request_failed');
      throw new Error('Unable to switch GitHub account');
    }
    if (!response.ok) {
      debug('switch.response_rejected');
      throw new Error('Unable to switch GitHub account');
    }
    let result;
    try {
      result = await response.json();
    } catch {
      debug('switch.payload_decode_failed');
      throw new Error('Unable to switch GitHub account');
    }
    if (!result || typeof result !== 'object' ||
        typeof result.loginUrl !== 'string' || !result.loginUrl.startsWith('/auth/login?')) {
      debug('switch.payload_invalid');
      throw new Error('GitHub account selection URL is unavailable');
    }
    debug('switch.succeeded');
    return result.loginUrl;
  } finally {
    button.disabled = false;
  }
}

/**
 * @param {HTMLButtonElement} button
 * @param {(event: string) => void} debug
 */
async function logout(button, debug) {
  button.disabled = true;
  debug('logout.request_started');
  try {
    let response;
    try {
      response = await fetch('/auth/logout', {
        method: 'POST',
        headers: csrfHeaders({ Accept: 'application/json' })
      });
    } catch {
      debug('logout.request_failed');
      throw new Error('Unable to log out');
    }
    if (!response.ok) {
      debug('logout.response_rejected');
      throw new Error('Unable to log out');
    }
    debug('logout.succeeded');
  } finally {
    button.disabled = false;
  }
}

/**
 * Renders the hosted dashboard's active GitHub identity and user actions.
 * Static and local-capability deployments do not render this control.
 * @param {{ navigate?: (url: string) => void, debug?: (event: string) => void }} [options]
 * @returns {HTMLElement | null}
 */
export function renderAccountMenu(options = {}) {
  const debug = options.debug ?? debugAuth;
  if (!usesGitHubAuthentication()) {
    debug('profile.not_hosted');
    return null;
  }
  debug('profile.hosted');
  const navigate = options.navigate ?? ((url) => window.location.assign(url));
  const scope = createFactoryScope();

  // `login` and `errorMessage` are the menu's entire visible state; the
  // effect below is the only place that writes them onto the owned DOM.
  const login = state(/** @type {string | null} */ (null));
  const errorMessage = state(/** @type {string | null} */ (null));

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
      renderActionLabel('GitHub account')
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

  effect(() => {
    const currentLogin = login.get();
    loginLabel.textContent = currentLogin ? `@${currentLogin}` : 'GitHub account';
    menu.hidden = currentLogin === null;
    const currentError = errorMessage.get();
    if (currentError) menu.dataset.error = currentError;
    else delete menu.dataset.error;
  }, { signal: scope.signal });

  switchButton.addEventListener('click', () => {
    void switchAccount(switchButton, debug).then((result) => {
      debug('switch.navigation_started');
      try {
        navigate(result);
      } catch {
        debug('switch.navigation_failed');
        throw new Error('Unable to switch GitHub account');
      }
    }).catch(() => {
      debug('switch.failed');
      errorMessage.set('Unable to switch GitHub account');
    });
  }, { signal: scope.signal });
  logoutButton.addEventListener('click', () => {
    void logout(logoutButton, debug).then(() => {
      debug('logout.navigation_started');
      try {
        navigate('/auth/logged-out');
      } catch {
        debug('logout.navigation_failed');
        throw new Error('Unable to log out');
      }
    }).catch(() => {
      debug('logout.failed');
      errorMessage.set('Unable to log out');
    });
  }, { signal: scope.signal });
  queueMicrotask(() => {
    if (document.body) enableDetailsMenuDismissal(document.body, menu, '.account-menu-action');
    void loadAccount(debug).then((accountLogin) => {
      login.set(accountLogin);
    }).catch(() => {
      debug('session.unavailable');
      errorMessage.set('GitHub account session is unavailable');
    });
  });
  scope.bind(menu);
  return menu;
}
