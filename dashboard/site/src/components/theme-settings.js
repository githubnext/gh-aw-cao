import { h } from '../dom.js';
import { octicon } from '../octicons.js';
import { scopedStorageKey } from '../storage-scope.js';
import { createDebug } from '../debug.js';
import { effect, state } from '../reactive.js';
import { createFactoryScope } from './factory-elements.js';
import { enableDetailsMenuDismissal, renderActionLabel } from './ui-primitives.js';

const THEME_STORAGE_KEY = scopedStorageKey('central-agentic-ops.dashboard.theme');
const debugTheme = createDebug('theme-settings');

/** @typedef {'system'|'light'|'dark'} DashboardTheme */

/** @returns {DashboardTheme} */
function savedTheme() {
  let theme = /** @type {DashboardTheme} */ ('system');
  let fallback = true;
  try {
    const stored = globalThis.window?.localStorage?.getItem(THEME_STORAGE_KEY);
    if (stored === 'system' || stored === 'light' || stored === 'dark') {
      theme = stored;
      fallback = false;
    }
  } catch {
    // The system theme remains available when storage is unavailable.
  }
  debugTheme({ event: 'restored', theme, fallback });
  return theme;
}

/** @param {HTMLElement} root @param {DashboardTheme} theme */
function applyTheme(root, theme) {
  if (theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = theme;
}

/** @param {HTMLElement} root */
export function restoreDashboardTheme(root) {
  applyTheme(root, savedTheme());
}

/** @param {HTMLElement} root @param {HTMLElement} control */
export function enableThemeControl(root, control) {
  if (control instanceof HTMLDetailsElement) {
    enableDetailsMenuDismissal(root, control, '[data-theme-value]');
  }
}

export function renderThemeControl() {
  const scope = createFactoryScope();
  const theme = state(savedTheme());
  /** @type {HTMLButtonElement[]} */
  const buttons = [];
  /** @param {DashboardTheme} nextTheme */
  const persistTheme = (nextTheme) => {
    try {
      globalThis.window?.localStorage?.setItem(THEME_STORAGE_KEY, nextTheme);
      debugTheme({ event: 'changed', theme: nextTheme, persisted: true });
    } catch (error) {
      // The theme still applies for the current page when storage is unavailable.
      debugTheme({ event: 'changed', theme: nextTheme, persisted: false, errorName: error instanceof Error ? error.name : 'unknown' });
    }
  };
  for (const [value, label, icon] of /** @type {const} */ ([
    ['system', 'System', 'device-desktop'],
    ['light', 'Light', 'sun'],
    ['dark', 'Dark', 'moon']
  ])) {
    buttons.push(/** @type {HTMLButtonElement} */ (h('button', {
      type: 'button',
      dataset: { themeValue: value },
      onClick: () => {
        persistTheme(value);
        theme.set(value);
      }
    }, octicon(icon), h('span', null, label))));
  }
  effect(() => {
    const current = theme.get();
    const root = buttons[0]?.closest('.dashboard-root');
    if (root instanceof HTMLElement) applyTheme(root, current);
    for (const button of buttons) {
      button.setAttribute('aria-pressed', String(button.dataset.themeValue === current));
    }
  }, { signal: scope.signal });
  const root = h('details', { className: 'theme-control' },
    h('summary', { 'aria-label': 'Appearance', title: 'Appearance' },
      octicon('sun'),
      renderActionLabel('Appearance')
    ),
    h('div', { className: 'theme-control-popover', 'aria-labelledby': 'dashboard-appearance-heading' },
      h('div', { className: 'theme-control-heading' },
        h('strong', { id: 'dashboard-appearance-heading' }, 'Appearance'),
        h('span', null, 'Choose how this dashboard looks.')
      ),
      h('div', { className: 'theme-control-options' }, buttons)
    )
  );
  scope.bind(root);
  return root;
}
