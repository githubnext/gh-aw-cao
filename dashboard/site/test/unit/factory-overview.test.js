// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from 'vitest';
import { renderFactoryOverview, resetFactoryOverviewState } from '../../src/components/factory-overview.js';
import { configureSourceLoader } from '../../src/source-store.js';

/** @type {import('../../src/presenter.js').SourceMetadata} */
const metadata = {
  'source-id': 'fixture',
  'source-kind': 'fixture',
  'as-of': '2026-09-11T12:00:00Z',
  'retrieved-at': '2026-09-11T12:00:00Z',
  availability: 'available',
  completeness: 'complete',
  freshness: 'unknown'
};

/** @param {string} name @param {Record<string, unknown>[]} rows @param {Partial<import('../../src/presenter.js').SourceMetadata>} [metadataOverride] */
function source(name, rows, metadataOverride = {}) {
  return { source: name, rows, metadata: { ...metadata, ...metadataOverride } };
}

/** @param {Partial<Record<'Mon'|'Tue'|'Wed'|'Thu'|'Fri'|'Sat'|'Sun', { current: number, previous: number, reached: boolean }>>} [overrides] */
function rhythmSource(overrides = {}) {
  const labels = /** @type {const} */ (['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
  return source('overview-rhythm', [{
    rhythm: {
      days: labels.map((label, index) => ({
        label,
        date: `2026-09-${String(7 + index).padStart(2, '0')}`,
        current: 0,
        previous: 0,
        reached: index < 3,
        ...overrides[label]
      }))
    }
  }]);
}

/** @param {Record<string, import('../../src/presenter.js').LogicalSourceInput>} [overrides] */
function overviewSources(overrides = {}) {
  return {
    'overview-outcome-summary': source('overview-outcome-summary', [{ 'useful-outputs': 0 }]),
    'overview-run-summary': source('overview-run-summary', [{ 'successful-runs': 0, 'failed-runs': 0, 'active-runs': 0, 'active-live': 0, 'active-review': 0 }]),
    'overview-dispatch-summary': source('overview-dispatch-summary', [{ dispatches: 0, 'failed-dispatches': 0 }]),
    'overview-delivery-summary': source('overview-delivery-summary', [{ 'delivered-repositories': 0 }]),
    'overview-value-summary': source('overview-value-summary', [{ 'value-gains': 0 }]),
    'overview-factory-status': source('overview-factory-status', [{ 'factory-heading': 'Your factory is idle.' }]),
    'overview-registered-repository-summary': source('overview-registered-repository-summary', [{ 'registered-repositories': 0 }]),
    'overview-worker-summary': source('overview-worker-summary', [{ workers: 0 }]),
    'overview-rhythm': source('overview-rhythm', []),
    ...overrides
  };
}

beforeEach(resetFactoryOverviewState);

afterEach(() => {
  resetFactoryOverviewState();
  configureSourceLoader(null);
});

it('renders compact database summaries and distinct registered repository coverage', () => {
  const rendered = renderFactoryOverview({
    sources: overviewSources({
      'overview-outcome-summary': source('overview-outcome-summary', [{ 'useful-outputs': 2 }]),
      'overview-run-summary': source('overview-run-summary', [{ 'successful-runs': 2, 'failed-runs': 2, 'active-runs': 4, 'active-live': 1, 'active-review': 3 }]),
      'overview-dispatch-summary': source('overview-dispatch-summary', [{ dispatches: 4, 'failed-dispatches': 2 }]),
      'overview-delivery-summary': source('overview-delivery-summary', [{ 'delivered-repositories': 3 }]),
      'overview-value-summary': source('overview-value-summary', [{ 'value-gains': 1 }]),
      'overview-factory-status': source('overview-factory-status', [{ 'factory-heading': 'Your factory is delivering value.' }]),
      'overview-registered-repository-summary': source('overview-registered-repository-summary', [{ 'registered-repositories': 6 }]),
      'overview-worker-summary': source('overview-worker-summary', [{ workers: 2 }]),
      'overview-rhythm': rhythmSource({ Wed: { current: 2, previous: 1, reached: true } })
    })
  });

  expect(rendered.querySelector('.factory-running')?.textContent).toBe('Work in motion');
  expect(rendered.querySelector('.factory-running-active > span')?.textContent).toBe('Work in motion');
  expect(rendered.querySelector('h2')?.textContent).toBe('Your factory is delivering value.');
  expect([...rendered.querySelectorAll('.factory-station')].map((station) => station.textContent)).toEqual([
    'Repositories registered6',
    'Successful runs22 failed',
    'Dispatches42 failed',
    'Value gain1'
  ]);
  expect(rendered.querySelector('.factory-floor')?.getAttribute('aria-label')).toContain('6 repositories registered with 3 delivered to');
  expect(rendered.querySelector('.factory-station:first-child strong a')?.getAttribute('href')).toBe('#page-repositories');
  expect(rendered.querySelector('.factory-station:first-child strong a')?.textContent).toBe('6');
  expect(rendered.querySelector('.factory-station:first-child small')?.textContent).toBe('');
  expect(rendered.querySelector('.factory-station:nth-child(3) small a')?.getAttribute('href')).toBe('#page-dispatches?package-worker-dispatches.status=failure');
  expect(rendered.querySelector('.factory-station:nth-child(4) strong a')?.getAttribute('href')).toBe('#page-operational-value');
  expect(rendered.querySelector('.factory-station:nth-child(4) strong a')?.textContent).toBe('1');
  expect([...rendered.querySelectorAll('.factory-rhythm-day small')].map((day) => day.textContent)).toEqual([
    'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'
  ]);
  expect(rendered.querySelector('.factory-rhythm-legend')?.getAttribute('aria-label')).toBe('Factory rhythm legend');
  expect([...rendered.querySelectorAll('.factory-rhythm-legend li')].map((item) => item.textContent)).toEqual([
    'This week', 'Last week'
  ]);
  expect(rendered.querySelectorAll('.factory-rhythm-day-future')).toHaveLength(4);
  expect(rendered.querySelectorAll('.factory-rhythm-current:not([hidden])')).toHaveLength(3);
  expect(rendered.querySelectorAll('.factory-rhythm-baseline:not([hidden])')).toHaveLength(4);
});

it('animates overview counters only when selected by its JSON element configuration', () => {
  const rendered = renderFactoryOverview({
    elementConfig: { animate: 'number' },
    sources: overviewSources({
      'overview-run-summary': source('overview-run-summary', [{ 'successful-runs': 2, 'failed-runs': 0, 'active-runs': 0, 'active-live': 0, 'active-review': 0 }])
    })
  });

  const counter = rendered.querySelector('.factory-station:nth-child(2) strong .metric-number-animated');
  expect(counter?.classList.contains('metric-number-animated')).toBe(true);
  expect(counter instanceof HTMLElement && counter.style.getPropertyValue('--metric-number-target')).toBe('2');
});

it.each([
  ['humming', 'Your factory is humming.'],
  ['under strain', 'Your factory is under strain.'],
  ['needs attention', 'Your factory needs attention.'],
  ['idle', 'Your factory is idle.']
])('presents a factory status that is %s', (_state, expected) => {
  const rendered = renderFactoryOverview({
    sources: overviewSources({
      'overview-factory-status': source('overview-factory-status', [{ 'factory-heading': expected }])
    })
  });
  expect(rendered.querySelector('h2')?.textContent).toBe(expected);
});

it('reports unavailable query evidence instead of inferring a factory state', () => {
  const rendered = renderFactoryOverview({
    sources: overviewSources({
      'overview-factory-status': source('overview-factory-status', [], { availability: 'unavailable' })
    })
  });
  expect(rendered.querySelector('h2')?.textContent).toBe('Your factory status is unavailable.');
});

it('retains run status when optional outcome evidence is unavailable', () => {
  const rendered = renderFactoryOverview({
    sources: overviewSources({
      'overview-outcome-summary': source('overview-outcome-summary', [], { availability: 'unavailable' }),
      'overview-run-summary': source('overview-run-summary', [{
        'successful-runs': 1,
        'failed-runs': 0,
        'active-runs': 0,
        'active-live': 0,
        'active-review': 0
      }]),
      'overview-factory-status': source('overview-factory-status', [{ 'factory-heading': 'Your factory is humming.' }])
    })
  });

  expect(rendered.querySelector('h2')?.textContent).toBe('Your factory is humming.');
});

it('hides the duplicate run and dispatch summary when no useful outputs exist', () => {
  const rendered = renderFactoryOverview({ sources: overviewSources() });
  const summary = rendered.querySelector('.factory-intro-copy > p:last-child');

  expect(summary?.hasAttribute('hidden')).toBe(true);
  expect(summary?.textContent).toBe('');
});

it('reports unavailable registered repository evidence instead of counting delivery', () => {
  const rendered = renderFactoryOverview({
    sources: overviewSources({
      'overview-delivery-summary': source('overview-delivery-summary', [{ 'delivered-repositories': 3 }]),
      'overview-registered-repository-summary': source('overview-registered-repository-summary', [], { availability: 'unavailable' })
    })
  });

  expect(rendered.querySelector('.factory-station')?.textContent).toBe('Repositories registeredUnavailable');
  expect(rendered.querySelector('.factory-station:first-child strong a')).toBeNull();
  expect(rendered.querySelector('.factory-station:first-child small')?.textContent).toBe('');
  expect(rendered.querySelector('.factory-floor')?.getAttribute('aria-label')).toContain('Registered repositories unavailable');
});

it('renders rhythm days as non-interactive bars with concise hover descriptions', () => {
  const rendered = renderFactoryOverview({
    sources: overviewSources({
      'overview-rhythm': rhythmSource({
        Mon: { current: 2, previous: 0, reached: true },
        Wed: { current: 0, previous: 90, reached: false }
      })
    })
  });

  const days = [...rendered.querySelectorAll('.factory-rhythm-day')];
  expect(rendered.querySelectorAll('button.factory-rhythm-day')).toHaveLength(0);
  expect(days[0]?.getAttribute('title')).toBe('Mon 2026-09-07: 2 successful runs this week.');
  expect(days[2]?.getAttribute('title')).toBe('Wed 2026-09-09: 90 successful runs last week.');
  expect(days.every((day) => day.getAttribute('aria-pressed') === null)).toBe(true);
});

it('requests only compact query outputs and updates each station independently', async () => {
  /** @type {Map<string, (value: import('../../src/presenter.js').LogicalSourceInput | undefined) => void>} */
  const resolvers = new Map();
  /** @type {string[]} */
  const requested = [];
  configureSourceLoader((name) => {
    requested.push(name);
    return new Promise((resolve) => resolvers.set(name, resolve));
  });

  const rendered = renderFactoryOverview({ sources: {} });
  expect(requested).toEqual([
    'overview-outcome-summary',
    'overview-run-summary',
    'overview-dispatch-summary',
    'overview-delivery-summary',
    'overview-value-summary',
    'overview-factory-status',
    'overview-registered-repository-summary',
    'overview-worker-summary',
    'overview-rhythm'
  ]);
  expect(rendered.querySelectorAll('.factory-station-pending')).toHaveLength(4);

  resolvers.get('overview-run-summary')?.(source('overview-run-summary', [{ 'successful-runs': 1, 'failed-runs': 1, 'active-runs': 0 }]));
  await Promise.resolve();
  await Promise.resolve();

  expect(rendered.querySelector('.factory-station:nth-child(2)')?.textContent).toBe('Successful run11 failed');
  expect(rendered.querySelector('.factory-station:nth-child(2)')?.classList.contains('factory-station-pending')).toBe(false);
  expect(rendered.querySelector('.factory-station:nth-child(4)')?.classList.contains('factory-station-pending')).toBe(true);
});