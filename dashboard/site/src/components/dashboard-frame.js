import { h } from '../dom.js';

/** @param {{ navigation: HTMLElement, header: HTMLElement, callouts: HTMLElement | null, pages: HTMLElement[], footer: HTMLElement }} options */
export function renderDashboardFrame({ navigation, header, callouts, pages, footer }) {
  return h(
    'div',
    { className: 'app-shell' },
    navigation,
    h(
      'div',
      { className: 'app-main' },
      header,
      callouts,
      h(
        'main',
        { id: 'main-content', className: 'dashboard-prototype', tabIndex: -1 },
        h('div', { className: 'report-body' }, h('div', { className: 'dashboard-pages' }, pages))
      ),
      footer
    )
  );
}