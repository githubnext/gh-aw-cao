import { formatCount } from './count-formatters.js';
import { bindFactorySources, createFactoryMetrics, createFactoryScope, factoryStationLabel } from './factory-elements.js';
import { renderFactoryStation } from './factory-station.js';
import { renderReactiveGrid } from './reactive-grid.js';
import { h, keyed } from '../dom.js';
import { effect } from '../reactive.js';
import { findLink } from './link-content.js';
import { octicon } from '../octicons.js';

/** @typedef {{ operations: number, live: number, review: number }} Motion */
/** @typedef {{ rows: () => Record<string, unknown>[], pending: () => boolean, unavailable: () => boolean }} SourceBinding */
/** @typedef {Record<string, SourceBinding>} SourceBindings */
/** @typedef {{ total: number, registered: number, unavailable: boolean, registeredUnavailable: boolean }} Coverage */
/** @typedef {{ successfulRuns: () => number, failedRuns: () => number, activeRuns: () => number, valueGains: () => number, coverage: () => Coverage, workers: () => number, dispatches: () => number, failedDispatches: () => number, usefulOutputs: () => number, deliveredRepositories: () => number, motion: () => Motion }} OverviewMetrics */
/** @typedef {{ signal: AbortSignal, motion: import('../reactive.js').State<Motion> }} FactoryFloorScope */

/**
 * @param {SourceBindings} sources
 * @param {OverviewMetrics} metrics
 * @param {(labelId: string, count: number) => string} label
 * @param {boolean} animateNumbers
 * @param {FactoryFloorScope} scope
 */
export function renderFactoryFloor(sources, metrics, label, animateNumbers, scope) {
  const repositories = renderFactoryStation('repo', { animate: animateNumbers, href: '#page-repositories', signal: scope.signal });
  const runs = renderFactoryStation('play', { animate: animateNumbers, href: '#page-runs?runs-runs-source.run-conclusion=success', signal: scope.signal });
  const dispatches = renderFactoryStation('workflow', { animate: animateNumbers, href: '#page-runs', signal: scope.signal });
  const valueGains = renderFactoryStation('trophy', { animate: animateNumbers, final: true, href: '#page-operational-value', signal: scope.signal });

  repositories.bind(() => {
    const coverage = metrics.coverage();
    return {
      pending: sources['overview-registered-repository-summary'].pending(),
      unavailable: coverage.registeredUnavailable,
      label: label('repositories', coverage.registered),
      value: coverage.registered,
      detail: { text: '' }
    };
  });

  runs.bind(() => {
    const successfulRuns = metrics.successfulRuns();
    const failedRuns = metrics.failedRuns();
    return {
      pending: sources['overview-run-summary'].pending(),
      label: label('successful-runs', successfulRuns),
      value: successfulRuns,
      detail: {
        text: `${formatCount(failedRuns)} failed`,
        href: '#page-runs?runs-runs-source.run-conclusion=failure'
      }
    };
  });

  dispatches.bind(() => {
    const dispatchCount = metrics.dispatches();
    const failedDispatches = metrics.failedDispatches();
    return {
      pending: sources['overview-dispatch-summary'].pending(),
      label: label('dispatches', dispatchCount),
      value: dispatchCount,
      detail: {
        text: `${formatCount(failedDispatches)} failed`,
        href: '#page-dispatches?campaign-worker-dispatches.status=failure'
      }
    };
  });

  valueGains.bind(() => {
    const gains = metrics.valueGains();
    return {
      pending: sources['overview-value-summary'].pending(),
      label: label('value-gains', gains),
      value: gains,
      detail: { text: '' }
    };
  });

  const stations = [
    { id: 'repositories', element: repositories.element },
    { id: 'runs', element: runs.element },
    { id: 'dispatches', element: dispatches.element },
    { id: 'value-gains', element: valueGains.element }
  ];
  const floor = renderReactiveGrid({
    className: 'factory-floor',
    activeClassName: 'factory-floor-active',
    listClassName: 'factory-stations',
    items: () => stations,
    key: (station) => station.id,
    renderItem: (station) => station.element,
    active: () => scope.motion.get().operations > 0,
    ariaLabel: () => {
      const coverage = metrics.coverage();
      const successfulRuns = metrics.successfulRuns();
      const dispatchCount = metrics.dispatches();
      const workers = metrics.workers();
      const gains = metrics.valueGains();
      const usefulOutputs = metrics.usefulOutputs();
    const repositoriesDescription = coverage.registeredUnavailable
      ? 'Registered repositories unavailable'
      : `${formatCount(coverage.registered)} ${label('repositories', coverage.registered).toLowerCase()}${coverage.unavailable ? '; repository delivery evidence unavailable' : ` with ${formatCount(coverage.total)} delivered to`}`;
      return `${repositoriesDescription}, ${formatCount(successfulRuns)} ${label('successful-runs', successfulRuns).toLowerCase()}, ${formatCount(dispatchCount)} workflow ${label('dispatches', dispatchCount).toLowerCase()} across ${formatCount(workers)} ${workers === 1 ? 'worker' : 'workers'}, ${formatCount(gains)} grader ${gains === 1 ? 'value' : 'values'} above threshold, and ${formatCount(usefulOutputs)} issue or pull request ${usefulOutputs === 1 ? 'output' : 'outputs'}.`;
    },
    signal: scope.signal
  });
  floor.append(renderFactoryCampaigns(sources['campaign-inventory'], scope, 'Campains'));
  return floor;
}

const FLOOR_SOURCE_NAMES = [
  'overview-outcome-summary',
  'overview-run-summary',
  'overview-dispatch-summary',
  'overview-delivery-summary',
  'overview-value-summary',
  'overview-registered-repository-summary',
  'overview-worker-summary',
  'campaign-inventory'
];

/**
 * Renders the JSON-selected factory floor from its declared query payloads.
 * @param {import('./ui-elements.js').ElementRenderContext} context
 */
export function renderFactoryFloorElement(context) {
  const sources = bindFactorySources(context.sources, FLOOR_SOURCE_NAMES, {
    pageId: context.pageId,
    viewId: context.viewId,
    viewIndex: context.viewIndex,
    sourceNames: context.sourceNames,
    queryContext: context.queryContext
  });
  const metrics = createFactoryMetrics(sources);
  const scope = createFactoryScope(metrics);
  const rendered = renderFactoryFloor(
    sources,
    metrics,
    factoryStationLabel(context.elementConfig),
    context.elementConfig?.animate === 'number',
    scope
  );
  scope.bind(rendered);
  return rendered;
}

/**
 * @param {SourceBinding | undefined} source
 * @param {FactoryFloorScope} scope
 * @param {string} heading
 */
function renderFactoryCampaigns(source, scope, heading) {
  const cards = keyed([], renderFactoryCampaignCard, (row, index) => String(row.campaign ?? index));
  const list = h('ol', { className: 'factory-campaign-list entity-card-list-grid' }, cards);
  const empty = h('p', { className: 'factory-campaign-empty' }, 'No campaigns discovered.');
  const root = h(
    'section',
    { className: 'factory-campaigns', 'aria-labelledby': 'factory-campaigns-heading' },
    h('h3', { id: 'factory-campaigns-heading' }, heading),
    list,
    empty
  );
  effect(() => {
    const rows = source?.rows() ?? [];
    cards.items = rows;
    cards.render();
    const pending = source?.pending() ?? false;
    root.toggleAttribute('aria-busy', pending);
    empty.hidden = pending || rows.length > 0;
    empty.textContent = source?.unavailable() ? 'Campaign data is unavailable.' : 'No campaigns discovered.';
  }, { signal: scope.signal });
  return root;
}

/** @param {Record<string, unknown>} row */
function renderFactoryCampaignCard(row) {
  const name = String(row['campaign-name'] ?? row.campaign ?? 'Campaign');
  const link = findLink(row, 'campaign-dashboard-link');
  const title = link ? h('a', { href: link.href }, name) : name;
  const details = [
    ['Workflows', row.workflows],
    ['Runs', row.runs],
    ['Dispatches', row.dispatches],
    ['AIC', row.aic]
  ];
  return h(
    'li',
    { className: 'issue-list-card entity-card-list-card' },
    h('span', { className: 'issue-list-card-icon', 'aria-hidden': 'true' }, octicon('goal')),
    h(
      'div',
      { className: 'issue-list-card-content' },
      h('div', { className: 'issue-list-card-title entity-card-list-title' }, title),
      h(
        'dl',
        { className: 'issue-list-card-meta', 'aria-label': `${name} metrics` },
        details.map(([label, value]) => h('div', null, h('dt', null, label), h('dd', null, formatCount(Number(value) || 0))))
      )
    )
  );
}