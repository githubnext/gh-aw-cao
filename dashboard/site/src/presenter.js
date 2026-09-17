/**
 * Presenter for JSON-driven dashboard pages using GitHub Primer styling and elements.
 */

import { h } from './dom.js';
import { getPrimerStyles } from './styles.js';
import { octicon } from './octicons.js';
import { renderDataStateMetrics } from './components/data-state.js';
import { titleCase } from './components/count-formatters.js';
import { formatMediumUtcDateTime, renderEmptyMessage, renderLoadingPlaceholderBlocks } from './components/ui-primitives.js';
import { customViewAvailabilityMessage, renderCustomViewStateDetails, renderLayoutSectionChrome, renderPageSection, renderViewDisclosure } from './components/view-chrome.js';
import { findLink } from './components/link-content.js';
import { elementHandlesEmptyRows, elementHandlesUnavailableSource, elementLoadsSourcesAsync, renderUiElement } from './components/ui-elements.js';
import { renderDataView, supportsIncrementalChartContinuation } from './components/data-view.js';
import { enableHorizonOutsideClickDismissal, renderFilterBar, setTimeWindowFilter, setTimeWindowRange } from './components/filter-bar.js';
import { renderSiteCallouts } from './components/site-callout.js';
import { renderDashboardHorizon } from './components/dashboard-horizon.js';
import { restoreDashboardTheme } from './components/theme-settings.js';
import { cancelLazyViewHydration, disconnectLazyViews, enableLazyViews, hydrateLazyViewAfterPaint, renderLazyView } from './components/lazy-view.js';
import { enableFullViewScrollForwarding, syncFullViewMode as syncFullViewModeForPage } from './components/full-view-scroll.js';
import { DASHBOARD_RENDER_EVENT, emitDashboardDebugEvent } from './debug-events.js';
import { dashboardViewAliasName } from './data/queries/view-payload-compiler.js';
import { dashboardHorizonHours, formatDashboardHorizon, formatDashboardHorizonHours, resolveDashboardHorizon } from './horizon.js';
import { sourceContinuation } from './data/continuation.js';
import { renderDashboardNavigation, enableDashboardNavigation } from './components/dashboard-navigation.js';
import { renderDashboardHeader } from './components/dashboard-header.js';
import { renderDashboardFooter } from './components/dashboard-footer.js';
import { renderDashboardFrame } from './components/dashboard-frame.js';
import { scopedStorageKey } from './storage-scope.js';
import { buildChartPoints, prepareChartPoints, prepareTableRows, toViewText } from './components/view-data.js';
import { enableDashboardKeyboardNavigation, updateWithViewTransition } from './components/dashboard-interactions.js';
import { publishSource } from './source-store.js';

export { enableDashboardKeyboardNavigation, updateWithViewTransition };
import {
  dashboardPageLazySourceNames as collectDashboardPageLazySourceNames,
  dashboardPagePayload,
  dashboardPageSourceNames as collectDashboardPageSourceNames,
  dashboardTableSourceNames as collectDashboardTableSourceNames,
} from './dashboard-chunks.js';

/**
 * @typedef {{ availability: 'available'|'empty'|'unavailable', completeness: 'complete'|'partial'|'unknown', freshness: 'fresh'|'stale'|'unknown' }} DataState
 */

/**
 * @typedef {{ 'source-id': string, 'source-kind': string, 'as-of': string, 'retrieved-at': string, 'coverage-start'?: string, 'coverage-end'?: string, completeness: DataState['completeness'], freshness: DataState['freshness'], availability?: DataState['availability'] } & Record<string, unknown>} SourceMetadata
 */

/**
 * @typedef {{ source: string, rows: Array<Record<string, unknown>>, metadata: SourceMetadata, continuationToken?: string, loadContinuation?: (token: string) => Promise<LogicalSourceInput> }} LogicalSourceInput
 */

/**
 * @typedef {{ id: string, title?: string, description?: string, layout: 'full'|'wide'|'narrow'|'horizontal', views: string[], ['count-source']?: string, ['count-sources']?: string[], ['count-field']?: string, ['count-label']?: string }} PresentablePageSection
 */

/**
 * @typedef {{ id: string, kind: 'built-in', page: string, title?: string, ['navigation-label']?: string, description?: string, icon?: string, ['class-name']?: string, chunk?: string, ['source-names']?: string[], ['lazy-source-names']?: string[], ['table-source-names']?: string[], definition?: { views?: Array<unknown>, sections?: PresentablePageSection[], ['data-state']?: Record<string, boolean> } }} PresentableBuiltInPage
 */

/**
 * @typedef {{ id: string, kind: 'custom', title?: string, ['navigation-label']?: string, description?: string, icon?: string, ['class-name']?: string, chunk?: string, ['source-names']?: string[], ['lazy-source-names']?: string[], ['table-source-names']?: string[], route?: { ['hash-query-parameter']?: string, ['navigation-page']?: string }, views: unknown[], sections?: PresentablePageSection[] }} PresentableCustomPage
 */

/**
 * @typedef {{ field: string, aggregate?: string, as?: string, direction?: string, display?: string } & Record<string, unknown>} TableField
 */

/**
 * @typedef {{ label?: string, pages?: string[], experimental?: boolean }} PresentableNavigationSection
 */

/**
 * @typedef {{ id: string, title: string, description?: string, defaults?: Record<string, unknown>, units?: Record<string, { name: string, symbol: string, significant: number }>, queries?: Array<Record<string, unknown>>, views?: Array<Record<string, unknown>>, ['card-templates']?: Array<{ id: string, icon: string, title: TableField, subtitle?: TableField, labels: TableField[], details: TableField[] }>, callouts?: Array<{ id: string, title: string, description: string, icon?: string, ['navigation-page']?: string, ['visible-when']?: { source: string, field: string, equals: unknown } }>, ['cli-actions']?: Array<{ id: string, label: string, description?: string, icon: string, command: string, placement?: 'toolbar'|'settings'|'view'|'row', arguments?: Array<{ id: string, label: string, description?: string, type: 'boolean', flag: string, default?: boolean }> }>, pages: Array<PresentableBuiltInPage | PresentableCustomPage>, ['github-url-base']?: string, repository?: string, navigation?: PresentableNavigationSection[], horizon?: { label: string, tooltip: { label: string, description: string, icon?: string } } }} PresentableDashboard
 */

/**
 * @typedef {{ languageVersion: string, dashboard: PresentableDashboard }} PresentationDocument
 */

/**
 * @typedef {{ login: string, name: string, avatarUrl: string }} LocalViewer
 */

/**
 * @typedef {{ signal: AbortSignal, onUpdate: (sources: Record<string, LogicalSourceInput>) => void, syncPageChrome?: () => void, routeParameters?: Record<string, string>, queryContext?: { filters?: Record<string, string[]>, search?: { fields: string[], query: string }, orderBy?: Array<{ field: string, direction?: 'asc'|'desc' }>, timeWindow?: { start?: string, end?: string } } }} PageSourceLoadOptions
 */

/**
 * @typedef {{ document: PresentationDocument, sources: Record<string, LogicalSourceInput>, commitSha?: string | null, viewer?: LocalViewer | null, prepared?: boolean, loading?: boolean, tableRowLimit?: number, loadPageSources?: (pageId: string, options: PageSourceLoadOptions) => Promise<Record<string, LogicalSourceInput>> }} PresentationInput
 */

/**
 * @typedef {'organization-link'|'repository-link'|'workflow-link'|'issue-link'|'pull-request-link'|'run-link'|'evidence-link'|'external-link'} LinkFieldName
 */

const DEFAULT_GITHUB_URL_BASE = 'https://github.com';
const TABLE_ROW_LIMIT = Symbol('table-row-limit');
const MOBILE_VIEW_MODE_STORAGE_KEY = scopedStorageKey('central-agentic-ops.dashboard.mobile-view-mode');
const NAVIGATION_INDEX_STATE_KEY = 'centralAgenticOpsNavigationIndex';
/** @type {WeakMap<HTMLElement, () => void>} */
const dashboardDisposals = new WeakMap();
/**
 * @param {PresentableBuiltInPage | PresentableCustomPage} page
 * @param {Array<Record<string, unknown>>} [reusableViews]
 * @returns {PresentableCustomPage}
 */
function getBuiltInPagePayload(page, reusableViews = []) {
  return /** @type {PresentableCustomPage} */ (dashboardPagePayload(page, reusableViews));
}

/**
 * @param {PresentationDocument} document
 * @param {string} pageId
 * @returns {string[]}
 */
export function dashboardPageSourceNames(document, pageId) {
  return collectDashboardPageSourceNames(document, pageId);
}

/**
 * Returns sources rendered by lazy-list views without exposing pagination in
 * the dashboard query language.
 * @param {PresentationDocument} document
 * @param {string} pageId
 */
export function dashboardPageLazySourceNames(document, pageId) {
  return collectDashboardPageLazySourceNames(document, pageId);
}

/** @param {PresentationDocument} document */
export function dashboardTableSourceNames(document) {
  return collectDashboardTableSourceNames(document);
}

/**
 * @param {PresentationInput} input
 * @returns {HTMLElement}
 */
export function renderDashboard(input) {
  const { document, sources: rawSources, viewer = null } = input;
  const pages = document.dashboard.pages;
  const cardTemplates = Object.fromEntries((document.dashboard['card-templates'] ?? []).map((template) => [template.id, template]));
  const reusableViews = document.dashboard.views ?? [];
  const horizonRange = resolveDashboardHorizon(document.dashboard);
  const hasData = Object.values(rawSources).some((source) => Array.isArray(source?.rows) && source.rows.length > 0);
  const showInitialLoadingSkeleton = input.loading === true && !hasData;
  const dataHorizon = resolveDataHorizon(rawSources);
  const githubUrlBase = typeof document.dashboard['github-url-base'] === 'string' && document.dashboard['github-url-base'].length > 0
    ? document.dashboard['github-url-base']
    : DEFAULT_GITHUB_URL_BASE;
  const dashboardRepository = typeof document.dashboard.repository === 'string' && document.dashboard.repository.length > 0
    ? document.dashboard.repository
    : null;
  const sources = rawSources;
  const orgName = inferOrganizationName(sources) || 'GitHub';
  const sidebarTitle = dashboardRepository?.split('/').at(-1) || orgName;
  const evaluatedAt = dataHorizon?.end ?? latestRetrievedAt(sources) ?? new Date().toISOString();
  const dashboardDefaults = {
    ...resolveDashboardDefaults(document.dashboard.defaults, horizonRange, evaluatedAt),
    [TABLE_ROW_LIMIT]: input.tableRowLimit
  };
  const dashboardHorizon = renderDashboardHorizon({
    dashboard: document.dashboard,
    initialValue: resolveDashboardHorizonViewModel(rawSources, dashboardDefaults, horizonRange, evaluatedAt),
    formatDate: formatReportDate
  });

  const styleEl = h('style', null, getPrimerStyles());
  const skipLink = h('a', { href: '#main-content', className: 'skip-link' }, 'Skip to main content');

  const sidebar = renderDashboardNavigation(pages, sidebarTitle, document.dashboard.navigation);
  const initialPage = pages.find((page) => page.id !== 'configuration') ?? pages[0];
  const overviewPage = pages.find((page) => page.id === 'overview');
  const initialPageHref = initialPage ? `#page-${encodeURIComponent(initialPage.id)}` : '#main-content';
  const appShell = renderDashboardFrame({
    navigation: sidebar,
    header: renderDashboardHeader({
      title: initialPage ? getPageTitle(initialPage) : '',
      description: initialPage?.description,
      overviewPageHref: overviewPage ? `#page-${encodeURIComponent(overviewPage.id)}` : initialPageHref,
      dashboardHorizon: dashboardHorizon.element,
      githubUrlBase,
      dashboardRepository,
      viewer
    }),
    callouts: renderSiteCallouts(document.dashboard.callouts, sources),
    pages: pages.map((page) => renderPagePlaceholder(page)),
    footer: renderDashboardFooter({ evaluatedAt, commitSha: input.commitSha })
  });
  const root = h(
    'div',
    { className: 'dashboard-root' },
    styleEl,
    skipLink,
    appShell
  );
  const dashboardOwner = new AbortController();
  void enableDashboardDomProvenanceWhenDebugging(root, document).catch((error) => {
    root.dataset.domProvenanceError = String(error?.message ?? error);
  });
  enableDashboardNavigation(root);
  restoreDashboardTheme(root);
  enableHorizonOutsideClickDismissal(root);
  root.addEventListener('dashboard-time-window-change', (event) => {
    if (!(event instanceof CustomEvent)) return;
    setTimeWindowFilter(event.detail?.start, event.detail?.end, root);
  }, { signal: dashboardOwner.signal });
  root.addEventListener('dashboard-time-window-range-change', (event) => {
    if (!(event instanceof CustomEvent)) return;
    setTimeWindowRange(event.detail?.range, root);
  }, { signal: dashboardOwner.signal });
  enableResponsiveReportActions(root, dashboardOwner.signal);
  const disposeNavigation = enableDashboardPageNavigation(
    root,
    document.dashboard.title,
    (pageId, options) => {
      const pageIndex = pages.findIndex((candidate) => candidate.id === pageId);
      const resolvedPage = () => pages[pageIndex] ?? pages.find((candidate) => candidate.id === pageId);
      if (!resolvedPage()) return null;
      const rendersBeforePageSources = pageUsesIndependentSourceElements(resolvedPage(), reusableViews);
      /** @param {Record<string, LogicalSourceInput>} pageSources */
      const updateHorizon = (pageSources) => {
        if (options.signal?.aborted !== true) {
          dashboardHorizon.update(resolveDashboardHorizonViewModel(
            pageSources,
            dashboardDefaults,
            horizonRange,
            evaluatedAt
          ));
        }
      };
      /** @param {Record<string, LogicalSourceInput>} pageSources */
      const updateIndependentElements = (pageSources) => {
        updateHorizon(pageSources);
        for (const [bindingKey, source] of Object.entries(pageSources)) {
          publishSource(bindingKey, source, bindingKey);
        }
        options.syncPageChrome?.();
      };
      /** @param {Record<string, LogicalSourceInput>} pageSources */
      const render = (pageSources) => {
        const page = resolvedPage();
        if (!page) throw new Error(`Dashboard page "${pageId}" is not available.`);
        updateHorizon(pageSources);
        return showInitialLoadingSkeleton && !rendersBeforePageSources
          ? renderPageLoadingSkeleton(page)
          : renderPage(page, pageSources, isPlainObject(document.dashboard.units) ? document.dashboard.units : {}, dashboardDefaults, cardTemplates, reusableViews, options.queryContext);
      };
      if (input.loadPageSources) {
        options.onUpdate = rendersBeforePageSources
          ? updateIndependentElements
          : (pageSources) => options.renderUpdate(render(pageSources));
        if (rendersBeforePageSources) {
          const renderedPage = render(sources);
          void input.loadPageSources(pageId, options)
            .then(updateIndependentElements)
            .catch((error) => {
              if (!options.signal?.aborted) {
                console.error(`Unable to load dashboard page ${pageId}: ${error instanceof Error ? error.message : String(error)}`);
              }
            });
          return renderedPage;
        }
        return input.loadPageSources(pageId, options).then(render);
      }
      const renderedPage = render(sources);
      /** @param {HTMLElement} rendered */
      const annotate = (rendered) => {
        const page = resolvedPage();
        if (!page) return rendered;
        void annotateLazyPageDomWhenDebugging(root, rendered, page, pageIndex).catch((error) => {
          root.dataset.domProvenanceError = String(error?.message ?? error);
        });
        return rendered;
      };
      return renderedPage instanceof Promise ? renderedPage.then(annotate) : annotate(renderedPage);
    },
    sidebar.dataset.defaultPageId,
    Boolean(input.loadPageSources),
    new Set((document.dashboard.queries ?? []).flatMap((query) => (
      isPlainObject(query) && typeof query.name === 'string' ? [query.name] : []
    )))
  );
  dashboardDisposals.set(root, () => {
    dashboardOwner.abort();
    disposeNavigation();
    dashboardHorizon.dispose();
  });
  return root;
}

/**
 * Pages composed entirely from independently bound elements can mount before
 * their companion page subscription resolves.
 * @param {PresentableBuiltInPage | PresentableCustomPage | undefined} page
 * @param {Array<Record<string, unknown>>} reusableViews
 */
function pageUsesIndependentSourceElements(page, reusableViews) {
  if (!page) return false;
  const reusableById = new Map(reusableViews.map((view) => [view.id, view]));
  const configuredViews = page.kind === 'built-in' ? page.definition?.views : page.views;
  if (!Array.isArray(configuredViews) || configuredViews.length === 0) return false;
  return configuredViews.every((configured) => {
    const view = typeof configured === 'string' ? reusableById.get(configured) : configured;
    return isPlainObject(view)
      && typeof view.element === 'string'
      && elementLoadsSourcesAsync(view.element);
  });
}

/** @param {HTMLElement} root */
export function disposeDashboard(root) {
  dashboardDisposals.get(root)?.();
  dashboardDisposals.delete(root);
  for (const page of root.querySelectorAll('.dashboard-page')) {
    if (page instanceof HTMLElement) disconnectLazyViews(page);
  }
}

/**
 * Lazily loads the debug-only DOM provenance module (never bundled into the
 * default dashboard load) and enables it only when `?debug=1` is present in
 * the page URL, so Playwright/agent analysis can opt in without imposing any
 * cost on regular dashboard visits.
 * @param {HTMLElement} root
 * @param {PresentationDocument} document
 */
async function enableDashboardDomProvenanceWhenDebugging(root, document) {
  if (!isDomProvenanceDebugRequested(root)) return;
  const { enableDashboardDomProvenance } = await import('./dom-provenance.js');
  enableDashboardDomProvenance(root, document, getBuiltInPagePayload  );
}

/**
 * Retains route tabs while moving between sibling views so only the selected
 * view body enters its loading state.
 * @param {HTMLElement} page
 * @param {string} pageId
 * @param {URLSearchParams} parameters
 * @returns {HTMLElement | null}
 */
function cloneRouteTabsForPage(page, pageId, parameters) {
  const tabs = page.querySelector('[data-route-tabs]');
  if (!(tabs instanceof HTMLElement)) return null;
  const target = [...tabs.querySelectorAll('a')].find((link) => {
    const href = link.getAttribute('href') ?? '';
    const [route, query = ''] = href.split('?');
    if (!route.startsWith('#page-')) return false;
    try {
      return decodeURIComponent(route.slice('#page-'.length)) === pageId
        && queryParametersMatch(new URLSearchParams(query), parameters);
    } catch {
      return false;
    }
  });
  if (!target) return null;
  const clone = /** @type {HTMLElement} */ (tabs.cloneNode(true));
  for (const link of clone.querySelectorAll('a')) {
    if (link.getAttribute('href') === target.getAttribute('href')) {
      link.setAttribute('aria-current', 'page');
    } else {
      link.removeAttribute('aria-current');
    }
  }
  return clone;
}

/**
 * @param {URLSearchParams} left
 * @param {URLSearchParams} right
 */
function queryParametersMatch(left, right) {
  /** @param {URLSearchParams} parameters */
  const entries = (parameters) => [...parameters.entries()]
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => (
      leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue)
    ));
  return JSON.stringify(entries(left)) === JSON.stringify(entries(right));
}

/**
 * @param {HTMLElement} page
 * @param {HTMLElement | null} routeTabs
 */
function showPageSkeleton(page, routeTabs) {
  page.replaceChildren(...(routeTabs ? [routeTabs, renderPageSkeleton()] : [renderPageSkeleton()]));
  page.setAttribute('aria-busy', 'true');
}

/**
 * @param {HTMLElement} root
 * @returns {boolean}
 */
function isDomProvenanceDebugRequested(root) {
  const search = root.ownerDocument.defaultView?.location.search ?? '';
  return new URLSearchParams(search).get('debug') === '1';
}

/**
 * @param {HTMLElement} root
 * @param {Element} renderedPage
 * @param {PresentableBuiltInPage | PresentableCustomPage} page
 * @param {number} pageIndex
 */
async function annotateLazyPageDomWhenDebugging(root, renderedPage, page, pageIndex) {
  if (!isDomProvenanceDebugRequested(root)) return;
  const { annotatePageDom } = await import('./dom-provenance.js');
  annotatePageDom(renderedPage, page, pageIndex, getBuiltInPagePayload);
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
 * Keeps global dashboard controls inside the mobile hamburger menu while
 * preserving the single control instances and their filter-bar event
 * relationships. On narrow viewports the page title also moves into the
 * compact mobile header row (replacing the app brand) so the page no longer
 * shows a full-width secondary header that repeats the current page title,
 * matching the title bar used by the GitHub mobile app. The factory name stays
 * visible as a secondary line below that page title.
 * @param {HTMLElement} root
 * @param {AbortSignal} signal
 */
function enableResponsiveReportActions(root, signal) {
  const actions = root.querySelector('.report-actions');
  const mobileSlot = root.querySelector('.mobile-nav-menu-actions');
  const desktopSlot = actions?.parentElement;
  const overviewHeader = root.querySelector('.overview-header');
  const mobileHeaderSlot = root.querySelector('.mobile-page-header');
  const headerDesktopSlot = overviewHeader?.parentElement;
  const viewModeToggle = root.querySelector('.mobile-view-mode-toggle');
  const mobileToggleSlot = viewModeToggle?.parentElement;
  const mobileToggleAnchor = root.querySelector('.mobile-nav-menu');
  const desktopToggleSlot = overviewHeader?.querySelector('.title-area');
  const view = root.ownerDocument.defaultView;
  const media = view?.matchMedia?.('(max-width: 700px)');
  if (!(actions instanceof HTMLElement) || !(mobileSlot instanceof HTMLElement) || !desktopSlot || !media) return;

  const placeActions = () => {
    const destination = media.matches ? mobileSlot : desktopSlot;
    if (actions.parentElement !== destination) destination.append(actions);
    if (overviewHeader instanceof HTMLElement && mobileHeaderSlot instanceof HTMLElement && headerDesktopSlot) {
      if (media.matches) {
        if (overviewHeader.parentElement !== mobileHeaderSlot) mobileHeaderSlot.prepend(overviewHeader);
      } else if (overviewHeader.parentElement !== headerDesktopSlot) {
        headerDesktopSlot.prepend(overviewHeader);
      }
    }
    if (
      viewModeToggle instanceof HTMLElement
      && mobileToggleSlot
      && mobileToggleAnchor instanceof HTMLElement
      && desktopToggleSlot instanceof HTMLElement
    ) {
      if (media.matches || root.classList.contains('dashboard-full-view-scrolled')) {
        if (viewModeToggle.parentElement !== mobileToggleSlot) {
          mobileToggleSlot.insertBefore(viewModeToggle, mobileToggleAnchor);
        }
      } else if (viewModeToggle.parentElement !== desktopToggleSlot) {
        desktopToggleSlot.append(viewModeToggle);
      }
    }
  };
  placeActions();
  media.addEventListener?.('change', placeActions, { signal });
  const observer = new MutationObserver(placeActions);
  observer.observe(root, { attributes: true, attributeFilter: ['class'] });
  signal.addEventListener('abort', () => observer.disconnect(), { once: true });
}

/**
 * @param {Record<string, LogicalSourceInput>} sources
 * @param {Record<string, unknown>} dashboardDefaults
 * @param {string} horizonRange
 * @param {string} fallbackEvaluatedAt
 * @returns {{ available: boolean, evaluatedAt: string, duration: string, start: string, end: string }}
 */
function resolveDashboardHorizonViewModel(sources, dashboardDefaults, horizonRange, fallbackEvaluatedAt) {
  const dataHorizon = resolveDataHorizon(sources);
  const evaluatedAt = dataHorizon?.end ?? latestRetrievedAt(sources) ?? fallbackEvaluatedAt;
  const duration = dataHorizon
    ? formatDashboardHorizonHours(dataHorizon.hours)
    : formatDashboardHorizon(horizonRange);
  const start = dataHorizon?.start ?? (isPlainObject(dashboardDefaults.time) && typeof dashboardDefaults.time.start === 'string'
    ? dashboardDefaults.time.start
    : new Date(new Date(evaluatedAt).getTime() - dashboardHorizonHours(horizonRange) * 3_600_000).toISOString());
  const end = dataHorizon?.end ?? (isPlainObject(dashboardDefaults.time) && typeof dashboardDefaults.time.end === 'string'
    ? dashboardDefaults.time.end
    : evaluatedAt);
  return { available: true, evaluatedAt, duration, start, end };
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
 * @param {PresentableBuiltInPage | PresentableCustomPage} page
 * @returns {HTMLElement}
 */
function renderPageLoadingSkeleton(page) {
  const placeholder = renderPagePlaceholder(page);
  placeholder.removeAttribute('data-page-pending');
  placeholder.setAttribute('aria-busy', 'true');
  placeholder.append(renderPageSkeleton());
  return placeholder;
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
    ...renderLoadingPlaceholderBlocks()
  );
}

/**
 * @param {PresentableBuiltInPage | PresentableCustomPage} page
 * @param {Record<string, LogicalSourceInput>} sources
 * @param {Record<string, { name: string, symbol: string, significant: number }>} units
 * @param {Record<string, unknown>} dashboardDefaults
 * @param {Record<string, { id: string, icon: string, title: TableField, subtitle?: TableField, labels: TableField[], details: TableField[] }>} cardTemplates
 * @param {Array<Record<string, unknown>>} reusableViews
 * @param {PageSourceLoadOptions['queryContext']} [queryContext]
 * @returns {HTMLElement}
 */
function renderPage(page, sources, units, dashboardDefaults, cardTemplates, reusableViews, queryContext) {
  const title = getPageTitle(page);
  const payload = getBuiltInPagePayload(page, reusableViews);
  return renderCustomPage(payload, title, sources, units, dashboardDefaults, cardTemplates, true, queryContext);
}

/**
 * @param {PresentableCustomPage} page
 * @param {string} title
 * @param {Record<string, LogicalSourceInput>} sources
 * @param {Record<string, { name: string, symbol: string, significant: number }>} units
 * @param {Record<string, unknown>} dashboardDefaults
 * @param {Record<string, { id: string, icon: string, title: TableField, subtitle?: TableField, labels: TableField[], details: TableField[] }>} cardTemplates
 * @param {boolean} [withFilterBar]
 * @param {PageSourceLoadOptions['queryContext']} [queryContext]
 * @returns {HTMLElement}
 */
function renderCustomPage(page, title, sources, units, dashboardDefaults, cardTemplates, withFilterBar = true, queryContext) {
  const effectiveDashboardDefaults = inventoryPage(page.id)
    ? { ...dashboardDefaults, time: undefined }
    : dashboardDefaults;
  const views = Array.isArray(page.views)
    ? page.views.map((view) => applyDashboardDefaults(view, effectiveDashboardDefaults))
    : [];
  const mobileTableViewIndex = views.findIndex((view) => (
    isPlainObject(view)
    && view.layout === 'full-view'
    && view['lazy-list'] === true
  ));
  const supportsMobileViewMode = mobileTableViewIndex >= 0;
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
    const layout = isPlainObject(view) && typeof view.layout === 'string' ? view.layout : 'full';
    const disclosure = isPlainObject(view) && view.disclosure === 'supplemental' ? 'supplemental' : 'essential';
    const isRouteView = Boolean(
      routeParameter
      && isPlainObject(view)
      && (
        view.mark === 'element'
        || typeof view.element === 'string'
        || (isPlainObject(view.data) && typeof view.data['route-field'] === 'string')
      )
    );
    const render = () => {
      const rendered = renderCustomView(page.id, view, index, sources, units, cardTemplates, headingTag, routeParameter, queryContext);
      suppressSupplementalTableHeading(rendered, view, index);
      if (disclosure === 'essential') {
        rendered.classList.add('custom-view');
        rendered.setAttribute('data-view-layout', layout);
      }
      rendered.setAttribute('data-disclosure', disclosure);
      if (isPlainObject(view) && view['lazy-list'] === true) {
        rendered.setAttribute('data-view-lazy-list', '');
      }
      if (supportsMobileViewMode) {
        rendered.dataset.mobileViewMode = index === mobileTableViewIndex ? 'table' : 'chart';
      }
      return rendered;
    };
    const rendered = isRouteView
      || index === 0
      || (isPlainObject(view) && (view.mark === 'callout' || (
        typeof view.element === 'string' && elementLoadsSourcesAsync(view.element)
      )))
      ? render()
      : renderLazyView({
        label: getViewTitle(view, index),
        headingLevel: headingTag,
        minHeight: layout === 'half' || layout === 'third' ? 180 : 280,
        render
      });
    rendered.classList.add('custom-view');
    rendered.setAttribute('data-view-id', viewId || `view-${index + 1}`);
    rendered.setAttribute('data-view-layout', layout);
    rendered.setAttribute('data-disclosure', disclosure);
    if (isPlainObject(view) && view['lazy-list'] === true) {
      rendered.setAttribute('data-view-lazy-list', '');
    }
    if (disclosure === 'essential') {
      return rendered;
    }

    rendered.classList.remove('custom-view');
    rendered.removeAttribute('data-view-layout');
    return renderViewDisclosure(rendered, layout, disclosure, getViewTitle(view, index));
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
  const filterBar = withFilterBar && !inventoryPage(page.id)
    ? renderFilterBar((filters, timeWindow) => {
      root.dispatchEvent(new CustomEvent('dashboard-query-context-change', {
        bubbles: true,
        detail: {
          pageId: page.id,
          queryContext: {
            filters: Object.fromEntries([...filters.entries()]),
            ...(page.id === 'readiness' || !timeWindow
              ? {}
              : { timeWindow: { start: timeWindow.start, end: timeWindow.end } })
          }
        }
      }));
    }, {
      defaultRange: isPlainObject(dashboardDefaults.time) && typeof dashboardDefaults.time.range === 'string'
        ? dashboardDefaults.time.range
        : 'all',
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
      'data-route-navigation-page': routeNavigationPage,
      'data-mobile-view-mode-page': supportsMobileViewMode ? '' : undefined
    },
    filterBar,
    ...(renderedViews.length > 0
      ? [renderHiddenDataStateMetrics(summarizeDataState(pageSources)), renderedContent]
      : [h('p', null, 'No custom views available.')])
  );
  return root;
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
  const countSourceNames = Array.isArray(section['count-sources'])
    ? section['count-sources']
    : section['count-source'] ? [section['count-source']] : [];
  const countField = typeof section['count-field'] === 'string' ? section['count-field'] : null;
  const countSources = countSourceNames.map((sourceName) => sources[sourceName]).filter(Boolean);
  const countValues = countField
    ? countSources.flatMap((source) => {
        if (source.metadata?.availability === 'unavailable') return [];
        const value = Number(source.rows?.[0]?.[countField]);
        return Number.isFinite(value) ? [value] : [];
      })
    : [];
  const count = countField
    ? countValues.length > 0 ? countValues.reduce((total, value) => total + value, 0) : null
    : countSources.length === 1 && Array.isArray(countSources[0]?.rows)
      ? countSources[0].rows.length
      : null;
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
 * @param {(pageId: string, options: PageSourceLoadOptions & { renderUpdate: (page: HTMLElement) => void }) => HTMLElement | Promise<HTMLElement> | null} [renderPageById]
 * @param {string} [defaultPageId]
 * @param {boolean} [reloadPopulatedPages]
 * @param {Set<string>} [knownQueries]
 * @returns {() => void}
 */
export function enableDashboardPageNavigation(root, dashboardTitle = '', renderPageById, defaultPageId = '', reloadPopulatedPages = false, knownQueries = new Set()) {
  const pages = [...root.querySelectorAll('.dashboard-page')]
    .filter((page) => page instanceof HTMLElement);
  /** @type {Map<string, { details: boolean[], scrollTop: number }>} */
  const pageState = new Map();
  let activePageId = '';
  let activationRevision = 0;
  let pageOwner = new AbortController();
  const navigationOwner = new AbortController();
  const disposeNavigation = () => {
    activationRevision += 1;
    navigationOwner.abort();
    pageOwner.abort();
  };
  /** @type {Map<string, { filters?: Record<string, string[]>, timeWindow?: { start?: string, end?: string } }>} */
  const pageQueryContext = new Map();
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
  const pageScroller = root.querySelector('main.dashboard-prototype');
  const mobileViewModeToggle = root.querySelector('.mobile-view-mode-toggle');
  /** @type {'chart'|'table'|'card'} */
  let mobileViewMode = 'chart';
  try {
    const storedMode = globalThis.window?.localStorage?.getItem(MOBILE_VIEW_MODE_STORAGE_KEY);
    mobileViewMode = storedMode === 'table' || storedMode === 'card' ? storedMode : 'chart';
  } catch {
    // Storage can be unavailable in embedded or privacy-restricted contexts.
  }
  root.dataset.mobileViewMode = mobileViewMode;
  /** @type {'chart'|'table'|'card'} */
  let nextMobileViewMode = 'table';
  /** @param {'chart'|'table'|'card'} mode @param {HTMLElement | undefined} page */
  const setMobileViewMode = (mode, page) => {
    const pendingTable = page?.querySelector('[data-mobile-view-mode="table"][data-lazy-view]');
    if (pendingTable instanceof HTMLElement) {
      if (mode === 'table' || mode === 'card') void hydrateLazyViewAfterPaint(pendingTable);
      else cancelLazyViewHydration(pendingTable);
    }
    mobileViewMode = mode;
    root.dataset.mobileViewMode = mode;
    try {
      globalThis.window?.localStorage?.setItem(MOBILE_VIEW_MODE_STORAGE_KEY, mode);
    } catch {
      // The display mode still works for the current page when storage is unavailable.
    }
    syncFullViewMode(page);
  };
  /** @param {HTMLElement | undefined} page */
  const syncFullViewMode = (page) => {
    const views = page
      ? [...page.querySelectorAll('.custom-view')].filter((view) => view instanceof HTMLElement)
      : [];
    const tableView = views.find((view) => (
      view.dataset.viewLayout === 'full-view'
      && (view.hasAttribute('data-view-lazy-list') || view.querySelector('[data-lazy-list]'))
    ));
    const supportsModeSelection = Boolean(tableView);
    const hasChartMode = Boolean(tableView) && views.some((view) => view !== tableView);
    if (supportsModeSelection && !hasChartMode && mobileViewMode === 'chart') {
      mobileViewMode = 'table';
      root.dataset.mobileViewMode = mobileViewMode;
    }
    page?.toggleAttribute('data-mobile-view-mode-page', supportsModeSelection);
    for (const view of views) {
      if (supportsModeSelection) {
        view.dataset.mobileViewMode = view === tableView ? 'table' : 'chart';
      } else {
        delete view.dataset.mobileViewMode;
      }
    }
    if (mobileViewModeToggle instanceof HTMLButtonElement) {
      mobileViewModeToggle.hidden = !supportsModeSelection;
      nextMobileViewMode = hasChartMode
        ? mobileViewMode === 'chart' ? 'table' : mobileViewMode === 'table' ? 'card' : 'chart'
        : mobileViewMode === 'card' ? 'table' : 'card';
      const label = `Show ${nextMobileViewMode === 'card' ? 'card list' : nextMobileViewMode} view`;
      mobileViewModeToggle.setAttribute('aria-label', label);
      mobileViewModeToggle.setAttribute('aria-pressed', String(mobileViewMode !== 'chart'));
      mobileViewModeToggle.setAttribute('title', label);
      mobileViewModeToggle.replaceChildren(octicon(
        nextMobileViewMode === 'table' ? 'table' : nextMobileViewMode === 'card' ? 'stack' : 'graph'
      ));
    }
    syncFullViewModeForPage(root, page);
  };
  if (mobileViewModeToggle instanceof HTMLButtonElement) {
    mobileViewModeToggle.addEventListener('click', () => {
      const page = pages.find((candidate) => candidate.dataset.pageId === activePageId);
      setMobileViewMode(nextMobileViewMode, page);
    }, { signal: navigationOwner.signal });
    root.ownerDocument.defaultView?.matchMedia?.('(max-width: 700px)')?.addEventListener?.('change', () => {
      syncFullViewMode(pages.find((candidate) => candidate.dataset.pageId === activePageId));
    }, { signal: navigationOwner.signal });
  }
  const defaultBreadcrumbs = [breadcrumbRoot, breadcrumbDashboard].map((link) => ({
    label: link?.textContent ?? '',
    href: link instanceof HTMLAnchorElement ? link.getAttribute('href') ?? '' : '',
    hidden: link instanceof HTMLElement ? link.hidden : false
  }));
  if (pages.length === 0 || links.length === 0) {
    return disposeNavigation;
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
  }, { signal: navigationOwner.signal });

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
     if (navigationOwner.signal.aborted) return;
     const revision = ++activationRevision;
    pageOwner.abort();
    pageOwner = new AbortController();
    let pagePopulated = false;
    const dashboardHorizon = root.querySelector('.dashboard-horizon');
    let activeFilterBar = root.querySelector('.report-actions > .filter-bar');
    /**
     * @param {HTMLElement | undefined} page
     */
    const placeDashboardHorizon = (page) => {
      const filterBar = page?.querySelector('.filter-bar');
      if (dashboardHorizon && filterBar && reportActions) {
        if (activeFilterBar && activeFilterBar !== filterBar) {
          // Reclaim component-owned details before discarding the stale filter bar.
          const previousDetails = activeFilterBar.querySelector('.horizon-details');
          if (previousDetails) dashboardHorizon.append(previousDetails);
          activeFilterBar.remove();
        }
        filterBar.prepend(dashboardHorizon);
        const horizonDetails = dashboardHorizon.querySelector('.horizon-details');
        const tuningControls = filterBar.querySelector('.filter-tuning-controls');
        if (horizonDetails && tuningControls) tuningControls.append(horizonDetails);
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
        const scrollingElement = pageScroller instanceof HTMLElement
          ? pageScroller
          : root.ownerDocument.scrollingElement ?? root.ownerDocument.documentElement;
        scrollingElement.scrollTop = scrollTop;
      }
    };
    let populationDeferred = false;
    /** @type {HTMLElement | null} */
    let retainedRouteTabs = null;
    if (activePageId && activePageId !== pageId) {
      const activePage = pages.find((candidate) => candidate.dataset.pageId === activePageId);
      if (activePage) {
        retainedRouteTabs = cloneRouteTabsForPage(activePage, pageId, parameters);
        const horizonDetails = activeFilterBar?.querySelector('.horizon-details');
        if (dashboardHorizon && horizonDetails) dashboardHorizon.append(horizonDetails);
        if (dashboardHorizon && activeFilterBar?.contains(dashboardHorizon)) dashboardHorizon.remove();
        activeFilterBar?.remove();
        activeFilterBar = null;
        pageState.set(activePageId, {
          details: [...activePage.querySelectorAll('details')].map((details) => details.open),
          scrollTop: pageScroller instanceof HTMLElement
            ? pageScroller.scrollTop
            : root.ownerDocument.scrollingElement?.scrollTop ?? root.ownerDocument.documentElement.scrollTop
        });
        disconnectLazyViews(activePage);
        activePage.replaceChildren();
        activePage.removeAttribute('aria-busy');
        activePage.setAttribute('data-page-pending', '');
      }
    }
    activePageId = pageId;
    const routeParameters = Object.fromEntries([...parameters.entries()].map(([key, value]) => [key, value]));
    const queryContext = pageQueryContext.get(pageId);
    root.classList.toggle('dashboard-mobile-overview-actions', pageId === overviewPage?.dataset.pageId);
    const pageIndex = pages.findIndex((candidate) => candidate.dataset.pageId === pageId);
    const pendingPage = pages[pageIndex];
    if (pendingPage && (pendingPage.hasAttribute('data-page-pending') || reloadPopulatedPages)) {
      const populate = () => {
        if (revision !== activationRevision || activePageId !== pageId) return;
        let currentPage = pages[pageIndex];
        if (!currentPage) return;
        /** @param {HTMLElement} renderedPage */
        const replacePage = (renderedPage) => {
          if (revision !== activationRevision || activePageId !== pageId || !currentPage.parentNode) return;
          const detailsState = pageState.get(pageId)?.details ?? [];
          [...renderedPage.querySelectorAll('details')].forEach((details, index) => {
            if (detailsState[index] !== undefined) details.open = detailsState[index];
          });
          renderedPage.dataset.routeValue = currentPage.dataset.routeValue ?? '';
          currentPage.replaceWith(renderedPage);
          pages[pageIndex] = renderedPage;
          currentPage = renderedPage;
          enableLazyViews(renderedPage);
          emitDashboardDebugEvent(root.ownerDocument, DASHBOARD_RENDER_EVENT, {
            kind: 'page',
            pageId,
            status: 'completed'
          });
          pagePopulated = true;
          placeDashboardHorizon(renderedPage);
          syncFullViewMode(renderedPage);
          if (deferPopulation) {
            dispatchPageRoute(renderedPage, renderedPage.dataset.routeParameter ?? '', renderedPage.dataset.routeValue);
            restoreScroll(renderedPage);
          }
        };
        const rendered = renderPageById?.(pageId, {
          signal: pageOwner.signal,
          onUpdate: () => {},
          syncPageChrome: () => {
            const horizonDetails = dashboardHorizon?.querySelector('.horizon-details');
            const tuningControls = activeFilterBar?.querySelector('.filter-tuning-controls');
            if (horizonDetails && tuningControls) tuningControls.append(horizonDetails);
            syncFullViewMode(currentPage);
          },
          routeParameters,
          queryContext,
          renderUpdate: replacePage
        });
        if (!rendered) return;
        if (rendered instanceof Promise) {
          if (pendingPage.hasAttribute('data-page-pending')) {
            showPageSkeleton(pendingPage, retainedRouteTabs);
          }
          void rendered.then(replacePage).catch(() => {
            if (revision !== activationRevision || activePageId !== pageId || !currentPage.parentNode) return;
            currentPage.replaceChildren(renderEmptyMessage('Unable to load this page.', { role: 'alert' }));
            currentPage.removeAttribute('aria-busy');
          });
        } else {
          replacePage(rendered);
        }
      };
      if (deferPopulation) {
        populationDeferred = true;
        showPageSkeleton(pendingPage, retainedRouteTabs);
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
    syncFullViewMode(page);
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
    const queryTitle = resolveQueryDrillPageTitle(parameters, knownQueries);
    const title = queryTitle || routeValue || page?.dataset.pageTitle || '';
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
    if (page && !populationDeferred && !pagePopulated) {
      emitDashboardDebugEvent(root.ownerDocument, DASHBOARD_RENDER_EVENT, {
        kind: 'page',
        pageId,
        status: 'completed'
      });
    }
    if (!populationDeferred) restoreScroll(page);
  };

  const initialRoute = routeFromHash();
  const initialPageId = availableIds.has(defaultPageId) ? defaultPageId : pages[0].dataset.pageId ?? '';
  activate(initialRoute?.pageId ?? initialPageId, initialRoute?.parameters);
  const defaultView = root.ownerDocument.defaultView;
  const historyBack = root.querySelector('.mobile-history-back');
  const browserNavigation = /** @type {(EventTarget & {
   *   currentEntry?: { index: number } | null,
   *   entries?: () => Array<{ index: number, url: string | null }>
   * }) | undefined} */ (
    /** @type {Window & { navigation?: unknown }} */ (defaultView)?.navigation
  );
  const initialNavigationIndex = defaultView?.history.state?.[NAVIGATION_INDEX_STATE_KEY];
  let navigationIndex = Number.isSafeInteger(initialNavigationIndex) && initialNavigationIndex >= 0
    ? initialNavigationIndex
    : 0;
  /** @type {'forward'|'backward'|undefined} */
  let pendingNavigationDirection;
  /** @type {string | undefined} */
  let pendingNavigationHash;
  const previousEntryIsDashboard = () => {
    const currentEntry = browserNavigation?.currentEntry;
    const entries = browserNavigation?.entries?.();
    if (!defaultView || !currentEntry || !entries) return navigationIndex > 0;
    const previousEntry = entries.find((entry) => entry.index === currentEntry.index - 1);
    if (!previousEntry?.url) return false;
    try {
      const previousUrl = new URL(previousEntry.url);
      const currentUrl = defaultView.location;
      return previousUrl.origin === currentUrl.origin
        && previousUrl.pathname === currentUrl.pathname
        && previousUrl.search === currentUrl.search;
    } catch {
      return false;
    }
  };
  const syncHistoryBack = () => {
    if (historyBack instanceof HTMLButtonElement) historyBack.hidden = !previousEntryIsDashboard();
  };
  if (defaultView && initialNavigationIndex !== navigationIndex) {
    const state = defaultView.history.state && typeof defaultView.history.state === 'object'
      ? defaultView.history.state
      : {};
    defaultView.history.replaceState(
      { ...state, [NAVIGATION_INDEX_STATE_KEY]: navigationIndex },
      '',
      defaultView.location.href
    );
  }
  syncHistoryBack();
  historyBack?.addEventListener('click', () => defaultView?.history.back(), { signal: navigationOwner.signal });
  root.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return;
    const link = event.target.closest('[data-nav-page-id], [data-mobile-nav-page-id]');
    if (!(link instanceof HTMLAnchorElement)) return;
    event.preventDefault();
    pendingNavigationDirection = undefined;
    pendingNavigationHash = undefined;
    const pageId = getNavigationPageId(link);
    if (!pageId || !availableIds.has(pageId)) return;
    navigationIndex += 1;
    defaultView?.history.pushState({ [NAVIGATION_INDEX_STATE_KEY]: navigationIndex }, '', link.href);
    syncHistoryBack();
    updateWithViewTransition(root.ownerDocument, () => activate(pageId, routeFromHash()?.parameters, true), 'forward');
    if (pageTitle instanceof HTMLElement) pageTitle.focus();
  }, { signal: navigationOwner.signal });
  root.addEventListener('dashboard-query-context-change', (event) => {
    if (!(event instanceof CustomEvent)) return;
    const detail = isPlainObject(event.detail) ? event.detail : {};
    const pageId = typeof detail.pageId === 'string' && detail.pageId
      ? detail.pageId
      : activePageId;
    if (!pageId || pageId !== activePageId || !availableIds.has(pageId)) return;
    const nextContext = normalizeDashboardQueryContext(detail.queryContext);
    if (sameDashboardQueryContext(pageQueryContext.get(pageId), nextContext)) return;
    if (nextContext) pageQueryContext.set(pageId, nextContext);
    else pageQueryContext.delete(pageId);
    const route = routeFromHash();
    activate(route?.pageId ?? pageId, route?.parameters ?? new URLSearchParams(), true);
  }, { signal: navigationOwner.signal });

  const disposeFullViewScrollForwarding = enableFullViewScrollForwarding(root, defaultView);
  /** @param {PopStateEvent} event */
  const onPopState = (event) => {
    if (!root.isConnected) {
      defaultView?.removeEventListener('hashchange', onHashChange);
      defaultView?.removeEventListener('popstate', onPopState);
      browserNavigation?.removeEventListener('currententrychange', syncHistoryBack);
      return;
    }
    const index = event.state?.[NAVIGATION_INDEX_STATE_KEY];
    const nextNavigationIndex = Number.isSafeInteger(index) && index >= 0 ? index : 0;
    pendingNavigationDirection = nextNavigationIndex < navigationIndex
      ? 'backward'
      : nextNavigationIndex > navigationIndex
        ? 'forward'
        : undefined;
    pendingNavigationHash = defaultView?.location.hash;
    navigationIndex = nextNavigationIndex;
    syncHistoryBack();
  };
  const onHashChange = () => {
    if (!root.isConnected) {
      defaultView?.removeEventListener('hashchange', onHashChange);
      defaultView?.removeEventListener('popstate', onPopState);
      browserNavigation?.removeEventListener('currententrychange', syncHistoryBack);
      return;
    }
    syncHistoryBack();
    const route = routeFromHash();
    const navigationDirection = pendingNavigationHash === defaultView?.location.hash
      ? pendingNavigationDirection
      : undefined;
    pendingNavigationDirection = undefined;
    pendingNavigationHash = undefined;
    updateWithViewTransition(root.ownerDocument, () => activate(
      route?.pageId ?? initialPageId,
      route?.parameters,
      true
    ), navigationDirection);
    if (pageTitle instanceof HTMLElement) pageTitle.focus();
  };
  browserNavigation?.addEventListener('currententrychange', syncHistoryBack, { signal: navigationOwner.signal });
  defaultView?.addEventListener('popstate', onPopState, { signal: navigationOwner.signal });
  defaultView?.addEventListener('hashchange', onHashChange, { signal: navigationOwner.signal });
  return () => {
    disposeFullViewScrollForwarding();
    disposeNavigation();
  };
}

/**
 * @param {URLSearchParams} parameters
 * @param {Set<string>} knownQueries
 */
export function resolveQueryDrillPageTitle(parameters, knownQueries) {
  const queryName = parameters.get('query')?.trim() ?? '';
  return knownQueries.has(queryName) ? parameters.get('title')?.trim() ?? '' : '';
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

/** @param {string} pageId */
function inventoryPage(pageId) {
  return pageId === 'agents' || pageId === 'work' || pageId === 'work-tasks' || pageId === 'work-roadmap';
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
 * Resolves the worker-produced payload for one authored view source.
 * Raw sources remain a fixture-only fallback for direct presenter tests.
 * @param {Record<string, LogicalSourceInput>} sources
 * @param {string} pageId
 * @param {unknown} view
 * @param {number} viewIndex
 * @param {string} sourceName
 * @param {number} sourceIndex
 */
function resolveViewSourceName(sources, pageId, view, viewIndex, sourceName, sourceIndex) {
  const alias = dashboardViewAliasName(pageId, view, viewIndex, sourceName, sourceIndex);
  return sources[alias] ? alias : sourceName;
}

/** @param {unknown} value @returns {PageSourceLoadOptions['queryContext']} */
function normalizeDashboardQueryContext(value) {
  if (!isPlainObject(value)) return undefined;
  const filters = isPlainObject(value.filters)
    ? Object.fromEntries(Object.entries(value.filters).flatMap(([field, values]) => {
        const normalized = Array.isArray(values)
          ? values.filter((entry) => typeof entry === 'string').map(String)
          : [];
        return normalized.length > 0 ? [[field, normalized]] : [];
      }))
    : undefined;
  const search = isPlainObject(value.search)
    && Array.isArray(value.search.fields)
    && typeof value.search.query === 'string'
    ? {
        fields: value.search.fields.filter((field) => typeof field === 'string' && field.trim()).map(String),
        query: value.search.query.trim()
      }
    : undefined;
  const orderBy = Array.isArray(value.orderBy)
    ? value.orderBy.flatMap((ordering) => {
        if (!isPlainObject(ordering) || typeof ordering.field !== 'string' || !ordering.field.trim()) return [];
        const direction = ordering.direction === 'asc' || ordering.direction === 'desc' ? ordering.direction : undefined;
        return [{ field: ordering.field, ...(direction ? { direction } : {}) }];
      })
    : [];
  const timeWindow = isPlainObject(value.timeWindow)
    ? {
        start: typeof value.timeWindow.start === 'string' ? value.timeWindow.start : undefined,
        end: typeof value.timeWindow.end === 'string' ? value.timeWindow.end : undefined
      }
    : undefined;
  return {
    ...(filters && Object.keys(filters).length > 0 ? { filters } : {}),
    ...(search && search.fields.length > 0 && search.query ? { search } : {}),
    ...(orderBy.length > 0 ? { orderBy } : {}),
    ...(timeWindow?.start || timeWindow?.end ? { timeWindow } : {})
  };
}

/** @param {PageSourceLoadOptions['queryContext']} left @param {PageSourceLoadOptions['queryContext']} right */
function sameDashboardQueryContext(left, right) {
  return JSON.stringify(left ?? {}) === JSON.stringify(right ?? {});
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
 * @param {Record<string, { id: string, icon: string, title: TableField, subtitle?: TableField, labels: TableField[], details: TableField[] }>} cardTemplates
 * @param {'h3'|'h4'} [headingTag]
 * @param {string} [routeParameter]
 * @param {PageSourceLoadOptions['queryContext']} [queryContext]
 * @returns {HTMLElement}
 */
function renderCustomView(pageId, view, index, sources, units, cardTemplates, headingTag = 'h3', routeParameter, queryContext) {
  const fallbackTitle = `View ${index + 1}`;
  if (!isPlainObject(view)) {
    return renderCustomViewState(pageId, fallbackTitle, null, 'unavailable', ['Invalid custom view definition.'], headingTag);
  }

  const title = getViewTitle(view, index);

  /** @type {string[]} */
  const contextDetails = [];

  if (view.mark === 'element') {
    return renderElementView(pageId, title, view, index, sources, contextDetails, headingTag, routeParameter, queryContext);
  }
  if (view.mark === 'callout') {
    return renderCalloutView(pageId, view, title, headingTag);
  }

  const authoredSourceName = getViewSources(view)[0] ?? null;
  if (!authoredSourceName) {
    return renderCustomViewState(pageId, title, null, 'unavailable', ['Source unavailable.'], headingTag);
  }

  const resolvedSourceName = resolveViewSourceName(sources, pageId, view, index, authoredSourceName, 0);

  const sourceInput = sources[resolvedSourceName];
  if (!sourceInput || !Array.isArray(sourceInput.rows)) {
    return renderCustomViewState(pageId, title, authoredSourceName, 'unavailable', [`Source unavailable: ${authoredSourceName}`], headingTag);
  }

  const filteredRows = sourceInput.rows;
  const metadata = sourceInput.metadata;
  const state = sourceInput.metadata?.availability ?? inferAvailability(filteredRows);
  const emptyMessage = typeof view['empty-message'] === 'string' ? view['empty-message'] : undefined;
  const isMetricCard = view.mark === 'metric'
    && isPlainObject(view.metric)
    && view.metric.style === 'card';

  if (state !== 'available' && view.mark !== 'list' && !(state === 'empty' && view.mark === 'table') && !isMetricCard) {
    return renderCustomViewState(
      pageId,
      title,
      authoredSourceName,
      state,
      contextDetails,
      headingTag,
      state === 'empty' ? emptyMessage : undefined
    );
  }

  if (filteredRows.length === 0 && view.mark !== 'table' && !isMetricCard) {
    return renderCustomViewState(pageId, title, authoredSourceName, 'empty', contextDetails, headingTag, emptyMessage);
  }

  // Swimlanes consume the same paginated run source as their companion lazy
  // table, but render each continuation page as it arrives.
  const sourcePage = view['lazy-list'] === true || supportsIncrementalChartContinuation(view)
    ? sourceContinuation(sourceInput)
    : undefined;
  const rendered = renderDataView(typeof view.mark === 'string' ? view.mark : '', {
    pageId,
    title,
    view,
    sourceName: authoredSourceName,
    rows: filteredRows,
    rowLimit: Number(/** @type {Record<PropertyKey, unknown>} */ (view.data ?? {})[TABLE_ROW_LIMIT]),
    metadata,
    contextDetails,
    headingTag,
    units,
    cardTemplates,
    prepareTableRows,
    buildChartPoints,
    prepareChartPoints,
    toText: toViewText,
    continuation: sourcePage ? {
      ...sourcePage,
      load: async (token) => {
        const next = await sourcePage.load(token);
        return {
          rows: next?.rows ?? [],
          continuationToken: next?.continuationToken
        };
      }
    } : undefined
  });
  if (rendered) return rendered;

  return renderCustomViewState(pageId, title, authoredSourceName, 'unavailable', [...contextDetails, 'Unsupported view mark.'], headingTag);
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
 * @param {unknown} view
 * @param {number} index
 * @returns {string}
 */
function getViewTitle(view, index) {
  if (isPlainObject(view)) {
    if (
      view.disclosure === 'supplemental'
      && typeof view['disclosure-label'] === 'string'
      && view['disclosure-label'].length > 0
    ) {
      return view['disclosure-label'];
    }

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
 * @param {HTMLElement} rendered
 * @param {unknown} view
 * @param {number} index
 */
function suppressSupplementalTableHeading(rendered, view, index) {
  if (!isPlainObject(view) || view.mark !== 'table' || view.disclosure !== 'supplemental') return;
  const section = rendered.matches('.page-section') ? rendered : rendered.querySelector('.page-section');
  if (!(section instanceof HTMLElement)) return;
  section.querySelector(':scope > h3, :scope > h4')?.remove();
  section.removeAttribute('aria-labelledby');
  section.setAttribute('aria-label', getViewTitle(view, index));
}

/**
 * @param {string} pageId
 * @param {string} title
 * @param {Record<string, unknown>} view
 * @param {number} viewIndex
 * @param {Record<string, LogicalSourceInput>} sources
 * @param {string[]} contextDetails
 * @param {'h3'|'h4'} headingTag
 * @param {string} [routeParameter]
 * @param {PageSourceLoadOptions['queryContext']} [queryContext]
 * @returns {HTMLElement}
 */
function renderElementView(pageId, title, view, viewIndex, sources, contextDetails, headingTag, routeParameter, queryContext) {
  const elementName = typeof view.element === 'string' ? view.element : '';
  const sourceNames = getViewSources(view);
  const viewData = isPlainObject(view.data) ? view.data : undefined;
  if (sourceNames.length === 0) {
    return renderCustomViewState(pageId, title, null, 'unavailable', [...contextDetails, 'No sources declared for element view.'], headingTag);
  }

  const selectedSources = Object.fromEntries(sourceNames.flatMap((sourceName, sourceIndex) => {
    const resolvedName = resolveViewSourceName(sources, pageId, view, viewIndex, sourceName, sourceIndex);
    const source = sources[resolvedName];
    return source && Array.isArray(source.rows)
      ? [[sourceName, source]]
      : [];
  }));

  if (sourceNames.length === 1) {
    const sourceName = sourceNames[0];
    const source = selectedSources[sourceName];
    if (!source && !elementHandlesUnavailableSource(elementName)) {
      return renderCustomViewState(pageId, title, sourceName, 'unavailable', contextDetails, headingTag);
    }
    const state = source?.metadata?.availability ?? (source ? inferAvailability(source.rows) : 'unavailable');
    if (state !== 'available'
        && !(state === 'empty' && elementHandlesEmptyRows(elementName))
        && !(state === 'unavailable' && elementHandlesUnavailableSource(elementName))) {
      return renderCustomViewState(pageId, title, sourceName, state, contextDetails, headingTag);
    }
    if (source && source.rows.length === 0 && !elementHandlesEmptyRows(elementName)) {
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
    time: isPlainObject(viewData?.time) ? viewData.time : undefined,
    titleLink: isPlainObject(view['title-link']) ? view['title-link'] : undefined,
    routeParameter,
    queryContext,
    viewId: typeof view.id === 'string' ? view.id : undefined,
    viewIndex,
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
    h(
      'div',
      {
        className: 'view-state-card',
        'data-view-state': availability,
        role: availability === 'unavailable' ? 'alert' : 'status'
      },
      octicon(availability === 'unavailable' ? 'alert' : 'info'),
      h(
        'div',
        { className: 'view-state-card-body' },
        h('p', { className: 'view-state-message', 'data-view-availability': availability }, message ?? customViewAvailabilityMessage(availability)),
        ...renderCustomViewStateDetails(sourceName, contextDetails)
      )
    )
  ], headingTag);
}

/**
 * @param {unknown} view
 * @param {Record<string, unknown>} dashboardDefaults
 * @returns {unknown}
 */
function applyDashboardDefaults(view, dashboardDefaults) {
  if (!isPlainObject(view) || !isPlainObject(view.data)) return view;
  const data = view.data;
  const time = data.time ?? dashboardDefaults.time;
  return {
    ...view,
    data: {
      ...dashboardDefaults,
      ...data,
      scope: data.scope ?? dashboardDefaults.scope,
      time: resolveViewTime(time, dashboardDefaults.time),
      filters: data.filters ?? dashboardDefaults.filters
    }
  };
}

/**
 * @param {unknown} time
 * @param {unknown} dashboardTime
 * @returns {unknown}
 */
function resolveViewTime(time, dashboardTime) {
  if (!isPlainObject(time) || typeof time.range !== 'string') return time;
  if (!isPlainObject(dashboardTime) || typeof dashboardTime.end !== 'string') return time;
  const evaluatedAt = Date.parse(dashboardTime.end);
  if (!Number.isFinite(evaluatedAt)) return time;
  let hours;
  try {
    hours = dashboardHorizonHours(time.range);
  } catch {
    return time;
  }
  return {
    start: new Date(evaluatedAt - hours * 3_600_000).toISOString(),
    end: dashboardTime.end
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
  if (!isPlainObject(configured.time)) {
    return { ...configured, time: { end: evaluatedAt } };
  }
  const evaluatedAtMs = Date.parse(evaluatedAt);
  const start = new Date(evaluatedAtMs - dashboardHorizonHours(horizonRange) * 3_600_000).toISOString();
  return {
    ...configured,
    time: { start, end: evaluatedAt }
  };
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
