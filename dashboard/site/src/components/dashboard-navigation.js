import { h } from '../dom.js';
import { agenticWorkflowMark, octicon } from '../octicons.js';
import { scopedStorageKey } from '../storage-scope.js';
import { titleCase } from './count-formatters.js';
import { enableDetailsMenuDismissal } from './ui-primitives.js';

const SIDEBAR_COLLAPSED_STORAGE_KEY = scopedStorageKey('central-agentic-ops.dashboard.sidebar-collapsed');
const VIEW_MODE_LABELS = { chart: 'Chart', table: 'Table', card: 'Cards' };
const VIEW_MODE_ICONS = { chart: 'graph', table: 'table', card: 'stack' };

/**
 * @param {Array<Record<string, unknown>>} pages
 * @param {string} title
 * @param {Array<{ label?: string, pages?: string[], experimental?: boolean, placement?: string }> | undefined} navigation
 * @param {HTMLElement | null} accountControl
 */
export function renderDashboardNavigation(pages, title, navigation, accountControl = null) {
  const pagesById = new Map(pages.map((page) => [page.id, page]));
  const configuredSections = Array.isArray(navigation) && navigation.length > 0
    ? navigation
      .map((section) => ({
        label: section?.label,
        experimental: section?.experimental === true,
        placement: section?.placement === 'bottom' ? 'bottom' : 'top',
        pages: (Array.isArray(section?.pages) ? section.pages : [])
          .map((pageId) => pagesById.get(pageId))
          .filter((page) => page !== undefined)
      }))
      .filter((section) => section.pages.length > 0)
    : [{ label: undefined, experimental: false, placement: 'top', pages }];
  const experimentalPages = configuredSections
    .filter((section) => section.experimental)
    .flatMap((section) => section.pages);
  const standardSections = configuredSections.filter((section) => !section.experimental);
  const navigationSections = [
    ...standardSections.filter((section) => section.placement !== 'bottom'),
    ...(experimentalPages.length > 0
      ? [{ label: 'Experimental', experimental: true, placement: 'top', pages: experimentalPages }]
      : []),
    ...standardSections.filter((section) => section.placement === 'bottom')
  ];
  const firstPageId = navigationSections.find((section) => !section.experimental)?.pages[0]?.id ?? pages[0]?.id;
  const mainSectionIndex = Math.max(
    0,
    navigationSections.findIndex((section) => section.label?.toLowerCase() === 'main')
  );
  let navigationPageIndex = 0;

  return h(
    'aside',
    { className: 'org-sidebar', 'aria-label': 'Central Agentic Ops navigation', dataset: { defaultPageId: firstPageId ?? '' } },
    h(
      'div',
      { className: 'sidebar-header' },
      h(
        'button',
        {
          className: 'mobile-history-back',
          type: 'button',
          'aria-label': 'Go back',
          title: 'Go back',
          hidden: true
        },
        octicon('chevron-left', 'mobile-history-back-icon')
      ),
      h(
        'a',
        { className: 'sidebar-brand', href: firstPageId ? `#page-${firstPageId}` : '#main-content', title },
        agenticWorkflowMark(),
        h('span', null, title)
      ),
      h('div', { className: 'mobile-page-header' }, h('span', { className: 'mobile-brand-name' }, title)),
      h(
        'button',
        {
          className: 'mobile-view-mode-toggle',
          type: 'button',
          'aria-label': 'Change view',
          title: 'Change view',
          hidden: true
        },
        octicon('graph')
      ),
      h(
        'details',
        { className: 'mobile-nav-menu' },
        h('summary', { role: 'button', 'aria-label': 'Select view', title: 'Select view' }, octicon('three-bars')),
        h(
          'div',
          { className: 'mobile-nav-menu-list' },
          h('div', { className: 'mobile-nav-menu-actions', 'aria-label': 'Dashboard controls' }),
          ...navigationSections.flatMap((section) => [
            ...(typeof section.label === 'string' && section.label.length > 0
              ? [h('span', { className: 'mobile-nav-section-label' }, section.label)]
              : []),
            ...section.pages.map((page) => renderMobileNavItem(page, page.id === firstPageId))
          ])
        )
      ),
      h(
        'button',
        {
          className: 'sidebar-toggle',
          type: 'button',
          'aria-label': 'Collapse navigation',
          'aria-expanded': 'true',
          title: 'Collapse navigation'
        },
        octicon('sidebar-expand')
      )
    ),
    h(
      'nav',
      { className: 'primary-nav', 'aria-label': 'Primary' },
      ...navigationSections.flatMap((section, sectionIndex) => {
        const items = section.pages.map((page) => {
          const pageIndex = navigationPageIndex++;
          return renderNavItem(page, page.id === firstPageId, pageIndex >= 6, pageIndex >= 5);
        });
        return typeof section.label === 'string' && section.label.length > 0
          ? [h(
              'details',
              {
                className: `nav-section${section.placement === 'bottom' ? ' nav-section-bottom' : ''}`,
                open: section.placement === 'bottom' || sectionIndex === mainSectionIndex || ['investigate', 'insights'].includes(section.label?.toLowerCase() ?? '')
              },
              h(
                'summary',
                { className: 'nav-section-toggle', title: `${section.label} menu section` },
                h('span', { className: 'nav-section-label' }, section.label),
                octicon('chevron-right')
              ),
              h('div', { className: 'nav-section-items' }, ...items)
            )]
          : items;
      })
    ),
    accountControl ? h('div', { className: 'sidebar-account' }, accountControl) : null
  );
}

/** @param {HTMLElement} root */
export function enableDashboardNavigation(root) {
  enableSidebarToggle(root);
  enableMobileViewModeToggle(root);
  const menu = root.querySelector('.mobile-nav-menu');
  if (menu instanceof HTMLDetailsElement) {
    enableDetailsMenuDismissal(root, menu, '[data-mobile-nav-page-id]');
  }
}

/** @param {HTMLElement} root */
export function syncMobileViewModeToggle(root) {
  const toggle = root.querySelector('.mobile-view-mode-toggle');
  const activePage = root.querySelector('.dashboard-page:not([hidden])');
  const modeButtons = [...activePage?.querySelectorAll('[data-view-mode-value]') ?? []]
    .filter((button) => button instanceof HTMLButtonElement);
  if (!(toggle instanceof HTMLButtonElement) || modeButtons.length < 2) {
    if (toggle instanceof HTMLButtonElement) toggle.hidden = true;
    return;
  }

  const activeIndex = Math.max(0, modeButtons.findIndex((button) => button.getAttribute('aria-pressed') === 'true'));
  const activeMode = modeButtons[activeIndex]?.getAttribute('data-view-mode-value');
  if (activeMode !== 'chart' && activeMode !== 'table' && activeMode !== 'card') {
    toggle.hidden = true;
    return;
  }
  const nextMode = modeButtons[(activeIndex + 1) % modeButtons.length]?.getAttribute('data-view-mode-value');
  const nextLabel = nextMode === 'chart' || nextMode === 'table' || nextMode === 'card'
    ? VIEW_MODE_LABELS[nextMode]
    : 'next';
  toggle.hidden = false;
  toggle.dataset.viewMode = activeMode;
  toggle.setAttribute('aria-label', `Switch to ${nextLabel} view`);
  toggle.title = `Current view: ${VIEW_MODE_LABELS[activeMode]}. Switch to ${nextLabel}.`;
  toggle.replaceChildren(octicon(VIEW_MODE_ICONS[activeMode]));
}

/** @param {HTMLElement} root */
function enableMobileViewModeToggle(root) {
  const toggle = root.querySelector('.mobile-view-mode-toggle');
  if (!(toggle instanceof HTMLButtonElement)) return;
  toggle.addEventListener('click', () => {
    const activePage = root.querySelector('.dashboard-page:not([hidden])');
    const modeButtons = [...activePage?.querySelectorAll('[data-view-mode-value]') ?? []]
      .filter((button) => button instanceof HTMLButtonElement);
    if (modeButtons.length < 2) return;
    const activeIndex = Math.max(0, modeButtons.findIndex((button) => button.getAttribute('aria-pressed') === 'true'));
    modeButtons[(activeIndex + 1) % modeButtons.length]?.click();
    syncMobileViewModeToggle(root);
  });
}

/** @param {Record<string, unknown>} page */
function pageTitle(page) {
  return typeof page['navigation-label'] === 'string' && page['navigation-label'].length > 0
    ? page['navigation-label']
    : typeof page.title === 'string' && page.title.length > 0
      ? page.title
      : titleCase(String(page.id));
}

/** @param {Record<string, unknown>} page */
function pageIcon(page) {
  return typeof page.icon === 'string' ? page.icon : 'server';
}

/** @param {Record<string, unknown>} page @param {boolean} isActive @param {boolean} mobileOverflow @param {boolean} narrowMobileOverflow */
function renderNavItem(page, isActive, mobileOverflow, narrowMobileOverflow) {
  const title = pageTitle(page);
  return h(
    'a',
    {
      href: `#page-${page.id}`,
      className: `nav-item${isActive ? ' active' : ''}${mobileOverflow ? ' mobile-nav-overflow' : ''}${narrowMobileOverflow ? ' narrow-mobile-nav-overflow' : ''}`,
      'aria-current': isActive ? 'page' : undefined,
      'aria-label': title,
      title,
      'data-nav-page-id': page.id
    },
    octicon(pageIcon(page)),
    h('span', { className: 'nav-label' }, title)
  );
}

/** @param {Record<string, unknown>} page @param {boolean} isActive */
function renderMobileNavItem(page, isActive) {
  return h(
    'a',
    {
      href: `#page-${page.id}`,
      className: `mobile-nav-item${isActive ? ' active' : ''}`,
      'aria-current': isActive ? 'page' : undefined,
      'data-mobile-nav-page-id': page.id
    },
    octicon(pageIcon(page)),
    h('span', { className: 'mobile-nav-label' }, pageTitle(page))
  );
}

/** @param {HTMLElement} root */
function enableSidebarToggle(root) {
  const appShell = root.querySelector('.app-shell');
  const toggle = root.querySelector('.sidebar-toggle');
  if (!(appShell instanceof HTMLElement) || !(toggle instanceof HTMLButtonElement)) return;

  /** @param {boolean} collapsed */
  const setCollapsed = (collapsed) => {
    appShell.classList.toggle('sidebar-collapsed', collapsed);
    const label = collapsed ? 'Expand navigation' : 'Collapse navigation';
    toggle.setAttribute('aria-label', label);
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.setAttribute('title', label);
    toggle.replaceChildren(octicon(collapsed ? 'sidebar-collapse' : 'sidebar-expand'));
  };

  let collapsed = false;
  try {
    collapsed = globalThis.window?.localStorage?.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === 'true';
  } catch {
    // Storage can be unavailable in embedded or privacy-restricted contexts.
  }
  setCollapsed(collapsed);

  toggle.addEventListener('click', () => {
    collapsed = !collapsed;
    setCollapsed(collapsed);
    try {
      globalThis.window?.localStorage?.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, String(collapsed));
    } catch {
      // The display mode still works for the current page when storage is unavailable.
    }
  });
}