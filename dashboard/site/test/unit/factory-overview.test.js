// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from 'vitest';
import { renderFactoryOverview, resetFactoryOverviewState } from '../../src/components/factory-overview.js';

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

beforeEach(() => {
  resetFactoryOverviewState();
});

afterEach(() => {
  resetFactoryOverviewState();
});

it('summarizes retained Actions activity and useful outputs while routing failures to Runs', () => {
  const rendered = renderFactoryOverview({
    sources: {
      outcomes: {
        source: 'outcomes',
        rows: [
          { 'safe-output': 'issue-1', 'outcome-category': 'issue', 'outcome-state': 'accepted', repository: 'githubnext/gh-aw-cao', 'observed-at': '2026-09-11T09:00:00Z' },
          { 'safe-output': 'issue-1', 'outcome-category': 'issue', 'outcome-state': 'lifecycle-close', repository: 'githubnext/gh-aw-cao', 'observed-at': '2026-09-11T11:00:00Z' },
          { 'safe-output': 'pr-1', 'safe-output-kind': 'create-pull-request', 'outcome-state': 'accepted', repository: 'githubnext/gh-aw-cao', 'observed-at': '2026-09-11T10:00:00Z' }
        ],
        metadata
      },
      runs: {
        source: 'runs',
        rows: [
          { run: '1', 'run-conclusion': 'failure', 'started-at': '2026-09-11T10:00:00Z' },
          { run: '2', 'run-conclusion': 'timed-out', 'started-at': '2026-09-11T11:00:00Z' },
          { run: '3', 'run-conclusion': 'success', 'run-status': 'completed', 'started-at': '2026-09-11T11:15:00Z' },
          { run: '4', 'run-conclusion': 'success', 'run-status': 'completed', 'started-at': '2026-09-11T11:30:00Z' },
          { run: '5', package: 'cao', 'run-status': 'in-progress', 'rollout-mode': 'live', 'started-at': '2026-09-11T11:45:00Z' }
        ],
        metadata
      },
      dispatches: { source: 'dispatches', rows: Array.from({ length: 4 }, (_, index) => ({ run: String(index + 1) })), metadata },
      'grader-observations': {
        source: 'grader-observations',
        rows: [
          { grader: 'quality', run: '3', value: 0.91, threshold: 0.8 },
          { grader: 'quality', run: '4', value: 0.8, threshold: 0.8 },
          { grader: 'coverage', run: '4', value: 0.95 }
        ],
        metadata
      },
      'factory-rhythm-baseline': { source: 'factory-rhythm-baseline', rows: [{ 'daily-averages': [1, 2, 3, 4, 5, 6, 7], weeks: 4 }], metadata },
      repositories: { source: 'repositories', rows: [{ repository: 'githubnext/gh-aw-cao', 'rollout-mode': 'review' }], metadata },
      workflows: {
        source: 'workflows',
        rows: [
          { workflow: 'dispatch', 'workflow-role': 'orchestrator', 'package-targets': [{ repository: 'github/one', mode: 'review' }, { repository: 'github/two', mode: 'live' }, { repository: 'github/one', mode: 'review' }] },
          { workflow: 'review', 'workflow-role': 'worker' },
          { workflow: 'update', 'workflow-role': 'worker' }
        ],
        metadata
      }
    }
  });

  expect(rendered.querySelector('.factory-output')).toBeNull();
  expect(rendered.textContent).not.toContain('Coming off the line');
  expect(rendered.querySelector('.factory-belt')).toBeNull();
  expect(rendered.querySelector('.factory-capacity')).toBeNull();
  expect(rendered.querySelector('.factory-running')?.textContent).toContain('1 package in motion (1 op live, 0 in review)');
  expect(rendered.querySelector('.factory-running .octicon')).toBeNull();
  expect(rendered.querySelector('h2')?.textContent).toBe('Your factory is delivering value.');
  expect([...rendered.querySelectorAll('.factory-station')].map((station) => station.textContent)).toEqual([
    'Repositories21 review · 1 live',
    'Successful runs22 failed',
    'Dispatches42 workflows observed',
    'Value gain1Coming soon'
  ]);
  expect(rendered.querySelector('.factory-station-final .octicon-trophy')).not.toBeNull();
  expect(rendered.querySelector('.factory-station:nth-child(2) .octicon-play')).not.toBeNull();
  expect(rendered.querySelector('.factory-rhythm-heading span')?.textContent).toBe('Factory rhythm');
  expect(rendered.querySelector('.factory-intro .factory-rhythm')).not.toBeNull();
  expect(rendered.querySelectorAll('.factory-rhythm-bars > .factory-rhythm-day')).toHaveLength(7);
  expect(rendered.querySelectorAll('.factory-rhythm-bars > .factory-rhythm-day[type="button"]')).toHaveLength(7);
  expect(rendered.querySelector('.factory-rhythm-tooltip')).toBeNull();
  expect(rendered.querySelector('.factory-rhythm-comparison')).toBeNull();
  expect(rendered.querySelector('.factory-rhythm-summary')?.textContent).toBe('');
  expect(rendered.querySelector('.factory-status')).toBeNull();
  expect(rendered.querySelector('.factory-station:nth-child(2) strong a')?.getAttribute('href')).toBe('#page-runs?runs-runs-source.run-conclusion=success');
  expect(rendered.querySelector('.factory-station:nth-child(2) small a')?.getAttribute('href')).toBe('#page-runs?runs-runs-source.run-conclusion=failure');
});

it.each([
  ['humming', [{ 'run-status': 'in-progress' }], 'Your factory is humming.'],
  ['under strain', [{ 'run-conclusion': 'failure' }], 'Your factory is under strain.'],
  ['needs attention', [{ 'run-conclusion': 'success' }, { 'run-conclusion': 'failure' }], 'Your factory needs attention.'],
  ['completed its shift', [{ 'run-conclusion': 'success' }], 'Your factory completed its shift.'],
  ['idle', [], 'Your factory is idle.']
])('describes a factory that is %s', (_state, rows, expected) => {
  const rendered = renderFactoryOverview({
    sources: {
      outcomes: { source: 'outcomes', rows: [], metadata },
      runs: { source: 'runs', rows, metadata }
    }
  });

  expect(rendered.querySelector('h2')?.textContent).toBe(expected);
});

it('summarizes packages in motion by live and review operations', () => {
  const runs = [
    ...Array.from({ length: 5 }, (_, index) => ({
      run: `live-${index}`,
      package: 'package-a',
      'run-status': 'in-progress',
      'rollout-mode': 'live'
    })),
    ...Array.from({ length: 2 }, (_, index) => ({
      run: `review-${index}`,
      package: 'package-b',
      'run-status': 'queued',
      'rollout-mode': 'review'
    }))
  ];
  const rendered = renderFactoryOverview({
    sources: {
      outcomes: { source: 'outcomes', rows: [], metadata },
      runs: { source: 'runs', rows: runs, metadata }
    }
  });

  expect(rendered.querySelector('.factory-running')?.textContent)
    .toBe('2 packages in motion (5 ops live, 2 in review)');
});

it('reports unavailable factory evidence before inferring an operating state', () => {
  const rendered = renderFactoryOverview({
    sources: {
      outcomes: { source: 'outcomes', rows: [], metadata: { ...metadata, availability: 'unavailable' } },
      runs: { source: 'runs', rows: [{ 'run-status': 'in-progress' }], metadata }
    }
  });

  expect(rendered.querySelector('h2')?.textContent).toBe('Your factory status is unavailable.');
});

it('counts canonical dispatch runs when the derived dispatch source is empty', () => {
  const rendered = renderFactoryOverview({
    sources: {
      outcomes: { source: 'outcomes', rows: [], metadata },
      runs: {
        source: 'runs',
        rows: [
          { event: 'workflow_dispatch', workflow: 'worker-a.yml', organization: 'githubnext', repository: 'control' },
          { event: 'workflow_dispatch', workflow: 'worker-b.yml', organization: 'githubnext', repository: 'control' },
          { event: 'schedule', workflow: 'scheduled.yml', organization: 'githubnext', repository: 'control' }
        ],
        metadata
      },
      dispatches: { source: 'dispatches', rows: [], metadata }
    }
  });

  expect(rendered.querySelector('.factory-station:nth-child(3)')?.textContent).toBe('Dispatches22 workflows observed');
  expect(rendered.querySelector('.factory-station:first-child')?.textContent).toBe('Repository1connected');
  expect(rendered.querySelector('.factory-rhythm-comparison')).toBeNull();
});

it('updates the factory rhythm day summary when selecting a bar', () => {
  const rendered = renderFactoryOverview({
    sources: {
      outcomes: { source: 'outcomes', rows: [], metadata },
      runs: {
        source: 'runs',
        rows: [
          { run: '1', 'run-conclusion': 'success', 'started-at': '2026-09-09T09:00:00Z' },
          { run: '2', 'run-conclusion': 'success', 'started-at': '2026-09-09T12:00:00Z' },
          { run: '3', 'run-conclusion': 'success', 'started-at': '2026-09-11T10:00:00Z' }
        ],
        metadata
      }
    }
  });
  /** @type {CustomEvent | undefined} */
  let horizonChange;
  rendered.addEventListener('dashboard-time-window-change', (event) => {
    if (event instanceof CustomEvent) horizonChange = event;
  });
  const dayButtons = [...rendered.querySelectorAll('.factory-rhythm-bars > .factory-rhythm-day')];
  dayButtons[4]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

  expect(rendered.querySelector('.factory-rhythm-summary')?.textContent).toBe('Wed 2026-09-09: 2 successful runs.');
  expect(dayButtons[4]?.getAttribute('aria-pressed')).toBe('true');
  expect(horizonChange?.detail).toEqual({
    start: '2026-09-09T00:00:00.000Z',
    end: '2026-09-10T00:00:00.000Z'
  });

  /** @type {CustomEvent | undefined} */
  let horizonReset;
  rendered.addEventListener('dashboard-time-window-range-change', (event) => {
    if (event instanceof CustomEvent) horizonReset = event;
  });
  rendered.querySelector('.factory-rhythm-heading')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

  expect(dayButtons.every((button) => button.getAttribute('aria-pressed') === 'false')).toBe(true);
  expect(rendered.querySelector('.factory-rhythm-summary')?.textContent).toBe('');
  expect(horizonReset?.detail).toEqual({ range: '1w' });
});

it('does not select a factory rhythm day by default', () => {
  const rendered = renderFactoryOverview({
    sources: {
      outcomes: { source: 'outcomes', rows: [], metadata },
      runs: {
        source: 'runs',
        rows: [
          { run: '1', 'run-conclusion': 'success', 'started-at': '2026-09-09T09:00:00Z' },
          { run: '2', 'run-conclusion': 'success', 'started-at': '2026-09-11T10:00:00Z' }
        ],
        metadata
      }
    }
  });
  const dayButtons = [...rendered.querySelectorAll('.factory-rhythm-bars > .factory-rhythm-day')];

  expect(rendered.querySelector('.factory-rhythm-summary')?.textContent).toBe('');
  expect(dayButtons.every((button) => button.getAttribute('aria-pressed') === 'false')).toBe(true);
});

it('does not select a factory rhythm day when no successful runs are present', () => {
  const rendered = renderFactoryOverview({
    sources: {
      outcomes: { source: 'outcomes', rows: [], metadata },
      runs: {
        source: 'runs',
        rows: [{ run: '1', 'run-conclusion': 'failure', 'started-at': '2026-09-11T10:00:00Z' }],
        metadata
      }
    }
  });
  const dayButtons = [...rendered.querySelectorAll('.factory-rhythm-bars > .factory-rhythm-day')];

  expect(rendered.querySelector('.factory-rhythm-summary')?.textContent).toBe('');
  expect(dayButtons.every((button) => button.getAttribute('aria-pressed') === 'false')).toBe(true);
});

it('reflects arity with declared plural text variables and falls back to built-in labels', () => {
  const singularSources = {
    outcomes: { source: 'outcomes', rows: [], metadata },
    runs: {
      source: 'runs',
      rows: [{ run: '1', 'run-conclusion': 'success', 'run-status': 'completed', 'started-at': '2026-09-11T11:00:00Z' }],
      metadata
    },
    dispatches: { source: 'dispatches', rows: [{ run: '1' }], metadata },
    'grader-observations': { source: 'grader-observations', rows: [{ grader: 'quality', run: '1', value: 0.9, threshold: 0.8 }], metadata },
    repositories: { source: 'repositories', rows: [{ repository: 'githubnext/gh-aw-cao', 'rollout-mode': 'live' }], metadata },
    workflows: { source: 'workflows', rows: [{ workflow: 'review', 'workflow-role': 'worker' }], metadata }
  };
  const labels = {
    repositories: { singular: 'Repository', plural: 'Repositories' },
    'successful-runs': { singular: 'Successful run', plural: 'Successful runs' },
    dispatches: { singular: 'Dispatch', plural: 'Dispatches' },
    'value-gains': { singular: 'Value gain', plural: 'Value gains' }
  };

  const declared = renderFactoryOverview({ sources: singularSources, elementConfig: { labels } });

  expect([...declared.querySelectorAll('.factory-station')].map((station) => station.textContent)).toEqual([
    'Repository10 review · 1 live',
    'Successful run10 failed',
    'Dispatch11 workflow observed',
    'Value gain1Coming soon'
  ]);
  expect(declared.querySelector('.factory-floor')?.getAttribute('aria-label')).toContain('1 repository in scope');

  const fallback = renderFactoryOverview({ sources: singularSources });

  expect([...fallback.querySelectorAll('.factory-station')].map((station) => station.textContent)).toEqual(
    [...declared.querySelectorAll('.factory-station')].map((station) => station.textContent)
  );
});

it('restores the selected rhythm day and live motion when the dashboard refreshes', () => {
  const runs = [
    { run: '1', 'run-conclusion': 'success', 'started-at': '2026-09-09T09:00:00Z' },
    { run: '2', 'run-conclusion': 'success', 'started-at': '2026-09-09T12:00:00Z' },
    { run: '3', 'run-conclusion': 'success', 'started-at': '2026-09-11T10:00:00Z' },
    { run: '4', package: 'cao', 'run-status': 'in-progress', 'rollout-mode': 'live', 'started-at': '2026-09-11T11:00:00Z' }
  ];
  const rendered = renderFactoryOverview({
    sources: {
      outcomes: { source: 'outcomes', rows: [], metadata },
      runs: { source: 'runs', rows: runs, metadata }
    }
  });

  expect(rendered.querySelector('.factory-running')?.textContent).toBe('1 package in motion (1 op live, 0 in review)');

  const dayButtons = [...rendered.querySelectorAll('.factory-rhythm-bars > .factory-rhythm-day')];
  dayButtons[4]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

  const refreshed = renderFactoryOverview({
    sources: {
      outcomes: { source: 'outcomes', rows: [], metadata },
      runs: { source: 'runs', rows: runs.filter((row) => String(row['started-at']).startsWith('2026-09-09')), metadata }
    }
  });
  const refreshedButtons = [...refreshed.querySelectorAll('.factory-rhythm-bars > .factory-rhythm-day')];

  expect(refreshed.querySelector('.factory-rhythm-summary')?.textContent).toBe('Wed 2026-09-09: 2 successful runs.');
  expect(refreshedButtons.filter((button) => button.getAttribute('aria-pressed') === 'true')).toHaveLength(1);
  expect(refreshed.querySelector('.factory-running')?.textContent).toBe('1 package in motion (1 op live, 0 in review)');
  expect(refreshed.querySelector('.factory-running')?.className).toBe('factory-running factory-running-active');

  refreshed.querySelector('.factory-rhythm-heading')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

  expect(refreshedButtons.every((button) => button.getAttribute('aria-pressed') === 'false')).toBe(true);
  expect(refreshed.querySelector('.factory-rhythm-summary')?.textContent).toBe('');
});

it('stops the reactive effects owned by a superseded overview render', () => {
  const sources = {
    outcomes: { source: 'outcomes', rows: [], metadata },
    runs: {
      source: 'runs',
      rows: [
        { run: '1', 'run-conclusion': 'success', 'started-at': '2026-09-09T09:00:00Z' },
        { run: '2', package: 'cao', 'run-status': 'in-progress', 'rollout-mode': 'review', 'started-at': '2026-09-11T11:00:00Z' }
      ],
      metadata
    }
  };
  const stale = renderFactoryOverview({ sources });
  const current = renderFactoryOverview({ sources });
  const staleSummary = stale.querySelector('.factory-rhythm-summary')?.textContent;

  const dayButtons = [...current.querySelectorAll('.factory-rhythm-bars > .factory-rhythm-day')];
  dayButtons[4]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

  expect(current.querySelector('.factory-rhythm-summary')?.textContent).toBe('Wed 2026-09-09: 1 successful run.');
  expect(stale.querySelector('.factory-rhythm-summary')?.textContent).toBe(staleSummary);
});
