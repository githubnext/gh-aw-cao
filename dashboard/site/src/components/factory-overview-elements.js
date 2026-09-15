import { h } from '../dom.js';
import { octicon } from '../octicons.js';
import { render, state } from '../reactive.js';
import { createAnimatedNumber } from './animated-number.js';
import { formatCount } from './count-formatters.js';

/** @typedef {Record<string, unknown>} Row */
/** @typedef {{ label: string, date: string, count: number, previous: number, reached: boolean }} RhythmDay */
/** @typedef {{ operations: number, live: number, review: number }} Motion */
/** @typedef {{ rows: () => Row[], pending: () => boolean, unavailable: () => boolean }} SourceBinding */
/** @typedef {Record<string, SourceBinding>} SourceBindings */
/** @typedef {{ total: number, registered: number, unavailable: boolean, registeredUnavailable: boolean }} Coverage */
/** @typedef {{ successfulRuns: () => number, failedRuns: () => number, activeRuns: () => number, valueGains: () => number, coverage: () => Coverage, workers: () => number, dispatches: () => number, failedDispatches: () => number, usefulOutputs: () => number, deliveredRepositories: () => number, motion: () => Motion }} OverviewMetrics */
/** @typedef {{ signal: AbortSignal, bind: (render: () => void) => void, memo: <T>(compute: () => T) => () => T }} ElementRuntime */

/**
 * Creates the reusable presentation elements for one factory overview render.
 * Query binding and source ownership remain with the parent UI element.
 * @param {ElementRuntime} runtime
 */
export function createFactoryOverviewElements(runtime) {
  const motionState = state(/** @type {Motion} */ ({ operations: 0, live: 0, review: 0 }));

  return {
    /** @param {SourceBindings} sources @param {OverviewMetrics} metrics */
    renderIntroduction(sources, metrics) {
      return renderFactoryIntroduction(runtime, motionState, sources, metrics);
    },
    /**
     * @param {{ sources: SourceBindings, metrics: OverviewMetrics, label: (labelId: string, count: number) => string, animateNumbers: boolean }} options
     */
    renderFloor(options) {
      return renderFactoryFloor(runtime, motionState, options);
    }
  };
}

/**
 * @param {ElementRuntime} runtime
 * @param {import('../reactive.js').State<Motion>} motionState
 * @param {SourceBindings} sources
 * @param {OverviewMetrics} metrics
 */
function renderFactoryIntroduction(runtime, motionState, sources, metrics) {
  const running = h('p', { className: 'factory-running' });
  const heading = h('h2', { id: 'agent-factory-heading' });
  const summary = h('p', {});

  runtime.bind(() => {
    const motion = metrics.motion();
    motionState.set((current) => sameMotion(current, motion) ? current : motion);
  });

  runtime.bind(() => {
    const motion = motionState.get();
    running.className = `factory-running${motion.operations > 0 ? ' factory-running-active' : ''}`;
    running.replaceChildren(
      motion.operations > 0 ? h('span', {}, 'Work in motion') : 'Actions activity observed'
    );
  });

  runtime.bind(() => {
    heading.textContent = factoryHeading(sources, metrics);
  });

  runtime.bind(() => {
    const usefulOutputs = metrics.usefulOutputs();
    const deliveredRepositories = metrics.deliveredRepositories();
    summary.hidden = usefulOutputs === 0;
    summary.textContent = usefulOutputs > 0
      ? `${formatCount(usefulOutputs)} retained issue and pull request ${usefulOutputs === 1 ? 'output is' : 'outputs are'} backed by Actions evidence${deliveredRepositories > 0 ? ` across ${formatCount(deliveredRepositories)} ${deliveredRepositories === 1 ? 'repository' : 'repositories'}` : ''}.`
      : '';
  });

  return h(
    'header',
    { className: 'factory-intro' },
    h('div', { className: 'factory-intro-copy' }, running, heading, summary),
    renderFactoryRhythm(runtime, sources['overview-rhythm'])
  );
}

/** @param {Motion} current @param {Motion} next */
function sameMotion(current, next) {
  return current.operations === next.operations
    && current.live === next.live
    && current.review === next.review;
}

/** @param {SourceBindings} sources @param {OverviewMetrics} metrics */
function factoryHeading(sources, metrics) {
  if (sources['overview-run-summary'].unavailable()) {
    return 'Your factory status is unavailable.';
  }
  const successfulRuns = metrics.successfulRuns();
  const failedRuns = metrics.failedRuns();
  const activeRuns = metrics.activeRuns();
  if (metrics.valueGains() > 0) return 'Your factory is delivering value.';
  if (activeRuns > 0) return 'Your factory is humming.';
  if (failedRuns > successfulRuns && failedRuns > 0) return 'Your factory is under strain.';
  if (failedRuns > 0) return 'Your factory needs attention.';
  if (successfulRuns > 0) return 'Your factory is humming.';
  return 'Your factory is idle.';
}

/**
 * @param {ElementRuntime} runtime
 * @param {import('../reactive.js').State<Motion>} motionState
 * @param {{ sources: SourceBindings, metrics: OverviewMetrics, label: (labelId: string, count: number) => string, animateNumbers: boolean }} options
 */
function renderFactoryFloor(runtime, motionState, { sources, metrics, label, animateNumbers }) {
  const floor = h('section', { className: 'factory-floor' });
  const repositories = renderFactoryStation(runtime, 'repo', { animate: animateNumbers, href: '#page-repositories' });
  const runs = renderFactoryStation(runtime, 'play', { animate: animateNumbers, href: '#page-runs?runs-runs-source.run-conclusion=success' });
  const dispatches = renderFactoryStation(runtime, 'workflow', { animate: animateNumbers, href: '#page-runs' });
  const valueGains = renderFactoryStation(runtime, 'trophy', { animate: animateNumbers, final: true });

  repositories.bind(() => {
    const coverage = metrics.coverage();
    return {
      pending: sources['overview-registered-repository-summary'].pending(),
      unavailable: coverage.registeredUnavailable,
      label: label('repositories', coverage.registered),
      value: coverage.registered,
      detail: ''
    };
  });

  runs.bind(() => {
    const successfulRuns = metrics.successfulRuns();
    const failedRuns = metrics.failedRuns();
    return {
      pending: sources['overview-run-summary'].pending(),
      label: label('successful-runs', successfulRuns),
      value: successfulRuns,
      detail: h('a', { href: '#page-runs?runs-runs-source.run-conclusion=failure' }, `${formatCount(failedRuns)} failed`)
    };
  });

  dispatches.bind(() => {
    const dispatchCount = metrics.dispatches();
    const failedDispatches = metrics.failedDispatches();
    return {
      pending: sources['overview-dispatch-summary'].pending(),
      label: label('dispatches', dispatchCount),
      value: dispatchCount,
      detail: h(
        'a',
        { href: '#page-dispatches?package-worker-dispatches.status=failure' },
        `${formatCount(failedDispatches)} failed`
      )
    };
  });

  valueGains.bind(() => {
    const gains = metrics.valueGains();
    return {
      pending: sources['overview-value-summary'].pending(),
      label: label('value-gains', gains),
      value: gains,
      detail: 'Coming soon'
    };
  });

  runtime.bind(() => {
    const coverage = metrics.coverage();
    const successfulRuns = metrics.successfulRuns();
    const dispatchCount = metrics.dispatches();
    const workers = metrics.workers();
    const gains = metrics.valueGains();
    const usefulOutputs = metrics.usefulOutputs();
    const activeRuns = motionState.get().operations;
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

/**
 * Renders one reusable counter that owns its reactive DOM updates.
 * @param {ElementRuntime} runtime
 * @param {string} icon
 * @param {{ animate?: boolean, final?: boolean, href?: string }} [options]
 * @returns {{ element: HTMLElement, bind: (read: () => { pending: boolean, unavailable?: boolean, label: string, value: number, detail: string | HTMLElement }) => void }}
 */
export function renderFactoryStation(runtime, icon, options = {}) {
  const element = h('li', { className: 'factory-station' });
  const value = createAnimatedNumber({ animate: options.animate, signal: runtime.signal });
  return {
    element,
    bind(read) {
      render(element, () => {
        const station = read();
        element.className = `factory-station${options.final ? ' factory-station-final' : ''}`
          + `${station.pending ? ' factory-station-pending' : ''}`
          + `${!station.pending && !station.unavailable && station.value === 0 ? ' factory-station-empty' : ''}`;
        if (station.pending) element.setAttribute('aria-busy', 'true');
        else element.removeAttribute('aria-busy');
        const count = station.pending ? '' : station.unavailable ? 'Unavailable' : formatCount(station.value);
        value.set({
          text: count,
          target: !station.pending && !station.unavailable ? station.value : undefined,
          href: options.href && !station.pending && !station.unavailable ? options.href : undefined
        });
        return [
          h('span', { className: 'factory-station-icon', 'aria-hidden': 'true' }, octicon(icon)),
          h('span', {}, station.label),
          value.element,
          h('small', {}, station.pending ? '' : station.detail)
        ];
      }, { signal: runtime.signal });
    }
  };
}

/** @param {ElementRuntime} runtime @param {SourceBinding} source */
export function renderFactoryRhythm(runtime, source) {
  const bars = h('div', { className: 'factory-rhythm-bars' });
  const rhythmDays = runtime.memo(() => rhythmPayload(source).days);
  const section = h(
    'section',
    {
      className: 'factory-rhythm',
      'aria-label': 'Successful Actions runs from Monday through Sunday'
    },
    h(
      'div',
      { className: 'factory-rhythm-heading' },
      h('span', {}, 'Factory rhythm'),
      h(
        'ul',
        { className: 'factory-rhythm-legend', 'aria-label': 'Factory rhythm legend' },
        h('li', {}, h('i', { className: 'factory-rhythm-legend-current', 'aria-hidden': 'true' }), 'This week'),
        h('li', {}, h('i', { className: 'factory-rhythm-legend-previous', 'aria-hidden': 'true' }), 'Last week')
      )
    ),
    bars
  );

  runtime.bind(() => {
    const days = rhythmDays();
    const maximum = Math.max(...days.flatMap((day) => [day.count, day.previous]), 1);
    if (bars.childElementCount !== days.length) {
      bars.replaceChildren(...days.map(() => createRhythmDay()));
    }
    for (const [index, element] of rhythmDayElements(bars).entries()) {
      const day = days[index];
      const value = day.reached ? day.count : day.previous;
      const description = rhythmDayDescription(day);
      element.classList.toggle('factory-rhythm-day-future', !day.reached);
      element.setAttribute('aria-label', description);
      element.title = description;
      const current = element.querySelector('.factory-rhythm-current');
      if (current instanceof HTMLElement) {
        current.hidden = !day.reached;
        current.style.height = `${Math.max(5, value / maximum * 100)}%`;
      }
      const baseline = element.querySelector('.factory-rhythm-baseline');
      if (baseline instanceof HTMLElement) {
        baseline.hidden = day.reached;
        baseline.style.height = `${Math.max(5, value / maximum * 100)}%`;
      }
      const label = element.querySelector('small');
      if (label) label.textContent = day.label;
    }
  });

  return section;
}

/** @param {RhythmDay} day */
function rhythmDayDescription(day) {
  const count = day.reached ? day.count : day.previous;
  const period = day.reached ? 'this week' : 'last week';
  return `${day.label} ${day.date}: ${formatCount(count)} successful ${count === 1 ? 'run' : 'runs'} ${period}.`;
}

/** @param {SourceBinding} source @returns {{ days: RhythmDay[] }} */
function rhythmPayload(source) {
  const row = source.rows()[0];
  const value = row?.rhythm;
  const configured = value && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : {};
  const input = Array.isArray(configured.days) ? configured.days : [];
  const days = input.flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return [];
    const day = /** @type {Record<string, unknown>} */ (candidate);
    if (typeof day.label !== 'string' || typeof day.date !== 'string' || typeof day.reached !== 'boolean') return [];
    return [{
      label: day.label,
      date: day.date,
      count: numberField(day, 'current'),
      previous: numberField(day, 'previous'),
      reached: day.reached
    }];
  });
  return {
    days: days.length === 7
      ? days
      : ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((label) => ({
          label,
          date: '',
          count: 0,
          previous: 0,
          reached: false
        }))
  };
}

/** @param {Row} row @param {string} field */
function numberField(row, field) {
  const value = Number(row[field]);
  return Number.isFinite(value) ? value : 0;
}

/** @param {HTMLElement} bars @returns {HTMLElement[]} */
function rhythmDayElements(bars) {
  return [...bars.querySelectorAll('.factory-rhythm-day')].filter((element) => element instanceof HTMLElement);
}

function createRhythmDay() {
  return h(
    'div',
    {
      className: 'factory-rhythm-day',
      role: 'img'
    },
    h('span', { className: 'factory-rhythm-bar-pair', 'aria-hidden': 'true' },
      h('i', { className: 'factory-rhythm-baseline' }),
      h('i', { className: 'factory-rhythm-current' })
    ),
    h('small', {})
  );
}
