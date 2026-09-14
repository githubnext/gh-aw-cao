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

/** @param {Record<string, import('../../src/presenter.js').LogicalSourceInput>} [overrides] */
function overviewSources(overrides = {}) {
  return {
    'overview-outcome-summary': source('overview-outcome-summary', [{ 'useful-outputs': 0, 'delivered-repositories': 0 }]),
    'overview-run-summary': source('overview-run-summary', [{ 'successful-runs': 0, 'failed-runs': 0, 'active-runs': 0, 'active-packages': 0, 'active-live': 0, 'active-review': 0 }]),
    'overview-dispatch-summary': source('overview-dispatch-summary', [{ dispatches: 0 }]),
    'overview-value-summary': source('overview-value-summary', [{ 'value-gains': 0 }]),
    'overview-repository-summary': source('overview-repository-summary', [{ repositories: 0 }]),
    'overview-capacity-summary': source('overview-capacity-summary', [{ 'repository-max': 0 }]),
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

it('renders compact database summaries and the applicable repository maximum', () => {
  const rendered = renderFactoryOverview({
    sources: overviewSources({
      'overview-outcome-summary': source('overview-outcome-summary', [{ 'useful-outputs': 2, 'delivered-repositories': 1 }]),
      'overview-run-summary': source('overview-run-summary', [{ 'successful-runs': 2, 'failed-runs': 2, 'active-runs': 1, 'active-packages': 1, 'active-live': 1, 'active-review': 0 }]),
      'overview-dispatch-summary': source('overview-dispatch-summary', [{ dispatches: 4 }]),
      'overview-value-summary': source('overview-value-summary', [{ 'value-gains': 1 }]),
      'overview-repository-summary': source('overview-repository-summary', [{ repositories: 2 }]),
      'overview-capacity-summary': source('overview-capacity-summary', [{ 'repository-max': 12 }]),
      'overview-worker-summary': source('overview-worker-summary', [{ workers: 2 }]),
      'overview-rhythm': source('overview-rhythm', [
        { 'activity-date': '2026-09-09', 'successful-runs': 2 },
        { 'activity-date': '2026-09-11', 'successful-runs': 1 }
      ])
    })
  });

  expect(rendered.querySelector('.factory-running')?.textContent).toContain('1 package in motion (1 live, 0, in review)');
  expect(rendered.querySelector('h2')?.textContent).toBe('Your factory is delivering value.');
  expect([...rendered.querySelectorAll('.factory-station')].map((station) => station.textContent)).toEqual([
    'Repositories212 repository max',
    'Successful runs22 failed',
    'Dispatches42 workflows observed',
    'Value gain1Coming soon'
  ]);
  expect(rendered.querySelector('.factory-floor')?.getAttribute('aria-label')).toContain('2 repositories regularly shipped to against a repository max of 12');
  expect(rendered.querySelectorAll('.factory-rhythm-day')).toHaveLength(2);
});

it.each([
  ['humming', { 'active-runs': 1 }, 'Your factory is humming.'],
  ['under strain', { 'failed-runs': 2, 'successful-runs': 1 }, 'Your factory is under strain.'],
  ['needs attention', { 'failed-runs': 1, 'successful-runs': 1 }, 'Your factory needs attention.'],
  ['completed its shift', { 'successful-runs': 1 }, 'Your factory completed its shift.'],
  ['idle', {}, 'Your factory is idle.']
])('describes a factory that is %s', (_state, values, expected) => {
  const rendered = renderFactoryOverview({
    sources: overviewSources({
      'overview-run-summary': source('overview-run-summary', [{
        'successful-runs': 0,
        'failed-runs': 0,
        'active-runs': 0,
        'active-packages': 0,
        'active-live': 0,
        'active-review': 0,
        ...values
      }])
    })
  });
  expect(rendered.querySelector('h2')?.textContent).toBe(expected);
});

it('reports unavailable query evidence instead of inferring a factory state', () => {
  const rendered = renderFactoryOverview({
    sources: overviewSources({
      'overview-run-summary': source('overview-run-summary', [], { availability: 'unavailable' })
    })
  });
  expect(rendered.querySelector('h2')?.textContent).toBe('Your factory status is unavailable.');
});

it('keeps rhythm selection local while requesting the one-week horizon', () => {
  const rendered = renderFactoryOverview({
    sources: overviewSources({
      'overview-rhythm': source('overview-rhythm', [
        { 'activity-date': '2026-09-09', 'successful-runs': 2 },
        { 'activity-date': '2026-09-11', 'successful-runs': 1 }
      ])
    })
  });
  /** @type {CustomEvent[]} */
  const horizonChanges = [];
  rendered.addEventListener('dashboard-time-window-range-change', (event) => {
    if (event instanceof CustomEvent) horizonChanges.push(event);
  });

  const buttons = [...rendered.querySelectorAll('.factory-rhythm-day')];
  buttons[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

  expect(rendered.querySelector('.factory-rhythm-summary')?.textContent).toBe('Wed 2026-09-09: 2 successful runs.');
  expect(buttons[0]?.getAttribute('aria-pressed')).toBe('true');
  expect(horizonChanges.at(-1)?.detail).toEqual({ range: '1w' });
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
    'overview-value-summary',
    'overview-repository-summary',
    'overview-capacity-summary',
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