import { h } from '../dom.js';
import { formatCount } from './count-formatters.js';
import { renderFactoryStation } from './factory-station.js';

/** @typedef {{ operations: number, live: number, review: number }} Motion */
/** @typedef {{ rows: () => Record<string, unknown>[], pending: () => boolean, unavailable: () => boolean }} SourceBinding */
/** @typedef {Record<string, SourceBinding>} SourceBindings */
/** @typedef {{ total: number, registered: number, unavailable: boolean, registeredUnavailable: boolean }} Coverage */
/** @typedef {{ successfulRuns: () => number, failedRuns: () => number, activeRuns: () => number, valueGains: () => number, coverage: () => Coverage, workers: () => number, dispatches: () => number, failedDispatches: () => number, usefulOutputs: () => number, deliveredRepositories: () => number, motion: () => Motion }} OverviewMetrics */
/** @typedef {{ bind: (render: () => void) => void, signal: AbortSignal, motion: import('../reactive.js').State<Motion> }} FactoryFloorScope */

/**
 * @param {SourceBindings} sources
 * @param {OverviewMetrics} metrics
 * @param {(labelId: string, count: number) => string} label
 * @param {boolean} animateNumbers
 * @param {FactoryFloorScope} scope
 */
export function renderFactoryFloor(sources, metrics, label, animateNumbers, scope) {
  const floor = h('section', { className: 'factory-floor' });
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
        href: '#page-dispatches?package-worker-dispatches.status=failure'
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

  scope.bind(() => {
    const coverage = metrics.coverage();
    const successfulRuns = metrics.successfulRuns();
    const dispatchCount = metrics.dispatches();
    const workers = metrics.workers();
    const gains = metrics.valueGains();
    const usefulOutputs = metrics.usefulOutputs();
    const activeRuns = scope.motion.get().operations;
    floor.className = `factory-floor${activeRuns > 0 ? ' factory-floor-active' : ''}`;
    const repositoriesDescription = coverage.registeredUnavailable
      ? 'Registered repositories unavailable'
      : `${formatCount(coverage.registered)} ${label('repositories', coverage.registered).toLowerCase()}${coverage.unavailable ? '; repository delivery evidence unavailable' : ` with ${formatCount(coverage.total)} delivered to`}`;
    floor.setAttribute(
      'aria-label',
      `${repositoriesDescription}, ${formatCount(successfulRuns)} ${label('successful-runs', successfulRuns).toLowerCase()}, ${formatCount(dispatchCount)} workflow ${label('dispatches', dispatchCount).toLowerCase()} across ${formatCount(workers)} ${workers === 1 ? 'worker' : 'workers'}, ${formatCount(gains)} grader ${gains === 1 ? 'value' : 'values'} above threshold, and ${formatCount(usefulOutputs)} issue or pull request ${usefulOutputs === 1 ? 'output' : 'outputs'}.`
    );
  });

  floor.append(h(
    'ol',
    { className: 'factory-stations' },
    repositories.element,
    runs.element,
    dispatches.element,
    valueGains.element
  ));
  return floor;
}