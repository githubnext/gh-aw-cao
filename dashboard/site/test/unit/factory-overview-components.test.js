// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { state } from '../../src/reactive.js';
import { renderFactoryFloor } from '../../src/components/factory-floor.js';
import { renderFactoryHeader } from '../../src/components/factory-header.js';
import { renderFactoryRhythm } from '../../src/components/factory-rhythm.js';
import { renderFactoryStation } from '../../src/components/factory-station.js';

/** @typedef {{ operations: number, live: number, review: number }} Motion */
/** @typedef {{ total: number, registered: number, unavailable: boolean, registeredUnavailable: boolean }} Coverage */
/** @typedef {{ successfulRuns: () => number, failedRuns: () => number, activeRuns: () => number, valueGains: () => number, coverage: () => Coverage, workers: () => number, dispatches: () => number, failedDispatches: () => number, usefulOutputs: () => number, deliveredRepositories: () => number, motion: () => Motion }} TestMetrics */

/** @returns {{ bind: (render: () => void) => void, memo: <T>(compute: () => T) => () => T }} */
function immediateScope() {
  return {
    bind(render) { render(); },
    memo(compute) { return compute; }
  };
}

/**
 * @param {{ pending?: boolean, unavailable?: boolean, rows?: Record<string, unknown>[] }} [options]
 */
function binding({ pending = false, unavailable = false, rows = [] } = {}) {
  return {
    rows: () => rows,
    pending: () => pending,
    unavailable: () => unavailable
  };
}

/**
 * @param {Partial<{ successfulRuns: number, failedRuns: number, activeRuns: number, valueGains: number, coverage: Coverage, workers: number, dispatches: number, failedDispatches: number, usefulOutputs: number, deliveredRepositories: number, motion: Motion }>} [overrides]
 * @returns {TestMetrics}
 */
function metrics(overrides = {}) {
  const values = {
    successfulRuns: 8,
    failedRuns: 2,
    activeRuns: 1,
    valueGains: 3,
    coverage: { total: 4, registered: 6, unavailable: false, registeredUnavailable: false },
    workers: 2,
    dispatches: 7,
    failedDispatches: 1,
    usefulOutputs: 5,
    deliveredRepositories: 4,
    motion: { operations: 1, live: 1, review: 0 },
    ...overrides
  };
  return {
    successfulRuns: () => values.successfulRuns,
    failedRuns: () => values.failedRuns,
    activeRuns: () => values.activeRuns,
    valueGains: () => values.valueGains,
    coverage: () => values.coverage,
    workers: () => values.workers,
    dispatches: () => values.dispatches,
    failedDispatches: () => values.failedDispatches,
    usefulOutputs: () => values.usefulOutputs,
    deliveredRepositories: () => values.deliveredRepositories,
    motion: () => values.motion
  };
}

/** @returns {Record<string, unknown>[]} */
function rhythmRows() {
  return [{
    rhythm: {
      days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((label, index) => ({
        label,
        date: `2026-09-${String(7 + index).padStart(2, '0')}`,
        current: index + 1,
        previous: 7 - index,
        reached: index < 3
      }))
    }
  }];
}

describe('Overview component boundaries', () => {
  it('station owns pending, unavailable, linked, and detail presentation', () => {
    const controller = new AbortController();
    const stationState = state({
      pending: true,
      unavailable: false,
      label: 'Successful runs',
      value: 0,
      detail: ''
    });
    const station = renderFactoryStation('play', { href: '#page-runs', signal: controller.signal });
    station.bind(stationState.get);

    expect(station.element.getAttribute('aria-busy')).toBe('true');
    expect(station.element.classList.contains('factory-station-pending')).toBe(true);

    stationState.set({ pending: false, unavailable: false, label: 'Successful runs', value: 8, detail: '2 failed' });
    expect(station.element.querySelector('strong a')?.getAttribute('href')).toBe('#page-runs');
    expect(station.element.querySelector('strong')?.textContent).toBe('8');
    expect(station.element.querySelector('small')?.textContent).toBe('2 failed');

    stationState.set({ pending: false, unavailable: true, label: 'Successful runs', value: 0, detail: '' });
    expect(station.element.querySelector('strong')?.textContent).toBe('Unavailable');
    expect(station.element.querySelector('strong a')).toBeNull();
    controller.abort();
  });

  it('station stops reacting after its owner aborts', () => {
    const controller = new AbortController();
    const stationState = state({ pending: false, unavailable: false, label: 'Runs', value: 1, detail: '' });
    const station = renderFactoryStation('play', { signal: controller.signal });
    station.bind(stationState.get);

    expect(station.element.querySelector('strong')?.textContent).toBe('1');
    controller.abort();
    stationState.set({ pending: false, unavailable: false, label: 'Runs', value: 9, detail: '' });
    expect(station.element.querySelector('strong')?.textContent).toBe('1');
  });

  it('rhythm owns the seven-day chart, period selection, and accessible descriptions', () => {
    const rendered = renderFactoryRhythm(binding({ rows: rhythmRows() }), immediateScope());
    const days = [...rendered.querySelectorAll('.factory-rhythm-day')];

    expect(days).toHaveLength(7);
    expect(days[0]?.getAttribute('aria-label')).toBe('Mon 2026-09-07: 1 successful run this week.');
    expect(days[3]?.getAttribute('aria-label')).toBe('Thu 2026-09-10: 4 successful runs last week.');
    expect(rendered.querySelectorAll('.factory-rhythm-day-future')).toHaveLength(4);
  });

  it('floor composes four stations and owns their aggregate accessible summary', () => {
    const controller = new AbortController();
    const motion = state({ operations: 1, live: 1, review: 0 });
    const sources = {
      'overview-registered-repository-summary': binding(),
      'overview-run-summary': binding(),
      'overview-dispatch-summary': binding(),
      'overview-value-summary': binding()
    };
    /** @type {(name: string, count: number) => string} */
    const label = (name, count) => ({
      repositories: count === 1 ? 'Repository registered' : 'Repositories registered',
      'successful-runs': count === 1 ? 'Successful run' : 'Successful runs',
      dispatches: count === 1 ? 'Dispatch' : 'Dispatches',
      'value-gains': count === 1 ? 'Value gain' : 'Value gains'
    })[name] ?? name;
    const scope = { ...immediateScope(), signal: controller.signal, motion };
    const rendered = renderFactoryFloor(sources, metrics(), label, false, scope);

    expect([...rendered.querySelectorAll('.factory-station strong')].map((element) => element.textContent)).toEqual(['6', '8', '7', '3']);
    expect(rendered.classList.contains('factory-floor-active')).toBe(true);
    expect(rendered.getAttribute('aria-label')).toContain('6 repositories registered with 4 delivered to');
    controller.abort();
  });

  it('header owns motion, heading priority, outcome summary, and rhythm composition', () => {
    const motion = state({ operations: 0, live: 0, review: 0 });
    const sources = {
      'overview-factory-status': binding({ rows: [{ 'factory-heading': 'Your factory is delivering value.' }] }),
      'overview-rhythm': binding({ rows: rhythmRows() })
    };
    const rendered = renderFactoryHeader(sources, metrics(), { ...immediateScope(), motion });

    expect(rendered.querySelector('.factory-running')?.textContent).toBe('Work in motion');
    expect(rendered.querySelector('h2')?.textContent).toBe('Your factory is delivering value.');
    expect(rendered.querySelector('.factory-intro-copy > p:last-child')?.textContent).toBe('5 retained issue and pull request outputs are backed by Actions evidence across 4 repositories.');
    expect(rendered.querySelector('.factory-rhythm')).not.toBeNull();
  });
});