/**
 * Presenter for JSON-driven dashboard pages using GitHub Primer styling and elements.
 */

import builtInDashboard from '../dashboard.json' with { type: 'json' };
import { h } from './dom.js';
import { getPrimerStyles } from './styles.js';
import { octicon, agenticWorkflowMark } from './octicons.js';
import { renderStatusBadge } from './components/badge.js';
import { renderDataStateMetrics } from './components/data-state.js';
import { formatMediumUtcDateTime, renderTooltip, renderEmptyMessage } from './components/ui-primitives.js';
import { customViewAvailabilityMessage, renderCustomViewStateDetails, renderLayoutSectionChrome, renderPageSection } from './components/view-chrome.js';
import { toNumber, stringOrFallback } from './view-formatters.js';
import { findLink } from './components/link-content.js';
import { elementHandlesEmptyRows, renderUiElement } from './components/ui-elements.js';
import { renderDataView } from './components/data-view.js';
import { renderFilterBar } from './components/filter-bar.js';
import { renderSiteCallouts } from './components/site-callout.js';
import { processRows } from './data-processor.js';
import { deriveOverviewSources } from './overview-data.js';
import { deriveRepositorySources } from './repository-data.js';
import { deriveRuntimeSources } from './runtime-data.js';
import { deriveWorkflowSources } from './workflow-data.js';
import { deriveDataHealthSources } from './data-health.js';
import { dashboardHorizonHours, formatDashboardHorizon, formatDashboardHorizonHours, resolveDashboardHorizon } from './horizon.js';

/**
 * @typedef {{ availability: 'available'|'empty'|'unavailable', completeness: 'complete'|'partial'|'unknown', freshness: 'fresh'|'stale'|'unknown' }} DataState
 */

/**
 * @typedef {{ 'source-id': string, 'source-kind': string, 'as-of': string, 'retrieved-at': string, 'coverage-start'?: string, 'coverage-end'?: string, completeness: DataState['completeness'], freshness: DataState['freshness'], availability?: DataState['availability'] }} SourceMetadata
 */

/**
 * @typedef {{ source: string, rows: Array<Record<string, unknown>>, metadata: SourceMetadata }} LogicalSourceInput
 */

/**
 * @typedef {{ id: string, title?: string, description?: string, layout: 'full'|'wide'|'narrow', views: string[], ['count-source']?: string, ['count-label']?: string }} PresentablePageSection
 */

/**
 * @typedef {{ id: string, kind: 'built-in', page: string, title?: string, ['navigation-label']?: string, description?: string, icon?: string, ['class-name']?: string, definition?: { views?: Array<unknown>, sections?: PresentablePageSection[], ['data-state']?: Record<string, boolean> } }} PresentableBuiltInPage
 */

/**
 * @typedef {{ id: string, kind: 'custom', title?: string, ['navigation-label']?: string, description?: string, icon?: string, ['class-name']?: string, route?: { ['hash-query-parameter']?: string, ['navigation-page']?: string }, views: unknown[], sections?: PresentablePageSection[] }} PresentableCustomPage
 */

/**
 * @typedef {{ field: string, aggregate?: string, as?: string, direction?: string, display?: string } & Record<string, unknown>} TableField
 */

/**
 * @typedef {{ label?: string, pages?: string[] }} PresentableNavigationSection
 */

/**
 * @typedef {{ id: string, title: string, description?: string, defaults?: Record<string, unknown>, units?: Record<string, { name: string, symbol: string, significant: number }>, callouts?: Array<{ id: string, title: string, description: string, icon?: string, ['visible-when']?: { source: string, field: string, equals: unknown } }>, pages: Array<PresentableBuiltInPage | PresentableCustomPage>, ['github-url-base']?: string, repository?: string, navigation?: PresentableNavigationSection[], horizon?: { label: string, tooltip: { label: string, description: string, icon?: string } } }} PresentableDashboard
 */

/**
 * @typedef {{ languageVersion: string, dashboard: PresentableDashboard }} PresentationDocument
 */

/**
 * @typedef {{ document: PresentationDocument, sources: Record<string, LogicalSourceInput> }} PresentationInput
 */

/**
 * @typedef {'organization-link'|'repository-link'|'workflow-link'|'issue-link'|'pull-request-link'|'run-link'|'evidence-link'|'external-link'} LinkFieldName
 */

const DEFAULT_GITHUB_URL_BASE = 'https://github.com';
const REFRESH_CONTROL_DESCRIPTION = 'Reload the dashboard to refresh cached data';
const REFRESH_WORKFLOW_DESCRIPTION = 'Open the dashboard workflow on GitHub Actions';
const SIDEBAR_COLLAPSED_STORAGE_KEY = 'central-agentic-ops.dashboard.sidebar-collapsed';

/**
 * @param {Document} document
 * @param {() => void} update
 */
export function updateWithViewTransition(document, update) {
  const transitionDocument = /** @type {Document & { startViewTransition?: (update: () => void) => unknown }} */ (document);
  const prefersReducedMotion = document.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches ?? false;
  if (typeof transitionDocument.startViewTransition !== 'function' || prefersReducedMotion) {
    update();
    return;
  }
  transitionDocument.startViewTransition(update);
}

/** @type {Record<string, PresentableCustomPage>} */
const BUILT_IN_PAGE_PAYLOADS = /** @type {Record<string, PresentableCustomPage>} */ (Object.fromEntries(
  builtInDashboard.dashboard.pages
    .filter((page) => page.kind === 'built-in')
    .map((page) => [
      page.page,
      {
        id: page.id,
        kind: 'custom',
        title: page.title,
        description: 'description' in page ? page.description : undefined,
        'class-name': 'class-name' in page ? page['class-name'] : undefined,
        views: page.definition?.views ?? [],
        sections: page.definition && 'sections' in page.definition ? page.definition.sections : undefined
      }
    ])
));

/**
 * @param {PresentableBuiltInPage} page
 * @returns {PresentableCustomPage}
 */
function getBuiltInPagePayload(page) {
  const payload = BUILT_IN_PAGE_PAYLOADS[page.page];
  return {
    ...payload,
    id: page.id,
    kind: 'custom',
    title: page.title ?? payload?.title,
    description: page.description ?? payload?.description,
    'class-name': page['class-name'] ?? payload?.['class-name'],
    views: payload?.views ?? [],
    sections: payload?.sections
  };
}

/**
 * @param {PresentationInput} input
 * @returns {HTMLElement}
 */
export function renderDashboard(input) {
  const { document, sources: rawSources } = input;
  const pages = document.dashboard.pages;
  const horizonRange = resolveDashboardHorizon(document.dashboard);
  const hasData = Object.values(rawSources).some((source) => Array.isArray(source?.rows) && source.rows.length > 0);
  const dataHorizon = resolveDataHorizon(rawSources);
  const githubUrlBase = typeof document.dashboard['github-url-base'] === 'string' && document.dashboard['github-url-base'].length > 0
    ? document.dashboard['github-url-base']
    : DEFAULT_GITHUB_URL_BASE;
  const dashboardRepository = typeof document.dashboard.repository === 'string' && document.dashboard.repository.length > 0
    ? document.dashboard.repository
    : null;
  const derivedSources = deriveWorkflowDashboardLinks(
    deriveRepositoryDashboardLinks(
      deriveRuntimeSources(deriveRepositorySources(deriveOverviewSources(deriveWorkflowSources(deriveEntityLinkSources(rawSources, githubUrlBase))))),
      pages
    ),
    pages
  );
  const dataHealthSources = deriveDataHealthSources(rawSources);
  const sources = {
    ...derivedSources,
    'data-health-summary': dataHealthSources['data-health-summary'],
    'data-health-sources': dataHealthSources['data-health-sources']
  };
  const orgName = inferOrganizationName(sources) || 'GitHub';
  const sidebarTitle = dashboardRepository?.split('/').at(-1) || orgName;
  const evaluatedAt = dataHorizon?.end ?? latestRetrievedAt(sources) ?? new Date().toISOString();
  const dashboardDefaults = resolveDashboardDefaults(document.dashboard.defaults, horizonRange, evaluatedAt);

  const styleEl = h('style', null, getPrimerStyles());
  const skipLink = h('a', { href: '#main-content', className: 'skip-link' }, 'Skip to main content');

  const sidebar = renderSidebar(pages, sidebarTitle, document.dashboard.navigation);
  const mainContent = renderMainContent(document, pages, sources, githubUrlBase, dashboardRepository, dashboardDefaults, horizonRange, evaluatedAt, hasData, dataHorizon, summarizeDataState(new Map(Object.entries(rawSources))));

  const appShell = h(
    'div',
    { className: 'app-shell' },
    sidebar,
    mainContent
  );
  const root = h(
    'div',
    { className: 'dashboard-root' },
    styleEl,
    skipLink,
    appShell
  );
  enableSidebarToggle(root);
  enableMobileNavigationMenu(root);
  enableDashboardPageNavigation(
    root,
    document.dashboard.title,
    (pageId) => {
      const page = pages.find((candidate) => candidate.id === pageId);
      return page
        ? renderPage(page, sources, isPlainObject(document.dashboard.units) ? document.dashboard.units : {}, dashboardDefaults)
        : null;
    }

  );
  return root;
}

/**
 * @param {Record<string, LogicalSourceInput>} sources
 * @returns {string | null}
 */
function inferOrganizationName(sources) {
  for (const source of Object.values(sources)) {
    if (Array.isArray(source?.rows)) {
      for (const row of source.rows) {
        if (typeof row?.organization === 'string' && row.organization.length > 0) {
          return row.organization;
        }
      }
    }
  }
  return null;
}

/**
 * @param {Array<PresentableBuiltInPage | PresentableCustomPage>} pages
 * @param {string} title
 * @param {PresentableNavigationSection[] | undefined} navigation
 * @returns {HTMLElement}
 */
function renderSidebar(pages, title, navigation) {
  const firstPageId = pages[0]?.id;
  const pagesById = new Map(pages.map((page) => [page.id, page]));
  const navigationSections = Array.isArray(navigation) && navigation.length > 0
    ? navigation
      .map((section) => ({
        label: section?.label,
        pages: (Array.isArray(section?.pages) ? section.pages : [])
          .map((pageId) => pagesById.get(pageId))
          .filter((page) => page !== undefined)
      }))
      .filter((section) => section.pages.length > 0)
    : [{ label: undefined, pages }];
  const mainSectionIndex = Math.max(
    0,
    navigationSections.findIndex((section) => section.label?.toLowerCase() === 'main')
  );
  let navigationPageIndex = 0;
  return h(
    'aside',
    { className: 'org-sidebar', 'aria-label': 'Central Agentic Ops navigation' },
    h(
      'div',
      { className: 'sidebar-header' },
      h(
        'a',
        { className: 'sidebar-brand', href: firstPageId ? `#page-${firstPageId}` : '#main-content', title },
        agenticWorkflowMark(),
        h('span', null, title)
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
        octicon('sidebar-collapse')
      )
    ),
    h(
      'nav',
      { className: 'primary-nav', 'aria-label': 'Primary' },
      ...navigationSections.flatMap((section, sectionIndex) => {
        const items = section.pages.map((page) => {
          const pageIndex = navigationPageIndex++;
          return renderNavItem(
            page,
            page.id === firstPageId,
            pageIndex >= 6,
            pageIndex >= 5
          );
        });
        return typeof section.label === 'string' && section.label.length > 0
          ? [h(
              'details',
              {
                className: 'nav-section',
                open: sectionIndex === mainSectionIndex || ['investigate', 'insights'].includes(section.label?.toLowerCase() ?? '')
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
      }),
      h(
        'details',
        { className: 'mobile-nav-menu' },
        h(
          'summary',
          { role: 'button', 'aria-label': 'Select view', title: 'Select view' },
          octicon('three-bars')
        ),
        h(
          'div',
          { className: 'mobile-nav-menu-list' },
          navigationSections.flatMap((section) => [
            ...(typeof section.label === 'string' && section.label.length > 0
              ? [h('span', { className: 'mobile-nav-section-label' }, section.label)]
              : []),
            ...section.pages.map((page) => renderMobileNavItem(page, page.id === firstPageId))
          ])
        )
      )
    )
  );
}

/**
 * @param {PresentableBuiltInPage | PresentableCustomPage} page
 * @param {boolean} isActive
 * @param {boolean} [mobileOverflow]
 * @param {boolean} [narrowMobileOverflow]
 * @returns {HTMLElement}
 */
function renderNavItem(page, isActive, mobileOverflow = false, narrowMobileOverflow = false) {
  const iconName = getPageIcon(page);
  const title = getPageNavigationTitle(page);

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
    octicon(iconName),
    h('span', { className: 'nav-label' }, title)
  );
}

/**
 * @param {PresentableBuiltInPage | PresentableCustomPage} page
 * @param {boolean} isActive
 * @returns {HTMLElement}
 */
function renderMobileNavItem(page, isActive) {
  const title = getPageNavigationTitle(page);
  return h(
    'a',
    {
      href: `#page-${page.id}`,
      className: `mobile-nav-item${isActive ? ' active' : ''}`,
      'aria-current': isActive ? 'page' : undefined,
      'data-mobile-nav-page-id': page.id
    },
    octicon(getPageIcon(page)),
    h('span', { className: 'mobile-nav-label' }, title)
  );
}

/**
 * @param {PresentableBuiltInPage | PresentableCustomPage} page
 * @returns {string}
 */
function getPageNavigationTitle(page) {
  return typeof page['navigation-label'] === 'string' && page['navigation-label'].length > 0
    ? page['navigation-label']
    : typeof page.title === 'string' && page.title.length > 0
      ? page.title
      : titleCase(page.id);
}

/**
 * Restores and persists the desktop sidebar display mode.
 * @param {HTMLElement} root
 */
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
    toggle.replaceChildren(octicon(collapsed ? 'sidebar-expand' : 'sidebar-collapse'));
  };

  let collapsed = false;
  try {
    collapsed = globalThis.localStorage?.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === 'true';
  } catch {
    // Storage can be unavailable in embedded or privacy-restricted contexts.
  }
  setCollapsed(collapsed);

  toggle.addEventListener('click', () => {
    collapsed = !collapsed;
    setCollapsed(collapsed);
    try {
      globalThis.localStorage?.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, String(collapsed));
    } catch {
      // The display mode still works for the current page when storage is unavailable.
    }
  });
}

/**
 * Closes the mobile view menu after selection or when focus moves elsewhere.
 * @param {HTMLElement} root
 */
function enableMobileNavigationMenu(root) {
  const menu = root.querySelector('.mobile-nav-menu');
  if (!(menu instanceof HTMLDetailsElement)) return;

  root.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return;
    if (event.target.closest('[data-mobile-nav-page-id]') || !event.target.closest('.mobile-nav-menu')) {
      menu.removeAttribute('open');
    }
  });
  menu.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    menu.removeAttribute('open');
    const summary = menu.querySelector('summary');
    if (summary instanceof HTMLElement) summary.focus();
  });
}

/**
 * @param {PresentableBuiltInPage | PresentableCustomPage} page
 * @returns {string}
 */
function getPageIcon(page) {
  return typeof page.icon === 'string' ? page.icon : 'server';
}

/**
 * @param {PresentationDocument} document
 * @param {Array<PresentableBuiltInPage | PresentableCustomPage>} pages
 * @param {Record<string, LogicalSourceInput>} sources
 * @param {string} githubUrlBase
 * @param {string | null} dashboardRepository
 * @param {Record<string, unknown>} dashboardDefaults
 * @param {string} horizonRange
 * @param {string} evaluatedAt
 * @param {boolean} hasData
 * @param {{ start: string, end: string, hours: number } | null} dataHorizon
 * @param {DataState} effectiveState
 * @returns {HTMLElement}
 */
function renderMainContent(document, pages, sources, githubUrlBase, dashboardRepository, dashboardDefaults, horizonRange, evaluatedAt, hasData, dataHorizon, effectiveState) {
  const initialPage = pages[0];
  const overviewPage = pages.find((page) => page.id === 'overview');
  const initialPageTitle = initialPage ? getPageTitle(initialPage) : '';
  const initialPageDescription = initialPage?.description;
  const initialPageHref = initialPage ? `#page-${encodeURIComponent(initialPage.id)}` : '#main-content';
  const overviewPageHref = overviewPage ? `#page-${encodeURIComponent(overviewPage.id)}` : initialPageHref;
  return h(
    'div',
    { className: 'app-main' },
    h(
      'nav',
      { className: 'top-nav breadcrumb', 'aria-label': 'Breadcrumb' },
      h(
        'div',
        { className: 'shell' },
        h('a', { hidden: true, 'data-breadcrumb-root': '' }),
        h('a', { href: overviewPageHref, 'data-breadcrumb-dashboard': '' }, 'Overview'),
        h('span', { 'data-breadcrumb-page': '' }, initialPageTitle),
        h(
          'div',
          { className: 'report-actions' },
          renderDashboardHorizon(document.dashboard, dashboardDefaults, horizonRange, evaluatedAt, hasData, dataHorizon, effectiveState),
          dashboardRepository
            ? h(
              'a',
              {
                className: 'refresh-button',
                href: `${githubUrlBase}/${dashboardRepository}/actions/workflows/dashboard.yml`,
                title: REFRESH_WORKFLOW_DESCRIPTION,
                'aria-label': REFRESH_WORKFLOW_DESCRIPTION
              },
              octicon('sync'),
              h('span', null, 'Refresh')
            )
            : h(
              'button',
              {
                type: 'button',
                className: 'refresh-button',
                title: REFRESH_CONTROL_DESCRIPTION,
                'aria-label': REFRESH_CONTROL_DESCRIPTION,
                onclick: () => window.location.reload()
              },
              octicon('sync'),
              h('span', null, 'Refresh')
            ),
          dashboardRepository
            ? h(
              'a',
              {
                className: 'repository-link',
                href: `${githubUrlBase}/${dashboardRepository}`,
                'aria-label': `View ${dashboardRepository} on GitHub`,
                title: `View ${dashboardRepository} on GitHub`
              },
              octicon('mark-github')
            )
            : null
        )
      )
    ),
    renderSiteCallouts(document.dashboard.callouts, sources),
    h(
      'main',
      { id: 'main-content', className: 'dashboard-prototype', tabIndex: -1 },
      h(
        'header',
        { className: 'overview-header', 'aria-labelledby': 'page-title' },
        h(
          'div',
          null,
          h(
            'div',
            { className: 'title-area' },
            h('h1', { id: 'page-title', tabIndex: -1 }, initialPageTitle),
            h('a', { className: 'title-link', 'data-page-title-link': '', hidden: true }),
            h('span', { className: 'mode-indicator', 'data-page-mode': '', hidden: true })
          ),
          h(
            'p',
            { className: 'lede', 'data-page-description': '', hidden: !initialPageDescription },
            initialPageDescription ?? ''
          )
        )
      ),
      h(
        'div',
        { className: 'report-body' },
        h(
          'div',
          { className: 'dashboard-pages' },
          pages.map((page) => renderPagePlaceholder(page))
        )
      )
    ),
    h(
      'footer',
      { className: 'report-footer' },
      'Generated deterministically from dashboard data.'
    )
  );
}

/**
 * @param {PresentableDashboard} dashboard
 * @param {Record<string, unknown>} dashboardDefaults
 * @param {string} horizonRange
 * @param {string} evaluatedAt
 * @param {boolean} hasData
 * @param {{ start: string, end: string, hours: number } | null} dataHorizon
 * @param {DataState} effectiveState
 * @returns {HTMLElement}
 */
function renderDashboardHorizon(dashboard, dashboardDefaults, horizonRange, evaluatedAt, hasData, dataHorizon, effectiveState) {
  if (!hasData) {
    return h(
      'span',
      { className: 'dashboard-horizon dashboard-horizon-skeleton', 'aria-label': 'Horizon unavailable' },
      h('span', { 'aria-hidden': 'true' })
    );
  }

  const horizon = dashboard.horizon;
  const label = horizon?.label || 'Horizon';
  const duration = dataHorizon
    ? formatDashboardHorizonHours(dataHorizon.hours)
    : formatDashboardHorizon(horizonRange);
  const start = dataHorizon?.start ?? (isPlainObject(dashboardDefaults.time) && typeof dashboardDefaults.time.start === 'string'
    ? dashboardDefaults.time.start
    : new Date(new Date(evaluatedAt).getTime() - dashboardHorizonHours(horizonRange) * 3_600_000).toISOString());
  const end = dataHorizon?.end ?? (isPlainObject(dashboardDefaults.time) && typeof dashboardDefaults.time.end === 'string'
    ? dashboardDefaults.time.end
    : evaluatedAt);
  const tooltipId = 'dashboard-horizon-details';

  return h(
    'div',
    { className: 'dashboard-horizon', 'data-dashboard-evaluated-at': evaluatedAt },
    h(
      'div',
      { className: 'horizon-summary' },
      h(
        'button',
        { type: 'button', className: 'horizon-toggle', 'aria-expanded': 'false' },
        `${label} ${duration}`
      ),
      h(
        'div',
        { className: 'horizon-data-status', role: 'group', 'aria-label': 'Data status' },
        h('span', null, h('span', { className: 'horizon-status-label' }, 'Completeness'), renderStatusBadge(effectiveState.completeness)),
        h('span', null, h('span', { className: 'horizon-status-label' }, 'Freshness'), renderStatusBadge(effectiveState.freshness))
      )
    ),
    horizon
      ? renderTooltip({
        id: tooltipId,
        label: horizon.tooltip.label,
        description: horizon.tooltip.description,
        icon: octicon(horizon.tooltip.icon || 'question'),
        content: h(
          'span',
          { className: 'horizon-tooltip-values' },
          h('span', null, h('strong', null, 'Start'), h('time', { dateTime: start }, `${formatReportDate(start)} UTC`)),
          h('span', null, h('strong', null, 'End'), h('time', { dateTime: end }, `${formatReportDate(end)} UTC`)),
          h('span', null, h('strong', null, 'Duration'), duration)
        )
      })
      : null
  );
}

/**
 * Resolves the shared coverage window across non-empty temporal sources. Sources
 * without valid coverage bounds are treated as timeless and do not constrain the window.
 * @param {Record<string, LogicalSourceInput>} sources
 * @returns {{ start: string, end: string, hours: number } | null}
 */
function resolveDataHorizon(sources) {
  const windows = Object.values(sources)
    .filter((source) => Array.isArray(source?.rows) && source.rows.length > 0)
    .map((source) => ({
      start: Date.parse(source.metadata?.['coverage-start'] ?? ''),
      end: Date.parse(source.metadata?.['coverage-end'] ?? '')
    }))
    .filter(({ start, end }) => Number.isFinite(start) && Number.isFinite(end) && end > start);
  if (windows.length === 0) return null;

  const start = Math.max(...windows.map((window) => window.start));
  const end = Math.min(...windows.map((window) => window.end));
  const hours = Math.ceil((end - start) / 3_600_000);
  return hours > 0
    ? { start: new Date(start).toISOString(), end: new Date(end).toISOString(), hours }
    : null;
}

/**
 * @param {Record<string, LogicalSourceInput>} sources
 * @returns {string | null}
 */
function latestRetrievedAt(sources) {
  return Object.values(sources)
    .map((source) => source?.metadata?.['retrieved-at'])
    .filter((value) => typeof value === 'string' && Number.isFinite(Date.parse(value)))
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null;
}

/**
 * @param {string} value
 * @returns {string}
 */
function formatReportDate(value) {
  return formatMediumUtcDateTime(new Date(value));
}

/**
 * @param {PresentableBuiltInPage | PresentableCustomPage} page
 * @returns {HTMLElement}
 */
function renderPagePlaceholder(page) {
  const payload = page.kind === 'built-in' ? getBuiltInPagePayload(page) : page;
  const pageClassName = typeof payload['class-name'] === 'string' && payload['class-name'].length > 0
    ? ` ${payload['class-name']}`
    : '';
  const routeParameter = typeof payload.route?.['hash-query-parameter'] === 'string'
    ? payload.route['hash-query-parameter']
    : undefined;
  const routeNavigationPage = typeof payload.route?.['navigation-page'] === 'string'
    ? payload.route['navigation-page']
    : undefined;
  return h('section', {
    className: `dashboard-page${pageClassName}`,
    id: `page-${page.id}`,
    'data-page-kind': 'custom',
    'data-page-name': page.id,
    'data-page-id': page.id,
    'data-page-title': getPageTitle(page),
    'data-page-description': payload.description ?? '',
    'data-route-parameter': routeParameter,
    'data-route-navigation-page': routeNavigationPage,
    'data-page-pending': ''
  });
}

/**
 * @returns {HTMLElement}
 */
function renderPageSkeleton() {
  return h(
    'div',
    {
      className: 'dashboard-view-skeleton',
      role: 'status',
      'aria-label': 'Loading view'
    },
    h('span', { className: 'sr-only' }, 'Loading view'),
    h('div', { className: 'skeleton-card', 'aria-hidden': 'true' }),
    h('div', { className: 'skeleton-card', 'aria-hidden': 'true' }),
    h('div', { className: 'skeleton-card', 'aria-hidden': 'true' }),
    h('div', { className: 'skeleton-panel', 'aria-hidden': 'true' })
  );
}

/**
 * @param {PresentableBuiltInPage | PresentableCustomPage} page
 * @param {Record<string, LogicalSourceInput>} sources
 * @param {Record<string, { name: string, symbol: string, significant: number }>} units
 * @param {Record<string, unknown>} dashboardDefaults
 * @returns {HTMLElement}
 */
function renderPage(page, sources, units, dashboardDefaults) {
  const title = getPageTitle(page);

  if (page.kind === 'built-in') {
    const payload = getBuiltInPagePayload(page);
    return renderCustomPage(payload, title, sources, units, dashboardDefaults);
  }

  return renderCustomPage(page, title, sources, units, dashboardDefaults);
}

/**
 * @param {PresentableCustomPage} page
 * @param {string} title
 * @param {Record<string, LogicalSourceInput>} sources
 * @param {Record<string, { name: string, symbol: string, significant: number }>} units
 * @param {Record<string, unknown>} dashboardDefaults
 * @param {boolean} [withFilterBar]
 * @returns {HTMLElement}
 */
function renderCustomPage(page, title, sources, units, dashboardDefaults, withFilterBar = true) {
  const views = Array.isArray(page.views)
    ? page.views.map((view) => applyDashboardDefaults(view, dashboardDefaults))
    : [];
  const sections = Array.isArray(page.sections) ? page.sections : [];
  const standaloneCalloutViewIds = new Set(sections.flatMap((section) => {
    if (!Array.isArray(section.views) || section.views.length !== 1) return [];
    const viewId = section.views[0];
    const view = views.find((candidate) => isPlainObject(candidate) && candidate.id === viewId);
    return isPlainObject(view) && view.mark === 'callout' ? [viewId] : [];
  }));
  const routeParameter = typeof page.route?.['hash-query-parameter'] === 'string'
    ? page.route['hash-query-parameter']
    : undefined;
  const routeNavigationPage = typeof page.route?.['navigation-page'] === 'string'
    ? page.route['navigation-page']
    : undefined;
  /** @type {Map<string, LogicalSourceInput>} */
  const pageSources = new Map();
  for (const view of views) {
    for (const sourceName of getViewSources(view)) {
      if (sources[sourceName]) {
        pageSources.set(sourceName, sources[sourceName]);
      }
    }
  }
  const renderedViews = views.map((view, index) => {
    const viewId = isPlainObject(view) && typeof view.id === 'string' ? view.id : '';
    const headingTag = sections.length > 0 && !standaloneCalloutViewIds.has(viewId) ? 'h4' : 'h3';
    const rendered = renderCustomView(page.id, view, index, sources, units, headingTag, routeParameter);
    const layout = isPlainObject(view) && typeof view.layout === 'string' ? view.layout : 'full';
    const disclosure = isPlainObject(view) && view.disclosure === 'supplemental' ? 'supplemental' : 'essential';
    rendered.classList.add('custom-view');
    rendered.setAttribute('data-view-layout', layout);
    rendered.setAttribute('data-disclosure', disclosure);
    if (disclosure === 'essential') {
      return rendered;
    }

    rendered.classList.remove('custom-view');
    rendered.removeAttribute('data-view-layout');
    return h(
      'details',
      {
        className: 'custom-view view-disclosure',
        'data-view-layout': layout,
        'data-disclosure': disclosure
      },
      h(
        'summary',
        { className: 'view-disclosure-summary' },
        h('span', null, getViewTitle(view, index)),
        h('span', { className: 'view-disclosure-hint' }, 'Show details')
      ),
      rendered
    );
  });
  const renderedViewsById = new Map(views.map((view, index) => [
    isPlainObject(view) && typeof view.id === 'string' ? view.id : `view-${index + 1}`,
    renderedViews[index]
  ]));
  const renderedContent = sections.length > 0
    ? h(
      'div',
      { className: 'page-layout-grid' },
      ...sections.map((section) => renderLayoutSection(page.id, section, renderedViewsById, sources))
    )
    : h('div', { className: 'custom-view-grid' }, ...renderedViews);
  const pageClassName = typeof page['class-name'] === 'string' && page['class-name'].length > 0
    ? ` ${page['class-name']}`
    : '';

  /** @type {HTMLElement} */
  let root;
  let filterRevision = 0;
  const filterBar = withFilterBar
    ? renderFilterBar((filters, timeWindow) => {
      const revision = ++filterRevision;
      const result = filterDashboardSources(
        sources,
        filters,
        page.id === 'readiness' ? undefined : timeWindow,
        page.id === 'readiness'
          ? new Set(['runs', 'findings', 'outcomes'])
          : new Set(pageSources.keys())
      );
      /** @param {Record<string, LogicalSourceInput>} filteredSources */
      const apply = (filteredSources) => {
        if (revision !== filterRevision) return;
        const pageFilteredSources = page.id === 'readiness'
          ? completedRunSources(filteredSources)
          : filteredSources;
        const effectiveSources = page.id === 'readiness'
          ? deriveOverviewSources(pageFilteredSources, { readinessWindow: timeWindow })
          : pageFilteredSources;
        const replacement = renderCustomPage(
          page,
          title,
          effectiveSources,
          units,
          dashboardDefaults,
          false
        );
        const detailsState = [...root.querySelectorAll('details')].map((details) => details.open);
        [...replacement.querySelectorAll('details')].forEach((details, index) => {
          if (detailsState[index] !== undefined) details.open = detailsState[index];
        });
        root.replaceChildren(...replacement.children);
        dispatchPageRoute(root, root.dataset.routeParameter ?? '', root.dataset.routeValue ?? '');
      };
      result.then(apply).catch(() => {});
    }, {
      defaultRange: isPlainObject(dashboardDefaults.time) && typeof dashboardDefaults.time.range === 'string'
        ? dashboardDefaults.time.range
        : '1w',
      referenceEnd: latestSourceCoverageEnd(page.id === 'readiness'
        ? [sources.runs, sources.findings, sources.outcomes]
        : [...pageSources.values()])
    })
    : null;
  root = h(
    'section',
    {
      className: `dashboard-page${pageClassName}`,
      id: `page-${page.id}`,
      'data-page-kind': 'custom',
      'data-page-name': page.id,
      'data-page-id': page.id,
      'data-page-title': title,
      'data-page-description': page.description ?? '',
      'data-route-parameter': routeParameter,
      'data-route-navigation-page': routeNavigationPage
    },
    filterBar,
    ...(renderedViews.length > 0
      ? [renderHiddenDataStateMetrics(summarizeDataState(pageSources)), renderedContent]
      : [h('p', null, 'No custom views available.')])
  );
  return root;
}

/**
 * @param {Record<string, LogicalSourceInput>} sources
 * @returns {Record<string, LogicalSourceInput>}
 */
function completedRunSources(sources) {
  if (!Array.isArray(sources.runs?.rows)) return sources;
  return {
    ...sources,
    runs: {
      ...sources.runs,
      rows: sources.runs.rows.filter((row) => String(row['run-status']) === 'completed')
    }
  };
}

/**
 * @param {Record<string, LogicalSourceInput>} sources
 * @param {Map<string, string[]>} filters
 * @param {{ start: string, end: string } | undefined} [timeWindow]
 * @param {Set<string>} [timeSourceNames]
 * @returns {Promise<Record<string, LogicalSourceInput>>}
 */
async function filterDashboardSources(sources, filters, timeWindow, timeSourceNames) {
  const entries = await Promise.all(Object.entries(sources).map(async ([name, source]) => {
    if (!Array.isArray(source?.rows) || source.rows.length === 0) return [name, source];
    const predicates = [...filters].flatMap(([configuredField, values]) => {
      const field = configuredField === 'mode' ? 'rollout-mode' : configuredField;
      return source.rows.some((row) => Object.hasOwn(row, field))
        ? [{ field, in: values }]
        : [];
    });
    let rows = predicates.length === 0
      ? source.rows
      : await processRows(source.rows, [{ op: 'filter', predicates }]);
    if (timeWindow && timeSourceNames?.has(name)) {
      rows = rows.filter((row) => rowMatchesTime(row, timeWindow));
    }
    if (rows === source.rows) return [name, source];
    return [name, { ...source, rows }];
  }));
  return Object.fromEntries(entries);
}

/**
 * @param {Array<LogicalSourceInput | undefined>} sources
 * @returns {string | undefined}
 */
function latestSourceCoverageEnd(sources) {
  return sources
    .flatMap((source) => [source?.metadata?.['coverage-end'], source?.metadata?.['as-of'], source?.metadata?.['retrieved-at']])
    .filter((value) => typeof value === 'string' && Number.isFinite(Date.parse(value)))
    .map(String)
    .toSorted((left, right) => Date.parse(right) - Date.parse(left))[0];
}

/**
 * @param {PresentableBuiltInPage | PresentableCustomPage} page
 * @returns {string}
 */
function getPageTitle(page) {
  return typeof page.title === 'string' && page.title.length > 0
    ? page.title
    : titleCase(page.id);
}

/**
 * @param {DataState} effectiveState
 * @returns {HTMLElement}
 */
function renderHiddenDataStateMetrics(effectiveState) {
  const metrics = renderDataStateMetrics(effectiveState);
  metrics.hidden = true;
  return metrics;
}

/**
 * @param {string} pageId
 * @param {PresentablePageSection} section
 * @param {Map<string, HTMLElement>} renderedViews
 * @param {Record<string, LogicalSourceInput>} sources
 * @returns {HTMLElement}
 */
function renderLayoutSection(pageId, section, renderedViews, sources) {
  const headingId = `${pageId}-${section.id}-layout-heading`;
  const countSource = section['count-source'] ? sources[section['count-source']] : null;
  const count = Array.isArray(countSource?.rows) ? countSource.rows.length : null;
  const sectionViews = section.views.map((viewId) => renderedViews.get(viewId)
    ?? renderEmptyMessage(`View unavailable: ${viewId}`, { 'data-missing-view-id': viewId }));
  if (sectionViews.length === 1 && sectionViews[0].classList.contains('dashboard-callout')) {
    sectionViews[0].setAttribute('data-section-id', section.id);
    sectionViews[0].setAttribute('data-section-layout', section.layout);
    return sectionViews[0];
  }
  return h(
    'section',
    {
      className: 'layout-section',
      'data-section-id': section.id,
      'data-section-layout': section.layout,
      'aria-labelledby': headingId
    },
    renderLayoutSectionChrome(pageId, section, count),
    h(
      'div',
      { className: 'custom-view-grid' },
      ...sectionViews
    )
  );
}

/**
 * Shows a single dashboard page and keeps sidebar state synchronized with the URL hash.
 * @param {HTMLElement} root
 * @param {string} dashboardTitle
 * @param {(pageId: string) => HTMLElement | null} [renderPageById]
 */
export function enableDashboardPageNavigation(root, dashboardTitle = '', renderPageById) {
  const pages = [...root.querySelectorAll('.dashboard-page')]
    .filter((page) => page instanceof HTMLElement);
  /** @type {Map<string, { details: boolean[], scrollTop: number }>} */
  const pageState = new Map();
  let activePageId = '';
  let activationRevision = 0;
  const overviewPage = pages.find((page) => page.dataset.pageId === 'overview');
  const links = [...root.querySelectorAll('[data-nav-page-id], [data-mobile-nav-page-id]')]
    .filter((link) => link instanceof HTMLAnchorElement);
  const breadcrumbPage = root.querySelector('[data-breadcrumb-page]');
  const breadcrumbRoot = root.querySelector('[data-breadcrumb-root]');
  const breadcrumbDashboard = root.querySelector('[data-breadcrumb-dashboard]');
  const pageTitle = root.querySelector('#page-title');
  const pageTitleLink = root.querySelector('[data-page-title-link]');
  const pageDescription = root.querySelector('.overview-header [data-page-description]');
  const pageMode = root.querySelector('[data-page-mode]');
  const reportActions = root.querySelector('.report-actions');
  const defaultBreadcrumbs = [breadcrumbRoot, breadcrumbDashboard].map((link) => ({
    label: link?.textContent ?? '',
    href: link instanceof HTMLAnchorElement ? link.getAttribute('href') ?? '' : '',
    hidden: link instanceof HTMLElement ? link.hidden : false
  }));
  if (pages.length === 0 || links.length === 0) {
    return;
  }

  root.addEventListener('dashboard-route-allocation', (event) => {
    if (!(event instanceof CustomEvent) || !(event.target instanceof Element)) return;
    const page = event.target.closest('.dashboard-page');
    if (!(page instanceof HTMLElement) || page.hidden) return;
    const title = typeof event.detail?.title === 'string' ? event.detail.title.trim() : '';
    const description = typeof event.detail?.description === 'string' ? event.detail.description.trim() : '';
    if (title) {
      if (breadcrumbPage) breadcrumbPage.textContent = title;
      if (pageTitle) pageTitle.textContent = title;
      updateDocumentTitle(root.ownerDocument, title, dashboardTitle);
    }
    renderPageTitleLink(pageTitleLink, event.detail?.titleLink);
    const hasAllocatedBreadcrumbs = Array.isArray(event.detail?.breadcrumbs);
    const breadcrumbs = hasAllocatedBreadcrumbs ? event.detail.breadcrumbs : [];
    for (const [index, link] of [breadcrumbRoot, breadcrumbDashboard].entries()) {
      const breadcrumb = breadcrumbs[index];
      if (!(link instanceof HTMLAnchorElement)) continue;
      if (!breadcrumb || typeof breadcrumb.label !== 'string' || typeof breadcrumb.href !== 'string' || !breadcrumb.href.startsWith('#page-')) {
        if (hasAllocatedBreadcrumbs) link.hidden = true;
        continue;
      }
      link.hidden = false;
      link.textContent = breadcrumb.label;
      link.href = breadcrumb.href;
    }
    if (pageDescription && description) {
      pageDescription.textContent = description;
      pageDescription.removeAttribute('hidden');
    }
    const mode = event.detail?.mode === 'review' || event.detail?.mode === 'live'
      ? event.detail.mode
      : '';
    renderPageMode(pageMode, mode);
    const navigationPage = typeof event.detail?.navigationPage === 'string'
      ? event.detail.navigationPage
      : '';
    if (navigationPage && availableIds.has(navigationPage)) {
      updateNavigationLinks(links, navigationPage);
    }
  });

  const availableIds = new Set(pages.map((page) => page.dataset.pageId));
  const routeFromHash = () => {
    const hash = root.ownerDocument.defaultView?.location.hash ?? '';
    if (!hash.startsWith('#page-')) return null;
    try {
      const route = hash.slice('#page-'.length);
      const queryIndex = route.indexOf('?');
      const pageId = decodeURIComponent(queryIndex === -1 ? route : route.slice(0, queryIndex));
      if (!availableIds.has(pageId)) return null;
      return {
        pageId,
        parameters: new URLSearchParams(queryIndex === -1 ? '' : route.slice(queryIndex + 1))
      };
    } catch {
      return null;
    }
  };
  /**
   * Defers expensive rendering until the lightweight title and skeleton update
   * has had an opportunity to paint.
   * @param {() => void} populate
   */
  const schedulePopulation = (populate) => {
    const view = root.ownerDocument.defaultView;
    if (typeof view?.requestAnimationFrame === 'function') {
      view.requestAnimationFrame(() => view.requestAnimationFrame(populate));
      return;
    }
    if (view) {
      view.setTimeout(populate, 0);
    } else {
      setTimeout(populate, 0);
    }
  };
  /**
   * @param {string} pageId
   * @param {URLSearchParams} [parameters]
   * @param {boolean} [deferPopulation]
   */
  const activate = (pageId, parameters = new URLSearchParams(), deferPopulation = false) => {
    const revision = ++activationRevision;
    const dashboardHorizon = root.querySelector('.dashboard-horizon');
    let activeFilterBar = root.querySelector('.report-actions > .filter-bar');
    /**
     * @param {HTMLElement | undefined} page
     */
    const placeDashboardHorizon = (page) => {
      const filterBar = page?.querySelector('.filter-bar');
      if (dashboardHorizon && filterBar && reportActions) {
        filterBar.prepend(dashboardHorizon);
        reportActions.prepend(filterBar);
        activeFilterBar = filterBar;
      } else if (dashboardHorizon && reportActions && !reportActions.contains(dashboardHorizon)) {
        reportActions.prepend(dashboardHorizon);
      }
    };
    /**
     * @param {HTMLElement | undefined} page
     */
    const restoreScroll = (page) => {
      const sectionId = parameters.get('section')?.trim();
      const section = sectionId ? root.ownerDocument.getElementById(sectionId) : null;
      if (section && page?.contains(section)) {
        section.scrollIntoView?.();
      } else if (pageState.has(pageId)) {
        const scrollTop = pageState.get(pageId)?.scrollTop ?? 0;
        const scrollingElement = root.ownerDocument.scrollingElement ?? root.ownerDocument.documentElement;
        scrollingElement.scrollTop = scrollTop;
      }
    };
    let populationDeferred = false;
    if (activePageId && activePageId !== pageId) {
      const activePage = pages.find((candidate) => candidate.dataset.pageId === activePageId);
      if (activePage) {
        if (dashboardHorizon && activeFilterBar?.contains(dashboardHorizon)) dashboardHorizon.remove();
        activeFilterBar?.remove();
        activeFilterBar = null;
        pageState.set(activePageId, {
          details: [...activePage.querySelectorAll('details')].map((details) => details.open),
          scrollTop: root.ownerDocument.scrollingElement?.scrollTop ?? root.ownerDocument.documentElement.scrollTop
        });
        activePage.replaceChildren();
        activePage.removeAttribute('aria-busy');
        activePage.setAttribute('data-page-pending', '');
      }
    }
    activePageId = pageId;
    const pageIndex = pages.findIndex((candidate) => candidate.dataset.pageId === pageId);
    const pendingPage = pages[pageIndex];
    if (pendingPage?.hasAttribute('data-page-pending')) {
      const populate = () => {
        if (revision !== activationRevision || activePageId !== pageId) return;
        const currentPage = pages[pageIndex];
        if (!currentPage?.hasAttribute('data-page-pending')) return;
        const renderedPage = renderPageById?.(pageId);
        if (!renderedPage) return;
        const detailsState = pageState.get(pageId)?.details ?? [];
        [...renderedPage.querySelectorAll('details')].forEach((details, index) => {
          if (detailsState[index] !== undefined) details.open = detailsState[index];
        });
        renderedPage.dataset.routeValue = currentPage.dataset.routeValue ?? '';
        currentPage.replaceWith(renderedPage);
        pages[pageIndex] = renderedPage;
        placeDashboardHorizon(renderedPage);
        if (deferPopulation) {
          dispatchPageRoute(renderedPage, renderedPage.dataset.routeParameter ?? '', renderedPage.dataset.routeValue);
          restoreScroll(renderedPage);
        }
      };
      if (deferPopulation) {
        populationDeferred = true;
        pendingPage.replaceChildren(renderPageSkeleton());
        pendingPage.setAttribute('aria-busy', 'true');
        schedulePopulation(populate);
      } else {
        populate();
      }
    }
    for (const [index, link] of [breadcrumbRoot, breadcrumbDashboard].entries()) {
      if (!(link instanceof HTMLAnchorElement)) continue;
      link.hidden = defaultBreadcrumbs[index].hidden;
      link.textContent = defaultBreadcrumbs[index].label;
      if (defaultBreadcrumbs[index].href) {
        link.setAttribute('href', defaultBreadcrumbs[index].href);
      } else {
        link.removeAttribute('href');
      }
    }
    for (const page of pages) {
      const isActive = page.dataset.pageId === pageId;
      page.hidden = !isActive;
    }
    if (breadcrumbDashboard instanceof HTMLAnchorElement && pageId === overviewPage?.dataset.pageId) {
      breadcrumbDashboard.hidden = true;
    }
    updateNavigationLinks(links, pageId);
    const page = pages.find((candidate) => candidate.dataset.pageId === pageId);
    placeDashboardHorizon(page);
    const routeNavigationPage = page?.dataset.routeNavigationPage;
    if (routeNavigationPage && availableIds.has(routeNavigationPage)) {
      const navigationLink = links.find((link) => getNavigationPageId(link) === routeNavigationPage);
      updateNavigationLinks(links, routeNavigationPage);
      if (breadcrumbRoot instanceof HTMLAnchorElement && navigationLink) {
        breadcrumbRoot.hidden = false;
        breadcrumbRoot.textContent = navigationLink.textContent ?? routeNavigationPage;
        breadcrumbRoot.href = `#page-${routeNavigationPage}`;
      }
      if (breadcrumbDashboard instanceof HTMLAnchorElement) breadcrumbDashboard.hidden = true;
    }
    const routeParameter = page?.dataset.routeParameter;
    const routeValue = routeParameter ? parameters.get(routeParameter)?.trim() ?? '' : '';
    if (page) page.dataset.routeValue = routeValue;
    const title = routeValue || page?.dataset.pageTitle || '';
    const description = page?.dataset.pageDescription ?? '';
    if (breadcrumbPage) breadcrumbPage.textContent = title;
    if (pageTitle) pageTitle.textContent = title;
    updateDocumentTitle(root.ownerDocument, title, dashboardTitle);
    renderPageTitleLink(pageTitleLink, null);
    if (pageDescription) {
      pageDescription.textContent = description;
      pageDescription.toggleAttribute('hidden', description.length === 0);
    }
    const requestedMode = pageId === 'packages'
      ? new URLSearchParams(root.ownerDocument.defaultView?.location.search ?? '').get('mode')
      : '';
    renderPageMode(pageMode, requestedMode === 'review' || requestedMode === 'live' ? requestedMode : '');
    if (page && !populationDeferred) dispatchPageRoute(page, routeParameter ?? '', routeValue);
    if (!populationDeferred) restoreScroll(page);

  };

  const initialRoute = routeFromHash();
  activate(initialRoute?.pageId ?? pages[0].dataset.pageId ?? '', initialRoute?.parameters);
  root.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return;
    const link = event.target.closest('[data-nav-page-id], [data-mobile-nav-page-id]');
    if (!(link instanceof HTMLAnchorElement)) return;
    event.preventDefault();
    const pageId = getNavigationPageId(link);
    if (!pageId || !availableIds.has(pageId)) return;
    root.ownerDocument.defaultView?.history.pushState(null, '', link.href);
    updateWithViewTransition(root.ownerDocument, () => activate(pageId, routeFromHash()?.parameters, true));
    if (pageTitle instanceof HTMLElement) pageTitle.focus();
  });

  const defaultView = root.ownerDocument.defaultView;
  const onHashChange = () => {
    if (!root.isConnected) {
      defaultView?.removeEventListener('hashchange', onHashChange);
      return;
    }
    const route = routeFromHash();
    if (route) {
      updateWithViewTransition(root.ownerDocument, () => activate(route.pageId, route.parameters, true));
      if (pageTitle instanceof HTMLElement) pageTitle.focus();
    }
  };
  defaultView?.addEventListener('hashchange', onHashChange);
}

/**
 * @param {HTMLElement} page
 * @param {string} parameter
 * @param {string} value
 */
function dispatchPageRoute(page, parameter, value) {
  for (const routeView of page.querySelectorAll('[data-route-view]')) {
    routeView.dispatchEvent(new CustomEvent('dashboard-route-change', {
      detail: { parameter, value }
    }));
  }
}

/**
 * @param {Document} ownerDocument
 * @param {string} pageTitle
 * @param {string} dashboardTitle
 */
function updateDocumentTitle(ownerDocument, pageTitle, dashboardTitle) {
  ownerDocument.title = [pageTitle, dashboardTitle]
    .map((part) => part.trim())
    .filter(Boolean)
    .join(' · ');
}

/**
 * @param {HTMLAnchorElement[]} links
 * @param {string} pageId
 */
function updateNavigationLinks(links, pageId) {
  for (const link of links) {
    const isActive = getNavigationPageId(link) === pageId;
    link.classList.toggle('active', isActive);
    if (isActive) {
      link.setAttribute('aria-current', 'page');
      const section = link.closest('.nav-section');
      if (section instanceof HTMLDetailsElement) section.open = true;
    }
    else link.removeAttribute('aria-current');
  }
}

/**
 * @param {HTMLAnchorElement} link
 * @returns {string}
 */
function getNavigationPageId(link) {
  return link.dataset.navPageId ?? link.dataset.mobileNavPageId ?? '';
}

/**
 * @param {Element | null} pageMode
 * @param {string} mode
 */
function renderPageMode(pageMode, mode) {
  if (!(pageMode instanceof HTMLElement)) return;
  pageMode.replaceChildren();
  pageMode.className = `mode-indicator${mode ? ` mode-${mode}` : ''}`;
  pageMode.hidden = !mode;
  if (mode) pageMode.append(octicon(mode === 'review' ? 'beaker' : 'rocket'), titleCase(mode));
}

/**
 * @param {unknown} view
 * @returns {string[]}
 */
function getViewSources(view) {
  if (!isPlainObject(view) || !isPlainObject(view.data)) {
    return [];
  }
  if (Array.isArray(view.data.sources)) {
    return view.data.sources.filter((source) => typeof source === 'string');
  }
  return typeof view.data.source === 'string' ? [view.data.source] : [];
}

/**
 * @param {Array<Record<string, unknown>>} rows
 * @returns {DataState['availability']}
 */
function inferAvailability(rows) {
  return rows.length > 0 ? 'available' : 'empty';
}

/**
 * @param {Map<string, LogicalSourceInput>} pageSources
 * @returns {DataState}
 */
function summarizeDataState(pageSources) {
  const sourceInputs = [...pageSources.values()];
  const metadata = sourceInputs.map((source) => source.metadata);
  const availabilities = sourceInputs.map((source) => source.metadata.availability ?? inferAvailability(source.rows));
  return {
    availability: availabilities.includes('unavailable')
      ? 'unavailable'
      : availabilities.length === 0 || availabilities.every((value) => value === 'empty')
        ? 'empty'
        : 'available',
    completeness: metadata.some((value) => value.completeness === 'partial')
      ? 'partial'
      : metadata.length > 0 && metadata.every((value) => value.completeness === 'complete')
        ? 'complete'
        : 'unknown',
    freshness: metadata.some((value) => value.freshness === 'stale')
      ? 'stale'
      : metadata.length > 0 && metadata.every((value) => value.freshness === 'fresh')
        ? 'fresh'
        : 'unknown'
  };
}

/**
 * @param {string} pageId
 * @param {unknown} view
 * @param {number} index
 * @param {Record<string, LogicalSourceInput>} sources
 * @param {Record<string, { name: string, symbol: string, significant: number }>} units
 * @param {'h3'|'h4'} [headingTag]
 * @param {string} [routeParameter]
 * @returns {HTMLElement}
 */
function renderCustomView(pageId, view, index, sources, units, headingTag = 'h3', routeParameter) {
  const fallbackTitle = `View ${index + 1}`;
  if (!isPlainObject(view)) {
    return renderCustomViewState(pageId, fallbackTitle, null, 'unavailable', ['Invalid custom view definition.'], headingTag);
  }

  const title = getViewTitle(view, index);

  if (
    routeParameter
    && isPlainObject(view.data)
    && typeof view.data['route-field'] === 'string'
    && view.mark !== 'element'
  ) {
    return renderRouteScopedDataView(pageId, view, index, sources, units, headingTag, routeParameter);
  }

  /** @type {string[]} */
  const contextDetails = [];

  if (view.mark === 'element') {
    return renderElementView(pageId, title, view, sources, contextDetails, headingTag, routeParameter);
  }
  if (view.mark === 'callout') {
    return renderCalloutView(pageId, view, title, headingTag);
  }

  const sourceName = getViewSources(view)[0] ?? null;
  if (!sourceName) {
    return renderCustomViewState(pageId, title, null, 'unavailable', ['Source unavailable.'], headingTag);
  }

  const sourceInput = sources[sourceName];
  if (!sourceInput || !Array.isArray(sourceInput.rows)) {
    return renderCustomViewState(pageId, title, sourceName, 'unavailable', [`Source unavailable: ${sourceName}`], headingTag);
  }

  const filteredRows = filterRowsForView(sourceInput.rows, view.data);
  const metadata = sourceInput.metadata;
  const state = sourceInput.metadata?.availability ?? inferAvailability(filteredRows);
  const emptyMessage = typeof view['empty-message'] === 'string' ? view['empty-message'] : undefined;

  if (state !== 'available' && !(state === 'empty' && view.mark === 'table')) {
    return renderCustomViewState(
      pageId,
      title,
      sourceName,
      state,
      contextDetails,
      headingTag,
      state === 'empty' ? emptyMessage : undefined
    );
  }

  if (filteredRows.length === 0 && view.mark !== 'table') {
    return renderCustomViewState(pageId, title, sourceName, 'empty', contextDetails, headingTag, emptyMessage);
  }

  const rendered = renderDataView(typeof view.mark === 'string' ? view.mark : '', {
    pageId,
    title,
    view,
    sourceName,
    rows: filteredRows,
    metadata,
    contextDetails,
    headingTag,
    units,
    prepareTableRows,
    buildChartPoints,
    prepareChartPoints,
    toText
  });
  if (rendered) return rendered;

  return renderCustomViewState(pageId, title, sourceName, 'unavailable', [...contextDetails, 'Unsupported view mark.'], headingTag);
}

/**
 * @param {string} pageId
 * @param {Record<string, unknown>} view
 * @param {string} title
 * @param {'h3'|'h4'} headingTag
 * @returns {HTMLElement}
 */
function renderCalloutView(pageId, view, title, headingTag) {
  const definition = isPlainObject(view.callout) ? view.callout : {};
  const viewId = typeof view.id === 'string' ? view.id : 'callout';
  const headingId = `${pageId}-${viewId}-callout-heading`;
  return h(
    'aside',
    { className: 'dashboard-callout', role: 'note', 'aria-labelledby': headingId },
    h(
      'div',
      { className: 'dashboard-callout-heading' },
      octicon(typeof definition.icon === 'string' ? definition.icon : 'info'),
      h(
        'div',
        null,
        h('span', { className: 'scope-kicker' }, typeof definition.label === 'string' ? definition.label : 'Note'),
        h(headingTag, { id: headingId }, title)
      )
    ),
    h('p', null, typeof view.description === 'string' ? view.description : '')
  );
}

/**
 * @param {string} pageId
 * @param {Record<string, any>} view
 * @param {number} index
 * @param {Record<string, LogicalSourceInput>} sources
 * @param {Record<string, { name: string, symbol: string, significant: number }>} units
 * @param {'h3'|'h4'} headingTag
 * @param {string} routeParameter
 */
function renderRouteScopedDataView(pageId, view, index, sources, units, headingTag, routeParameter) {
  const sourceName = typeof view.data?.source === 'string' ? view.data.source : '';
  const routeField = String(view.data?.['route-field'] ?? '');
  const root = h('div', { 'data-route-view': '', 'data-route-parameter': routeParameter });
  const data = { ...view.data };
  delete data['route-field'];
  const scopedView = { ...view, data };
  /** @param {unknown} routeValue */
  const render = (routeValue) => {
    const selected = typeof routeValue === 'string' ? routeValue.trim() : '';
    const source = sources[sourceName];
    const routeRows = source && Array.isArray(source.rows)
      ? source.rows.filter((row) => (
          selected.length > 0
          && String(row[routeField] ?? '').toLowerCase() === selected.toLowerCase()
        ))
      : [];
    if (view.chart === 'swimlane' && selected.length > 0) {
      const workflowExists = Array.isArray(sources.workflows?.rows) && sources.workflows.rows.some((row) => {
        const repositoryName = String(row.repository ?? '').trim();
        const repository = repositoryName.includes('/') || !String(row.organization ?? '').trim()
          ? repositoryName
          : `${String(row.organization).trim()}/${repositoryName}`;
        return `${repository}:${String(row.workflow ?? '').trim()}`.toLowerCase() === selected.toLowerCase();
      });
      if (!workflowExists) {
        root.replaceChildren(renderSwimlaneRouteState(
          pageId,
          getViewTitle(view, index),
          'Workflow not found',
          'The selected workflow could not be resolved for this repository/ref.',
          headingTag
        ));
        return;
      }
      const dataWithoutFilters = { ...data };
      delete dataWithoutFilters.filters;
      const intervalRows = filterRowsForView(routeRows, dataWithoutFilters);
      const visibleRows = filterRowsForView(routeRows, data);
      if (visibleRows.length === 0) {
        const filteredEmpty = intervalRows.length > 0
          && isPlainObject(data.filters)
          && Object.keys(data.filters).length > 0;
        root.replaceChildren(renderSwimlaneRouteState(
          pageId,
          getViewTitle(view, index),
          filteredEmpty ? 'No runs match the current filters.' : 'No workflow runs in this period',
          filteredEmpty ? 'Clear filters' : 'Try increasing the time horizon.',
          headingTag
        ));
        return;
      }
    }
    const scopedSources = source && Array.isArray(source.rows)
      ? {
          ...sources,
          [sourceName]: {
            ...source,
            rows: routeRows
          }
        }
      : sources;
    root.replaceChildren(renderCustomView(pageId, scopedView, index, scopedSources, units, headingTag));
  };
  root.addEventListener('dashboard-route-change', (event) => {
    if (!(event instanceof CustomEvent) || event.detail?.parameter !== routeParameter) return;
    render(event.detail.value);
  });
  render('');
  return root;
}

/**
 * @param {string} pageId
 * @param {string} title
 * @param {string} stateTitle
 * @param {string} detail
 * @param {'h3'|'h4'} headingTag
 */
function renderSwimlaneRouteState(pageId, title, stateTitle, detail, headingTag) {
  return renderPageSection(pageId, title, [
    h(
      'div',
      { className: 'chart-widget swimlane-chart-widget swimlane-empty-state', role: 'status' },
      h('strong', null, stateTitle),
      h('p', null, detail)
    )
  ], headingTag);
}

/**
 * @param {unknown} view
 * @param {number} index
 * @returns {string}
 */
function getViewTitle(view, index) {
  if (isPlainObject(view)) {
    if (typeof view.title === 'string' && view.title.length > 0) {
      return view.title;
    }
    if (typeof view.id === 'string' && view.id.length > 0) {
      return titleCase(view.id);
    }
  }
  return `View ${index + 1}`;
}

/**
 * @param {string} pageId
 * @param {string} title
 * @param {Record<string, unknown>} view
 * @param {Record<string, LogicalSourceInput>} sources
 * @param {string[]} contextDetails
 * @param {'h3'|'h4'} headingTag
 * @param {string} [routeParameter]
 * @returns {HTMLElement}
 */
function renderElementView(pageId, title, view, sources, contextDetails, headingTag, routeParameter) {
  const elementName = typeof view.element === 'string' ? view.element : '';
  const sourceNames = getViewSources(view);
  const viewData = isPlainObject(view.data) ? view.data : undefined;
  if (sourceNames.length === 0) {
    return renderCustomViewState(pageId, title, null, 'unavailable', [...contextDetails, 'No sources declared for element view.'], headingTag);
  }

  const selectedSources = Object.fromEntries(sourceNames.flatMap((sourceName) => {
    const source = sources[sourceName];
    return source && Array.isArray(source.rows)
      ? [[sourceName, { ...source, rows: filterRowsForView(source.rows, viewData) }]]
      : [];
  }));

  if (sourceNames.length === 1) {
    const sourceName = sourceNames[0];
    const source = selectedSources[sourceName];
    if (!source) {
      return renderCustomViewState(pageId, title, sourceName, 'unavailable', contextDetails, headingTag);
    }
    const state = source.metadata?.availability ?? inferAvailability(source.rows);
    if (state !== 'available' && !(state === 'empty' && elementHandlesEmptyRows(elementName))) {
      return renderCustomViewState(pageId, title, sourceName, state, contextDetails, headingTag);
    }
    if (source.rows.length === 0 && !elementHandlesEmptyRows(elementName)) {
      return renderCustomViewState(pageId, title, sourceName, 'empty', contextDetails, headingTag);
    }
  }

  const rendered = renderUiElement(elementName, {
    pageId,
    title,
    description: typeof view.description === 'string' ? view.description : undefined,
    sourceNames,
    sources: selectedSources,
    contextDetails,
    scope: isPlainObject(viewData?.scope) ? viewData.scope : undefined,
    titleLink: isPlainObject(view['title-link']) ? view['title-link'] : undefined,
    routeParameter,
    viewId: typeof view.id === 'string' ? view.id : undefined,
    elementConfig: isPlainObject(view.config) ? view.config : undefined,
    headingTag
  });
  if (!rendered) {
    return renderCustomViewState(pageId, title, null, 'unavailable', [...contextDetails, 'Unsupported UI element.'], headingTag);
  }
  return ['summary-grid', 'readiness-verdict'].includes(elementName)
    ? renderPageSection(pageId, title, [rendered], headingTag, typeof view.description === 'string' ? view.description : undefined)
    : rendered;
}

/**
 * @param {Element | null} target
 * @param {unknown} candidate
 */
function renderPageTitleLink(target, candidate) {
  if (!(target instanceof HTMLAnchorElement)) return;
  const link = findLink({ link: candidate }, 'link');
  if (!link || link.href.startsWith('#')) {
    target.hidden = true;
    target.removeAttribute('href');
    target.removeAttribute('target');
    target.removeAttribute('rel');
    target.removeAttribute('aria-label');
    target.textContent = '';
    return;
  }
  target.hidden = false;
  target.href = link.href;
  target.target = '_blank';
  target.rel = 'noopener noreferrer';
  target.setAttribute('aria-label', `View ${link.label} on GitHub`);
  target.textContent = link.label;
}

/**
 * @param {string} pageId
 * @param {string} title
 * @param {string | null} sourceName
 * @param {'available'|'empty'|'unavailable'} availability
 * @param {string[]} contextDetails
 * @param {'h3'|'h4'} [headingTag]
 * @param {string} [message]
 * @returns {HTMLElement}
 */
function renderCustomViewState(pageId, title, sourceName, availability, contextDetails, headingTag = 'h3', message) {
  return renderPageSection(pageId, title, [
    h('p', { 'data-view-availability': availability }, message ?? customViewAvailabilityMessage(availability)),
    ...renderCustomViewStateDetails(sourceName, contextDetails)
  ], headingTag);
}

/**
 * @param {string} pageId
 * @param {string} title
 * @param {Record<string, unknown>} view
 * @param {string} sourceName
 * @param {Array<Record<string, unknown>>} rows
 * @param {SourceMetadata} metadata
 * @param {string[]} contextDetails
 * @param {'h3'|'h4'} [headingTag]
 * @returns {HTMLElement}
 */
/**
 * @param {Array<Record<string, unknown>>} rows
 * @param {TableField[]} columns
 * @param {unknown} dataConfig
 * @returns {Array<Record<string, unknown>>}
 */
function prepareTableRows(rows, columns, dataConfig) {
  const aggregateColumns = columns.filter((column) => typeof column.aggregate === 'string');
  let prepared = aggregateColumns.length > 0 ? aggregateTableRows(rows, columns) : [...rows];
  const orderBy = /** @type {TableField[]} */ (isPlainObject(dataConfig) && Array.isArray(dataConfig['order-by'])
    ? dataConfig['order-by'].filter((item) => isPlainObject(item) && typeof item.field === 'string')
    : []);
  if (orderBy.length > 0) {
    prepared.sort((left, right) => compareOrderedRows(left, right, orderBy, columns));
  }
  const limit = isPlainObject(dataConfig) && Number.isInteger(dataConfig.limit) && dataConfig.limit > 0
    ? dataConfig.limit
    : null;
  return limit === null ? prepared : prepared.slice(0, limit);
}

/**
 * @param {Array<Record<string, unknown>>} rows
 * @param {TableField[]} columns
 * @returns {Array<Record<string, unknown>>}
 */
function aggregateTableRows(rows, columns) {
  const dimensions = columns.filter((column) => typeof column.aggregate !== 'string');
  /** @type {Map<string, Array<Record<string, unknown>>>} */
  const groups = new Map();
  for (const row of rows) {
    const key = JSON.stringify(dimensions.map((column) => row[column.field]));
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    const output = Object.fromEntries(dimensions.map((column) => [column.field, group[0]?.[column.field]]));
    for (const column of columns.filter((candidate) => typeof candidate.aggregate === 'string')) {
      const outputField = typeof column.as === 'string' ? column.as : column.field;
      output[outputField] = aggregateTableValue(group, column.field, column.aggregate);
    }
    return output;
  });
}

/**
 * @param {Array<Record<string, unknown>>} rows
 * @param {string} field
 * @param {unknown} aggregate
 * @returns {number | string}
 */
function aggregateTableValue(rows, field, aggregate) {
  const present = rows.map((row) => row[field]).filter((value) => value != null && value !== '');
  if (aggregate === 'count') return present.length;
  if (aggregate === 'distinct-count') return new Set(present.map(toText)).size;
  const values = present.map(toNumber);
  if (aggregate === 'sum') return values.reduce((total, value) => total + value, 0);
  if (aggregate === 'mean') return values.length > 0 ? values.reduce((total, value) => total + value, 0) / values.length : 'Unavailable';
  if (aggregate === 'min') return values.length > 0 ? Math.min(...values) : 'Unavailable';
  if (aggregate === 'max') return values.length > 0 ? Math.max(...values) : 'Unavailable';
  return present[0] == null ? 'Unavailable' : toText(present[0]);
}

/**
 * @param {Record<string, unknown>} left
 * @param {Record<string, unknown>} right
 * @param {TableField[]} orderBy
 * @param {TableField[]} columns
 * @returns {number}
 */
function compareOrderedRows(left, right, orderBy, columns) {
  for (const ordering of orderBy) {
    const comparison = compareTableValues(left[ordering.field], right[ordering.field]);
    if (comparison !== 0) return ordering.direction === 'desc' ? -comparison : comparison;
  }
  for (const column of columns.filter((candidate) => typeof candidate.aggregate !== 'string')) {
    const comparison = compareTableValues(left[column.field], right[column.field]);
    if (comparison !== 0) return comparison;
  }
  return 0;
}

/**
 * @param {unknown} left
 * @param {unknown} right
 * @returns {number}
 */
function compareTableValues(left, right) {
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  return toText(left).localeCompare(toText(right));
}

/**
 * @param {string} pageId
 * @param {string} title
 * @param {Array<Record<string, unknown>>} rows
 * @param {Record<string, any> | null} x
 * @param {Record<string, any> | null} y
 * @param {Record<string, any> | null} color
 * @param {string | null} hrefField
 * @returns {Array<{ key: string, x: string, y: number, category: string, color: string | null, highlighted: boolean | null, link: { href: string, label: string } | null, source: Record<string, unknown> }>}
 */
function buildChartPoints(pageId, title, rows, x, y, color, hrefField) {
  const aggregate = typeof y?.aggregate === 'string' ? y.aggregate : null;
  if (!aggregate || aggregate === 'none') {
    return rows.map((row, rowIndex) => ({
      key: `${pageId}-${title}-${rowIndex}`,
      x: x ? toText(row[x.field]) : 'unknown',
      y: y ? toNumber(row[y.field]) : 0,
      category: y ? toText(row[y.field]) : 'unknown',
      color: color ? toText(row[color.field]) : null,
      highlighted: typeof row['in-window'] === 'boolean' ? row['in-window'] : null,
      link: hrefField ? findLink(row, /** @type {LinkFieldName} */ (hrefField)) : null,
      source: row
    }));
  }

  /** @type {Map<string, { x: string, color: string | null, values: unknown[], links: Array<{ href: string, label: string }>, source: Record<string, unknown> }>} */
  const groups = new Map();
  for (const row of rows) {
    const xValue = x ? toText(row[x.field]) : 'unknown';
    const colorValue = color ? toText(row[color.field]) : null;
    const key = JSON.stringify([xValue, colorValue]);
    const group = groups.get(key) ?? { x: xValue, color: colorValue, values: [], links: [], source: row };
    group.values.push(y ? row[y.field] : null);
    const link = hrefField ? findLink(row, /** @type {LinkFieldName} */ (hrefField)) : null;
    if (link) group.links.push(link);
    groups.set(key, group);
  }
  return [...groups.values()].map((group, index) => {
    const numericValues = group.values.map(toNumber);
    let value = 0;
    if (aggregate === 'count') {
      value = group.values.filter((candidate) => candidate != null && candidate !== '').length;
    } else if (aggregate === 'distinct-count') {
      value = new Set(group.values.map(toText)).size;
    } else if (aggregate === 'sum') {
      value = numericValues.reduce((total, candidate) => total + candidate, 0);
    } else if (aggregate === 'mean') {
      value = numericValues.length > 0
        ? numericValues.reduce((total, candidate) => total + candidate, 0) / numericValues.length
        : 0;
    } else if (aggregate === 'min') {
      value = numericValues.length > 0 ? Math.min(...numericValues) : 0;
    } else if (aggregate === 'max') {
      value = numericValues.length > 0 ? Math.max(...numericValues) : 0;
    }
    const distinctLinks = new Map(group.links.map((link) => [link.href, link]));
    return {
      key: `${pageId}-${title}-${index}`,
      x: group.x,
      y: value,
      category: toText(group.values[0]),
      color: group.color,
      highlighted: null,
      link: distinctLinks.size === 1 ? distinctLinks.values().next().value ?? null : null,
      source: group.source
    };
  });
}

/**
 * Applies declarative chart ordering and limiting after aggregation.
 * @param {Array<{ key: string, x: string, y: number, category?: string, color: string | null, highlighted?: boolean | null, link: { href: string, label: string } | null, source?: Record<string, unknown> }>} points
 * @param {Record<string, any> | null} x
 * @param {Record<string, any> | null} y
 * @param {Record<string, any> | null} color
 * @param {unknown} dataConfig
 * @returns {Array<{ key: string, x: string, y: number, category?: string, color: string | null, highlighted?: boolean | null, link: { href: string, label: string } | null, source?: Record<string, unknown> }>}
 */
function prepareChartPoints(points, x, y, color, dataConfig) {
  const prepared = [...points];
  const orderBy = isPlainObject(dataConfig) && Array.isArray(dataConfig['order-by'])
    ? dataConfig['order-by'].filter((item) => isPlainObject(item) && typeof item.field === 'string')
    : [];
  prepared.sort((left, right) => {
    for (const item of orderBy) {
      const comparison = compareTableValues(
        chartPointOutputValue(left, item.field, x, y, color),
        chartPointOutputValue(right, item.field, x, y, color)
      );
      if (comparison !== 0) return item.direction === 'desc' ? -comparison : comparison;
    }
    const xComparison = left.x.localeCompare(right.x);
    return xComparison !== 0 ? xComparison : String(left.color ?? '').localeCompare(String(right.color ?? ''));
  });
  const limit = isPlainObject(dataConfig) && Number.isInteger(dataConfig.limit) && dataConfig.limit > 0
    ? dataConfig.limit
    : null;
  return limit === null ? prepared : prepared.slice(0, limit);
}

/**
 * @param {{ x: string, y: number, color: string | null }} point
 * @param {string} field
 * @param {Record<string, any> | null} x
 * @param {Record<string, any> | null} y
 * @param {Record<string, any> | null} color
 * @returns {string | number | null}
 */
function chartPointOutputValue(point, field, x, y, color) {
  if (field === x?.field || field === x?.as) return point.x;
  const yOutput = typeof y?.as === 'string'
    ? y.as
    : typeof y?.aggregate === 'string' ? `${y.aggregate}-${y.field}` : y?.field;
  if (field === y?.field || field === yOutput) return point.y;
  if (field === color?.field || field === color?.as) return point.color;
  return null;
}

/**
 * @param {Array<{ x: string, link: { href: string, label: string } | null }>} points
 * @returns {Map<string, { href: string, label: string }>}
 */
/**
 * @param {Array<Record<string, unknown>>} rows
 * @param {Record<string, unknown> | undefined} dataConfig
 * @returns {Array<Record<string, unknown>>}
 */
function filterRowsForView(rows, dataConfig) {
  if (!Array.isArray(rows)) {
    return [];
  }

  let filteredRows = rows;
  if (isPlainObject(dataConfig?.scope)) {
    filteredRows = filteredRows.filter((row) => rowMatchesScope(row, /** @type {Record<string, unknown>} */ (dataConfig.scope)));
  }
  if (isPlainObject(dataConfig?.time)) {
    filteredRows = filteredRows.filter((row) => rowMatchesTime(row, /** @type {Record<string, unknown>} */ (dataConfig.time)));
  }
  if (isPlainObject(dataConfig?.filters)) {
    filteredRows = filteredRows.filter((row) => rowMatchesFilters(row, /** @type {Record<string, unknown>} */ (dataConfig.filters)));
  }
  return filteredRows;
}

/**
 * @param {unknown} view
 * @param {Record<string, unknown>} dashboardDefaults
 * @returns {unknown}
 */
function applyDashboardDefaults(view, dashboardDefaults) {
  if (!isPlainObject(view) || !isPlainObject(view.data)) return view;
  const data = view.data;
  return {
    ...view,
    data: {
      ...dashboardDefaults,
      ...data,
      scope: data.scope ?? dashboardDefaults.scope,
      time: data.time ?? dashboardDefaults.time,
      filters: data.filters ?? dashboardDefaults.filters
    }
  };
}

/**
 * @param {unknown} defaults
 * @param {string} horizonRange
 * @param {string} evaluatedAt
 * @returns {Record<string, unknown>}
 */
function resolveDashboardDefaults(defaults, horizonRange, evaluatedAt) {
  const configured = isPlainObject(defaults) ? defaults : {};
  const evaluatedAtMs = Date.parse(evaluatedAt);
  const start = new Date(evaluatedAtMs - dashboardHorizonHours(horizonRange) * 3_600_000).toISOString();
  return {
    ...configured,
    time: { start, end: evaluatedAt }
  };
}

/**
 * @param {Record<string, unknown>} row
 * @param {Record<string, unknown>} scope
 * @returns {boolean}
 */
function rowMatchesScope(row, scope) {
  const scopeToField = {
    organizations: 'organization',
    repositories: 'repository',
    workflows: 'workflow'
  };

  for (const [scopeKey, fieldName] of Object.entries(scopeToField)) {
    const allowed = scope[scopeKey];
    if (!Array.isArray(allowed) || allowed.length === 0) {
      continue;
    }
    const value = row[fieldName];
    if (typeof value !== 'string' || !allowed.includes(value)) {
      return false;
    }
  }
  return true;
}

/**
 * @param {Record<string, unknown>} row
 * @param {Record<string, unknown>} time
 * @returns {boolean}
 */
function rowMatchesTime(row, time) {
  const observedField = pickRowTimeField(row);
  if (!observedField) {
    return true;
  }

  const rowInstant = Date.parse(String(row[observedField]));
  if (!Number.isFinite(rowInstant)) {
    return false;
  }

  const start = typeof time.start === 'string' ? Date.parse(time.start) : Number.NaN;
  const end = typeof time.end === 'string' ? Date.parse(time.end) : Number.NaN;
  if (Number.isFinite(start) && rowInstant < start) {
    return false;
  }
  if (Number.isFinite(end) && rowInstant >= end) {
    return false;
  }
  return true;
}

/**
 * @param {Record<string, unknown>} row
 * @returns {string | null}
 */
function pickRowTimeField(row) {
  if (typeof row['observed-at'] === 'string') {
    return 'observed-at';
  }
  if (typeof row['started-at'] === 'string') {
    return 'started-at';
  }
  if (typeof row['ended-at'] === 'string') {
    return 'ended-at';
  }
  return null;
}

/**
 * @param {Record<string, unknown>} row
 * @param {Record<string, unknown>} filters
 * @returns {boolean}
 */
function rowMatchesFilters(row, filters) {
  for (const [fieldName, expected] of Object.entries(filters)) {
    const value = row[fieldName];
    if (Array.isArray(expected)) {
      if (!expected.some((candidate) => valuesEqualForFilter(value, candidate))) {
        return false;
      }
      continue;
    }
    if (!valuesEqualForFilter(value, expected)) {
      return false;
    }
  }
  return true;
}

/**
 * @param {unknown} actual
 * @param {unknown} expected
 * @returns {boolean}
 */
function valuesEqualForFilter(actual, expected) {
  if (actual == null) {
    return expected === 'unknown';
  }
  return String(actual) === String(expected);
}


/**
 * Derives organization/repository/workflow GitHub links for every row that
 * exposes sufficient GitHub identity but does not already carry an explicit
 * relation-specific link field, so every GitHub-addressable entity can be
 * rendered as a link (Section 9.2 DLS-LINK-006/DLS-LINK-007).
 * @param {Record<string, LogicalSourceInput>} sources
 * @param {string} githubUrlBase
 * @returns {Record<string, LogicalSourceInput>}
 */
function deriveEntityLinkSources(sources, githubUrlBase) {
  return Object.fromEntries(Object.entries(sources).map(([name, source]) => [
    name,
    {
      ...source,
      rows: Array.isArray(source?.rows) ? source.rows.map((row) => deriveEntityLinkRow(row, githubUrlBase)) : source?.rows
    }
  ]));
}

/**
 * Adds presentation-only repository routes while retaining the canonical
 * external link for repository-scoped GitHub controls.
 * @param {Record<string, LogicalSourceInput>} sources
 * @param {Array<PresentableBuiltInPage | PresentableCustomPage>} pages
 * @returns {Record<string, LogicalSourceInput>}
 */
function deriveRepositoryDashboardLinks(sources, pages) {
  const detailPage = pages.find((page) => page.kind === 'custom' && page.route?.['hash-query-parameter'] === 'repository');
  if (!detailPage) return sources;

  return Object.fromEntries(Object.entries(sources).map(([name, source]) => [
    name,
    {
      ...source,
      rows: Array.isArray(source?.rows)
        ? source.rows.map((row) => deriveRepositoryDashboardLink(row, detailPage.id))
        : source?.rows
    }
  ]));
}

/**
 * Adds presentation-only workflow routes while retaining the canonical
 * authored workflow link for explicit source controls.
 * @param {Record<string, LogicalSourceInput>} sources
 * @param {Array<PresentableBuiltInPage | PresentableCustomPage>} pages
 * @returns {Record<string, LogicalSourceInput>}
 */
function deriveWorkflowDashboardLinks(sources, pages) {
  const insightsPage = pages.find((page) => page.kind === 'custom' && page.id === 'workflow-runtime');
  if (!insightsPage) return sources;
  const knownWorkflows = new Set((sources.workflows?.rows ?? [])
    .map(workflowDashboardIdentity)
    .filter((identity) => identity !== null));

  return Object.fromEntries(Object.entries(sources).map(([name, source]) => [
    name,
    {
      ...source,
      rows: Array.isArray(source?.rows)
        ? source.rows.map((row) => deriveWorkflowDashboardLink(row, insightsPage.id, knownWorkflows))
        : source?.rows
    }
  ]));
}

/**
 * @param {Record<string, unknown>} row
 * @param {string} pageId
 * @param {Set<string>} knownWorkflows
 * @returns {Record<string, unknown>}
 */
function deriveWorkflowDashboardLink(row, pageId, knownWorkflows) {
  const identity = workflowDashboardIdentity(row);
  const workflowLink = row['workflow-link'];
  if (!identity || !knownWorkflows.has(identity) || !isPlainObject(workflowLink)) return row;

  return {
    ...row,
    'workflow-link': {
      ...workflowLink,
      'dashboard-href': `#page-${encodeURIComponent(pageId)}?workflow=${encodeURIComponent(identity)}`,
      'dashboard-label': `View ${trimmedString(row['workflow-name']) ?? trimmedString(row.workflow)} workflow dashboard`
    }
  };
}

/**
 * @param {Record<string, unknown>} row
 * @param {string} pageId
 * @returns {Record<string, unknown>}
 */
function deriveRepositoryDashboardLink(row, pageId) {
  const organization = trimmedString(row.organization);
  const repository = trimmedString(row.repository);
  const repositorySlug = repository && repository.includes('/') ? repository : (organization && repository ? `${organization}/${repository}` : null);
  const repositoryLink = row['repository-link'];
  if (!repositorySlug || !isPlainObject(repositoryLink)) return row;

  return {
    ...row,
    'repository-link': {
      ...repositoryLink,
      'dashboard-href': `#page-${encodeURIComponent(pageId)}?repository=${encodeURIComponent(repositorySlug)}`,
      'dashboard-label': `View ${repositorySlug} repository dashboard`
    }
  };
}

/**
 * @param {Record<string, unknown>} row
 * @param {string} githubUrlBase
 * @returns {Record<string, unknown>}
 */
function deriveEntityLinkRow(row, githubUrlBase) {
  const organization = trimmedString(row.organization);
  const repository = trimmedString(row.repository);
  const workflow = trimmedString(row.workflow);
  // The `repository` field is documented as retaining its domain syntax (Section 9.2), so it may
  // already be a fully-qualified `owner/repo` slug or just the bare repository name.
  const repositorySlug = repository && repository.includes('/') ? repository : (organization && repository ? `${organization}/${repository}` : null);
  const workflowRepositorySlug = repositorySlugValue(row['runtime-repository']) ?? repositorySlug;
  /** @type {Record<string, unknown>} */
  const derived = {};

  if (organization && !findLink(row, 'organization-link')) {
    derived['organization-link'] = {
      relation: 'organization',
      href: `${githubUrlBase}/${organization}`,
      label: `View ${organization} on GitHub`
    };
  }
  if (repositorySlug && !findLink(row, 'repository-link')) {
    derived['repository-link'] = {
      relation: 'repository',
      href: `${githubUrlBase}/${repositorySlug}`,
      label: `View ${repositorySlug} on GitHub`
    };
  }
  if (workflowRepositorySlug && workflow && !findLink(row, 'workflow-link')) {
    const workflowPath = workflow.replace(/^\/+/, '');
    derived['workflow-link'] = {
      relation: 'workflow',
      href: `${githubUrlBase}/${workflowRepositorySlug}/blob/HEAD/${workflowPath}`,
      label: `View ${workflow} on GitHub`
    };
  }

  return Object.keys(derived).length > 0 ? { ...row, ...derived } : row;
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function trimmedString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** @param {unknown} value */
function repositorySlugValue(value) {
  const repository = trimmedString(value);
  return repository && /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,98}[A-Za-z0-9])?\/[A-Za-z0-9_.-]{1,100}$/.test(repository)
    ? repository
    : null;
}

/** @param {Record<string, unknown>} row */
function workflowDashboardIdentity(row) {
  const organization = trimmedString(row.organization);
  const repository = trimmedString(row.repository);
  const repositorySlug = repository && repository.includes('/') ? repository : (organization && repository ? `${organization}/${repository}` : null);
  const workflowRepositorySlug = repositorySlugValue(row['runtime-repository']) ?? repositorySlug;
  const workflow = trimmedString(row.workflow);
  return workflowRepositorySlug && workflow ? `${workflowRepositorySlug}:${workflow}` : null;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function toText(value) {
  return stringOrFallback(value, 'unknown');
}


/**
 * @param {HTMLElement} root
 */
export function enableDashboardKeyboardNavigation(root) {
  root.addEventListener('keydown', (event) => {
    if (!(event instanceof KeyboardEvent) || !(event.target instanceof Element)) return;
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const section = event.target.closest('.dashboard-page .page-section');
    const page = section?.closest('.dashboard-page');
    if (!(section instanceof HTMLElement) || !(page instanceof HTMLElement)) return;
    const sections = [...page.querySelectorAll('.page-section')]
      .filter((candidate) => candidate instanceof HTMLElement);
    const delta = event.key === 'ArrowDown' ? 1 : -1;
    const nextSection = sections[sections.indexOf(section) + delta];
    if (!nextSection) return;
    event.preventDefault();
    nextSection.focus();
  });
}

/**
 * @param {string} value
 * @returns {string}
 */
function titleCase(value) {
  return value
    .split('-')
    .filter(Boolean)
    .map((part) => part[0] ? `${part[0].toUpperCase()}${part.slice(1)}` : part)
    .join(' ');
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
