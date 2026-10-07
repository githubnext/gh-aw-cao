import { csrfHeaders, ensureCsrfToken, usesGitHubAuthentication } from '../auth.js';
import { h } from '../dom.js';
import { createDebug } from '../debug.js';
import { updateRateLimitNotification } from '../rate-limit-notification.js';
import { octicon } from '../octicons.js';
import { batch, effect, state } from '../reactive.js';
import { createFactoryScope } from './factory-elements.js';
import { enableDetailsMenuDismissal, renderActionLabel } from './ui-primitives.js';
import { actionPresentation, normalizeAction } from '../action-model.js';

const debugAuth = createDebug('auth');

/**
 * @param {(event: string) => void} debug
 * @returns {Promise<{ login: string, avatarUrl: string | null }>} the logged-in account
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
  updateRateLimitNotification('/api/auth/session', response.status);
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
  let avatarUrl = null;
  if (typeof account.avatarUrl === 'string' && account.avatarUrl.length > 0) {
    try {
      const parsedAvatarUrl = new URL(account.avatarUrl);
      if (parsedAvatarUrl.protocol === 'https:' || parsedAvatarUrl.protocol === 'http:') {
        avatarUrl = parsedAvatarUrl.href;
      }
    } catch {
      avatarUrl = null;
    }
  }
  debug('session.available');
  return { login: account.login, avatarUrl };
}

/**
 * @param {import('../reactive.js').State<boolean>} busy
 * @param {(event: string) => void} debug
 */
async function switchAccount(busy, debug) {
  busy.set(true);
  debug('switch.request_started');
  try {
    let response;
    try {
      await ensureCsrfToken();
      response = await fetch('/auth/switch-account', {
        method: 'POST',
        headers: csrfHeaders({ Accept: 'application/json' })
      });
      updateRateLimitNotification('/auth/switch-account', response.status);
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
    busy.set(false);
  }
}

/**
 * @param {import('../reactive.js').State<boolean>} busy
 * @param {(event: string) => void} debug
 */
async function logout(busy, debug) {
  busy.set(true);
  debug('logout.request_started');
  try {
    let response;
    try {
      await ensureCsrfToken();
      response = await fetch('/auth/logout', {
        method: 'POST',
        headers: csrfHeaders({ Accept: 'application/json' })
      });
      updateRateLimitNotification('/auth/logout', response.status);
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
    busy.set(false);
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

  const login = state(/** @type {string | null} */ (null));
  const avatarUrl = state(/** @type {string | null} */ (null));
  const avatarLoaded = state(false);
  const errorMessage = state(/** @type {string | null} */ (null));
  // `switchBusy`/`logoutBusy` are each action button's entire visible run
  // state; the effect below is the only place that writes them onto the
  // owned button nodes, matching the `reset-dashboard-control.js` and
  // `createCopyControl` state/effect/createFactoryScope shape.
  const switchBusy = state(false);
  const logoutBusy = state(false);
  const switchAction = normalizeAction({
    level: 'ui', verb: 'switch-account', label: 'Use another GitHub account'
  }, { id: 'switch-account', type: 'ui' });
  const logoutAction = normalizeAction({
    level: 'ui', verb: 'logout', label: 'Log out'
  }, { id: 'logout', type: 'ui' });
  const switchPresentation = actionPresentation(switchAction);
  const logoutPresentation = actionPresentation(logoutAction);

  const loginLabel = h('strong', null, 'GitHub account');
  const avatarFallback = h('span', { className: 'account-menu-avatar-fallback' }, octicon('person'));
  const avatarImage = /** @type {HTMLImageElement} */ (h('img', {
    className: 'account-menu-avatar-image',
    alt: '',
    hidden: true,
    referrerPolicy: 'no-referrer'
  }));
  const switchButton = /** @type {HTMLButtonElement} */ (h(
    'button',
    { className: 'account-menu-action', type: 'button', 'data-switch-account': '', 'data-action-level': switchAction.level },
    octicon(switchPresentation.icon),
    switchPresentation.label
  ));
  const logoutButton = /** @type {HTMLButtonElement} */ (h(
    'button',
    { className: 'account-menu-action', type: 'button', 'data-logout': '', 'data-action-level': logoutAction.level },
    octicon(logoutPresentation.icon),
    logoutPresentation.label
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
      avatarFallback,
      avatarImage,
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
    const currentAvatarUrl = avatarUrl.get();
    const currentAvatarLoaded = avatarLoaded.get();
    loginLabel.textContent = currentLogin ? `@${currentLogin}` : 'GitHub account';
    menu.hidden = currentLogin === null;
    const summary = menu.querySelector('summary');
    if (summary instanceof HTMLElement) {
      summary.setAttribute('aria-label', currentLogin ? `Open user view for @${currentLogin}` : 'Open user view');
      summary.title = currentLogin ? `@${currentLogin}` : 'User';
    }
    if (currentAvatarUrl) {
      if (avatarImage.getAttribute('src') !== currentAvatarUrl) avatarImage.src = currentAvatarUrl;
    } else {
      avatarImage.removeAttribute('src');
    }
    avatarImage.hidden = !currentAvatarUrl || !currentAvatarLoaded;
    avatarFallback.hidden = currentAvatarLoaded;
    switchButton.disabled = switchBusy.get();
    logoutButton.disabled = logoutBusy.get();
    const currentError = errorMessage.get();
    if (currentError) menu.dataset.error = currentError;
    else delete menu.dataset.error;
  }, { signal: scope.signal });

  avatarImage.addEventListener('load', () => avatarLoaded.set(true), { signal: scope.signal });
  avatarImage.addEventListener('error', () => avatarLoaded.set(false), { signal: scope.signal });
  switchButton.addEventListener('click', () => {
    void switchAccount(switchBusy, debug).then((result) => {
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
    void logout(logoutBusy, debug).then(() => {
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
    void loadAccount(debug).then((account) => {
      batch(() => {
        avatarLoaded.set(false);
        avatarUrl.set(account.avatarUrl);
        login.set(account.login);
      });
    }).catch(() => {
      debug('session.unavailable');
      errorMessage.set('GitHub account session is unavailable');
    });
  });
  scope.bind(menu);
  return menu;
}
