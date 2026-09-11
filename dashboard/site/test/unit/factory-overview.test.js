// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { renderFactoryOverview } from '../../src/components/factory-overview.js';

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
          { run: '5', 'run-status': 'in-progress', 'started-at': '2026-09-11T11:45:00Z' }
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
  expect(rendered.querySelector('.factory-running')?.textContent).toContain('1 run in motion');
  expect(rendered.querySelector('.factory-running .octicon')).toBeNull();
  expect(rendered.querySelector('h2')?.textContent).toBe('The factory is delivering value.');
  expect([...rendered.querySelectorAll('.factory-station')].map((station) => station.textContent)).toEqual([
    'Repositories21 review · 1 live',
    'Successful runs22 failed',
    'Dispatches42 workflows observed',
    'Value gains1Coming soon'
  ]);
  expect(rendered.querySelector('.factory-station-final .octicon-trophy')).not.toBeNull();
  expect(rendered.querySelector('.factory-rhythm-heading')?.textContent).toBe('Factory rhythm');
  expect(rendered.querySelector('.factory-intro .factory-rhythm')).not.toBeNull();
  expect(rendered.querySelectorAll('.factory-rhythm-bars > span')).toHaveLength(7);
  expect(rendered.querySelectorAll('.factory-rhythm-bars > span[tabindex="0"]')).toHaveLength(7);
  expect(rendered.querySelectorAll('.factory-rhythm-tooltip')).toHaveLength(7);
  expect(rendered.querySelectorAll('.factory-rhythm-comparison')).toHaveLength(1);
  expect(rendered.querySelectorAll('.factory-rhythm-comparison circle')).toHaveLength(7);
  expect(rendered.querySelector('.factory-status')).toBeNull();
  expect(rendered.querySelector('.factory-station:nth-child(2) strong a')?.getAttribute('href')).toBe('#page-runs?runs-runs-source.run-conclusion=success');
  expect(rendered.querySelector('.factory-station:nth-child(2) small a')?.getAttribute('href')).toBe('#page-runs?runs-runs-source.run-conclusion=failure');
});

it.each([
  ['humming', [{ 'run-status': 'in-progress' }], 'The factory is humming.'],
  ['under strain', [{ 'run-conclusion': 'failure' }], 'The factory is under strain.'],
  ['needs attention', [{ 'run-conclusion': 'success' }, { 'run-conclusion': 'failure' }], 'The factory needs attention.'],
  ['completed its shift', [{ 'run-conclusion': 'success' }], 'The factory completed its shift.'],
  ['idle', [], 'The factory is idle.']
])('describes a factory that is %s', (_state, rows, expected) => {
  const rendered = renderFactoryOverview({
    sources: {
      outcomes: { source: 'outcomes', rows: [], metadata },
      runs: { source: 'runs', rows, metadata }
    }
  });

  expect(rendered.querySelector('h2')?.textContent).toBe(expected);
});

it('reports unavailable factory evidence before inferring an operating state', () => {
  const rendered = renderFactoryOverview({
    sources: {
      outcomes: { source: 'outcomes', rows: [], metadata: { ...metadata, availability: 'unavailable' } },
      runs: { source: 'runs', rows: [{ 'run-status': 'in-progress' }], metadata }
    }
  });

  expect(rendered.querySelector('h2')?.textContent).toBe('Factory status is unavailable.');
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
  expect(rendered.querySelector('.factory-station:first-child')?.textContent).toBe('Repositories1connected');
  expect(rendered.querySelector('.factory-rhythm-comparison')).toBeNull();
});