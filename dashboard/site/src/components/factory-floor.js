import { formatCount } from './count-formatters.js';
import { bindFactorySources, createFactoryMetrics, createFactoryScope, factoryStationLabel, resolveFactorySourceNames } from './factory-elements.js';
import { renderFactoryStation } from './factory-station.js';
import { renderReactiveGrid } from './reactive-grid.js';

/** @typedef {{ operations: number, live: number, review: number }} Motion */
/** @typedef {{ rows: () => Record<string, unknown>[], pending: () => boolean, unavailable: () => boolean }} SourceBinding */
/** @typedef {Record<string, SourceBinding>} SourceBindings */
/** @typedef {{ total: number, registered: number, averageCoverage: number, unavailable: boolean, registeredUnavailable: boolean, coverageUnavailable: boolean }} Coverage */
/** @typedef {{ campaigns: () => number, campaignTotal: () => number, campaignHealth: () => number, issues: () => number, successfulRuns: () => number, failedRuns: () => number, activeRuns: () => number, valueGains: () => number, coverage: () => Coverage, workers: () => number, dispatches: () => number, failedDispatches: () => number, usefulOutputs: () => number, deliveredRepositories: () => number, motion: () => Motion }} OverviewMetrics */
/** @typedef {{ signal: AbortSignal, motion: import('../reactive.js').State<Motion> }} FactoryFloorScope */
/** @typedef {'campaigns'|'repositories'|'issues'|'successful-runs'|'dispatches'|'value-gains'} FactoryStationId */

/**
 * @param {SourceBindings} sources
 * @param {OverviewMetrics} metrics
 * @param {(labelId: string, count: number) => string} label
 * @param {boolean} animateNumbers
 * @param {FactoryFloorScope} scope
 * @param {Record<string, string>} roleNames
 * @param {FactoryStationId[]} [selectedStations]
 */
export function renderFactoryFloor(sources, metrics, label, animateNumbers, scope, roleNames, selectedStations) {
  const campaigns = renderFactoryStation('organization', { animate: animateNumbers, format: 'percent', href: '#page-campaigns', signal: scope.signal });
  const repositories = renderFactoryStation('repo', { animate: animateNumbers, format: 'percent', href: '#page-repositories', signal: scope.signal });
  const issues = renderFactoryStation('issue', { animate: animateNumbers, href: '#page-issues', signal: scope.signal });
  const runs = renderFactoryStation('play', { animate: animateNumbers, href: '#page-runs?runs-runs-source.run-conclusion=success', signal: scope.signal });
  const dispatches = renderFactoryStation('workflow', { animate: animateNumbers, href: '#page-runs', signal: scope.signal });
  const valueGains = renderFactoryStation('trophy', { animate: animateNumbers, final: true, href: '#page-usage', signal: scope.signal });

  campaigns.bind(() => {
    const count = metrics.campaigns();
    const total = metrics.campaignTotal();
    return {
      pending: sources[roleNames['healthy-campaigns']]?.pending() ?? true,
      unavailable: sources[roleNames['healthy-campaigns']]?.unavailable() ?? true,
      label: 'Campaign health',
      value: total > 0 ? count / total : 0,
      detail: { text: `${formatCount(count)}/${formatCount(total)} healthy campaigns` }
    };
  });

  repositories.bind(() => {
    const coverage = metrics.coverage();
    return {
      pending: sources[roleNames['repository-coverage']]?.pending() ?? true,
      unavailable: coverage.coverageUnavailable,
      label: 'Repository coverage',
      value: coverage.averageCoverage,
      detail: { text: `${formatCount(coverage.total)}/${formatCount(coverage.registered)} repositories reached` }
    };
  });

  issues.bind(() => {
    const count = metrics.issues();
    return {
      pending: sources[roleNames.issues].pending(),
      unavailable: sources[roleNames.issues].unavailable(),
      label: label('issues', count),
      value: count,
      detail: { text: '' }
    };
  });

  runs.bind(() => {
    const successfulRuns = metrics.successfulRuns();
    const failedRuns = metrics.failedRuns();
    return {
      pending: sources[roleNames['run-summary']].pending(),
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
      pending: sources[roleNames['dispatch-summary']].pending(),
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
      pending: sources[roleNames['value-summary']].pending(),
      label: label('value-gains', gains),
      value: gains,
      detail: { text: '' }
    };
  });

  /** @type {Array<{ id: FactoryStationId, element: HTMLElement }>} */
  const allStations = [
    { id: 'campaigns', element: campaigns.element },
    { id: 'repositories', element: repositories.element },
    { id: 'issues', element: issues.element },
    { id: 'successful-runs', element: runs.element },
    { id: 'dispatches', element: dispatches.element },
    { id: 'value-gains', element: valueGains.element }
  ];
  const stationById = new Map(allStations.map((station) => [station.id, station]));
  const stationOrder = selectedStations?.length ? [...new Set(selectedStations)] : allStations.map(({ id }) => id);
  const stations = stationOrder.map((id) => stationById.get(id)).filter((station) => station !== undefined);
  /** @type {Record<FactoryStationId, () => string>} */
  const stationDescriptions = {
    campaigns: () => {
      return `${Math.round(metrics.campaignHealth() * 100)}% campaign health`;
    },
    repositories: () => {
      const coverage = metrics.coverage();
      return coverage.coverageUnavailable
        ? 'Repository coverage unavailable'
        : `${Math.round(coverage.averageCoverage * 100)}% average repository coverage`;
    },
    issues: () => {
      const count = metrics.issues();
      return `${formatCount(count)} ${label('issues', count).toLowerCase()}`;
    },
    'successful-runs': () => {
      const count = metrics.successfulRuns();
      return `${formatCount(count)} ${label('successful-runs', count).toLowerCase()}`;
    },
    dispatches: () => {
      const count = metrics.dispatches();
      const workers = metrics.workers();
      return `${formatCount(count)} workflow ${label('dispatches', count).toLowerCase()} across ${formatCount(workers)} ${workers === 1 ? 'worker' : 'workers'}`;
    },
    'value-gains': () => {
      const gains = metrics.valueGains();
      const usefulOutputs = metrics.usefulOutputs();
      return `${formatCount(gains)} grader ${gains === 1 ? 'value' : 'values'} above threshold, and ${formatCount(usefulOutputs)} issue or pull request ${usefulOutputs === 1 ? 'output' : 'outputs'}`;
    }
  };
  return renderReactiveGrid({
    className: stations.length <= 2 ? 'factory-floor factory-floor-compact' : 'factory-floor',
    activeClassName: 'factory-floor-active',
    listClassName: 'factory-stations',
    items: () => stations,
    key: (station) => station.id,
    renderItem: (station) => station.element,
    active: () => scope.motion.get().operations > 0,
    ariaLabel: () => `${stations.map(({ id }) => stationDescriptions[id]()).join(', ')}.`,
    signal: scope.signal
  });
}

/**
 * Default role-to-source-name bindings for the overview page. A view may
 * override any entry through `config.sources` to bind the same element to
 * differently named sources.
 * @type {Record<string, string>}
 */
export const FLOOR_DEFAULT_SOURCES = {
  campaigns: 'database-campaign-count',
  'healthy-campaigns': 'overview-healthy-campaign-count',
  'registered-repository-summary': 'overview-registered-repository-summary',
  'repository-coverage': 'overview-repository-coverage',
  issues: 'database-issue-count',
  'outcome-summary': 'overview-outcome-summary',
  'run-summary': 'overview-run-summary',
  'dispatch-summary': 'overview-dispatch-summary',
  'delivery-summary': 'overview-delivery-summary',
  'value-summary': 'overview-value-summary',
  'worker-summary': 'overview-worker-summary'
};

/**
 * Renders the JSON-selected factory floor from its declared query payloads.
 * @param {import('./ui-elements.js').ElementRenderContext} context
 */
export function renderFactoryFloorElement(context) {
  const roleNames = resolveFactorySourceNames(FLOOR_DEFAULT_SOURCES, context.elementConfig);
  const sources = bindFactorySources(context.sources, Object.values(roleNames), {
    pageId: context.pageId,
    viewId: context.viewId,
    viewIndex: context.viewIndex,
    sourceNames: context.sourceNames,
    queryContext: context.queryContext
  });
  const metrics = createFactoryMetrics(sources, roleNames);
  const scope = createFactoryScope(metrics);
  const rendered = renderFactoryFloor(
    sources,
    metrics,
    factoryStationLabel(context.elementConfig),
    context.elementConfig?.animate === 'number',
    scope,
    roleNames,
    Array.isArray(context.elementConfig?.stations)
      ? /** @type {FactoryStationId[]} */ (context.elementConfig.stations.filter((station) => typeof station === 'string'))
      : undefined
  );
  scope.bind(rendered);
  return rendered;
}
