import { formatCount } from './count-formatters.js';
import { bindFactorySources, createFactoryMetrics, createFactoryScope, factoryStationLabel } from './factory-elements.js';
import { renderFactoryStation } from './factory-station.js';
import { renderReactiveGrid } from './reactive-grid.js';

/** @typedef {{ operations: number, live: number, review: number }} Motion */
/** @typedef {{ rows: () => Record<string, unknown>[], pending: () => boolean, unavailable: () => boolean }} SourceBinding */
/** @typedef {Record<string, SourceBinding>} SourceBindings */
/** @typedef {{ total: number, registered: number, unavailable: boolean, registeredUnavailable: boolean }} Coverage */
/** @typedef {{ campaigns: () => number, issues: () => number, successfulRuns: () => number, failedRuns: () => number, activeRuns: () => number, valueGains: () => number, coverage: () => Coverage, workers: () => number, dispatches: () => number, failedDispatches: () => number, usefulOutputs: () => number, deliveredRepositories: () => number, motion: () => Motion }} OverviewMetrics */
/** @typedef {{ signal: AbortSignal, motion: import('../reactive.js').State<Motion> }} FactoryFloorScope */

/**
 * @param {SourceBindings} sources
 * @param {OverviewMetrics} metrics
 * @param {(labelId: string, count: number) => string} label
 * @param {boolean} animateNumbers
 * @param {FactoryFloorScope} scope
 */
export function renderFactoryFloor(sources, metrics, label, animateNumbers, scope) {
  const campaigns = renderFactoryStation('project', { animate: animateNumbers, href: '#page-campaigns', signal: scope.signal });
  const repositories = renderFactoryStation('repo', { animate: animateNumbers, href: '#page-repositories', signal: scope.signal });
  const issues = renderFactoryStation('issue', { animate: animateNumbers, href: '#page-issues', signal: scope.signal });
  const runs = renderFactoryStation('play', { animate: animateNumbers, href: '#page-runs?runs-runs-source.run-conclusion=success', signal: scope.signal });
  const dispatches = renderFactoryStation('workflow', { animate: animateNumbers, href: '#page-runs', signal: scope.signal });
  const valueGains = renderFactoryStation('trophy', { animate: animateNumbers, final: true, href: '#page-usage', signal: scope.signal });

  campaigns.bind(() => {
    const count = metrics.campaigns();
    return {
      pending: sources['database-campaign-count'].pending(),
      unavailable: sources['database-campaign-count'].unavailable(),
      label: label('campaigns', count),
      value: count,
      detail: { text: '' }
    };
  });

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

  issues.bind(() => {
    const count = metrics.issues();
    return {
      pending: sources['database-issue-count'].pending(),
      unavailable: sources['database-issue-count'].unavailable(),
      label: label('issues', count),
      value: count,
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
    { id: 'campaigns', element: campaigns.element },
    { id: 'repositories', element: repositories.element },
    { id: 'issues', element: issues.element },
    { id: 'runs', element: runs.element },
    { id: 'dispatches', element: dispatches.element },
    { id: 'value-gains', element: valueGains.element }
  ];
  return renderReactiveGrid({
    className: 'factory-floor',
    activeClassName: 'factory-floor-active',
    listClassName: 'factory-stations',
    items: () => stations,
    key: (station) => station.id,
    renderItem: (station) => station.element,
    active: () => scope.motion.get().operations > 0,
    ariaLabel: () => {
      const campaignCount = metrics.campaigns();
      const coverage = metrics.coverage();
      const issueCount = metrics.issues();
      const successfulRuns = metrics.successfulRuns();
      const dispatchCount = metrics.dispatches();
      const workers = metrics.workers();
      const gains = metrics.valueGains();
      const usefulOutputs = metrics.usefulOutputs();
      const repositoriesDescription = coverage.registeredUnavailable
        ? 'Repositories unavailable'
        : `${formatCount(coverage.registered)} ${label('repositories', coverage.registered).toLowerCase()}${coverage.unavailable ? '; repository delivery evidence unavailable' : ` with ${formatCount(coverage.total)} delivered to`}`;
      return `${formatCount(campaignCount)} ${label('campaigns', campaignCount).toLowerCase()}, ${repositoriesDescription}, ${formatCount(issueCount)} ${label('issues', issueCount).toLowerCase()}, ${formatCount(successfulRuns)} ${label('successful-runs', successfulRuns).toLowerCase()}, ${formatCount(dispatchCount)} workflow ${label('dispatches', dispatchCount).toLowerCase()} across ${formatCount(workers)} ${workers === 1 ? 'worker' : 'workers'}, ${formatCount(gains)} grader ${gains === 1 ? 'value' : 'values'} above threshold, and ${formatCount(usefulOutputs)} issue or pull request ${usefulOutputs === 1 ? 'output' : 'outputs'}.`;
    },
    signal: scope.signal
  });
}

const FLOOR_SOURCE_NAMES = [
  'database-campaign-count',
  'overview-registered-repository-summary',
  'database-issue-count',
  'overview-outcome-summary',
  'overview-run-summary',
  'overview-dispatch-summary',
  'overview-delivery-summary',
  'overview-value-summary',
  'overview-worker-summary'
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
