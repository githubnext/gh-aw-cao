import { h } from '../dom.js';
import { octicon } from '../octicons.js';

const THEME_STORAGE_KEY = 'central-agentic-ops.dashboard.theme';

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

export function renderThemeSettings() {
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
  return h('section', { className: 'configuration-browser-settings', 'aria-labelledby': 'configuration-appearance-heading' },
    h('div', { className: 'configuration-browser-settings-heading' },
      h('div', null,
        h('h3', { id: 'configuration-appearance-heading' }, 'Appearance'),
        h('p', null, 'Choose how this dashboard looks in this browser.')
      )
    ),
    h('div', { className: 'configuration-appearance-options' }, buttons)
  );
}
