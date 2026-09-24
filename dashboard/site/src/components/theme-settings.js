import { h } from '../dom.js';
import { octicon } from '../octicons.js';
import { scopedStorageKey } from '../storage-scope.js';
import { enableDetailsMenuDismissal } from './ui-primitives.js';

const THEME_STORAGE_KEY = scopedStorageKey('central-agentic-ops.dashboard.theme');

/** @typedef {'system'|'light'|'dark'} DashboardTheme */

/** @returns {DashboardTheme} */
function savedTheme() {
  try {
    const theme = globalThis.window?.localStorage?.getItem(THEME_STORAGE_KEY);
    if (theme === 'system' || theme === 'light' || theme === 'dark') return theme;
  } catch {
    // The system theme remains available when storage is unavailable.
  }
  return 'system';
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
  /** @type {DashboardTheme} */
  let theme = savedTheme();
  /** @type {HTMLButtonElement[]} */
  const buttons = [];
  /** @param {DashboardTheme} nextTheme */
  const setTheme = (nextTheme) => {
    theme = nextTheme;
    const root = buttons[0]?.closest('.dashboard-root');
    if (root instanceof HTMLElement) applyTheme(root, theme);
    for (const button of buttons) {
      button.setAttribute('aria-pressed', String(button.dataset.themeValue === theme));
    }
    try {
      globalThis.window?.localStorage?.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // The theme still applies for the current page when storage is unavailable.
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
      'aria-pressed': String(theme === value),
      onClick: () => setTheme(value)
    }, octicon(icon), h('span', null, label))));
  }
  return h('details', { className: 'theme-control' },
    h('summary', { 'aria-label': 'Appearance', title: 'Appearance' },
      octicon('sun'),
      h('span', { className: 'sr-only action-label' }, 'Appearance')
    ),
    h('div', { className: 'theme-control-popover', 'aria-labelledby': 'dashboard-appearance-heading' },
      h('div', { className: 'theme-control-heading' },
        h('strong', { id: 'dashboard-appearance-heading' }, 'Appearance'),
        h('span', null, 'Choose how this dashboard looks.')
      ),
      h('div', { className: 'theme-control-options' }, buttons)
    )
  );
}
