/**
 * Shared package activity shell for declarative package-page compositions.
 */

import { h } from '../dom.js';
import { titleCase } from './count-formatters.js';
import { renderInteractiveTabs, updateInteractiveTabSelection } from './tab-nav.js';

const MODES = ['all', 'review', 'live'];

/**
 * @typedef {'all'|'review'|'live'} PackageActivityMode
 */

/**
 * @param {{
 *   pageId: string,
 *   sections: readonly { id: string, render: (mode: PackageActivityMode) => HTMLElement }[],
 *   defaultMode?: string
 * }} options
 * @returns {HTMLElement}
 */
export function renderPackagesModeShell(options) {
  const requestedMode = new URLSearchParams(globalThis.window?.location.search ?? '').get('mode');
  let selectedMode = isPackageActivityMode(requestedMode)
    ? requestedMode
    : isPackageActivityMode(options.defaultMode)
      ? options.defaultMode
      : 'all';
  const panelId = `${options.pageId}-mode-panel`;
  const content = h('div', { className: 'packages-mode-content', id: panelId, role: 'tabpanel' });
  const tabs = renderInteractiveTabs({
    className: 'package-mode-tabs',
    ariaLabel: 'Filter package activity by mode',
    panelId,
    onSelect: selectMode,
    tabs: MODES.map((mode) => ({
      label: titleCase(mode),
      value: mode,
      selected: mode === selectedMode,
      dataset: { packageMode: mode }
    }))
  });

  /**
   * @param {string} mode
   * @param {boolean} [focus]
   */
  function selectMode(mode, focus = false) {
    if (!isPackageActivityMode(mode)) return;
    if (mode !== selectedMode) {
      selectedMode = mode;
      renderMode();
    }
    if (focus) {
      /** @type {HTMLButtonElement | null} */
      const activeTab = tabs.querySelector(`[role="tab"][data-tab-value="${mode}"]`);
      activeTab?.focus();
    }
  }

  function renderMode() {
    updateInteractiveTabSelection(tabs, selectedMode);
    content.setAttribute('aria-labelledby', `${options.pageId}-${selectedMode}-tab`);
    content.replaceChildren(...options.sections.map((section) => section.render(selectedMode)));
    content.dispatchEvent(new CustomEvent('package-mode-change', {
      bubbles: true,
      detail: { pageId: options.pageId, mode: selectedMode }
    }));
  }

  renderMode();
  return h('div', { className: 'packages-view' }, tabs, content);
}

/**
 * @param {unknown} value
 * @returns {value is PackageActivityMode}
 */
export function isPackageActivityMode(value) {
  return typeof value === 'string' && MODES.includes(/** @type {PackageActivityMode} */ (value));
}
