// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { renderDashboard } from '../../src/presenter.js'

const fixtureDirectory = dirname(fileURLToPath(import.meta.url))
const authoritativeDashboard = JSON.parse(
  readFileSync(resolve(fixtureDirectory, '../../dashboard.json'), 'utf8'),
)

const metadata = {
  'source-id': 'runtime-fixture',
  'source-kind': 'fixture',
  'as-of': '2026-08-30T12:00:00Z',
  'retrieved-at': '2026-08-30T12:01:00Z',
  'coverage-start': '2026-08-29T12:00:00Z',
  'coverage-end': '2026-08-30T12:00:00Z',
  completeness: /** @type {'complete'} */ ('complete'),
  freshness: /** @type {'fresh'} */ ('fresh'),
  availability: /** @type {'available'} */ ('available'),
}

describe('Runtime dashboard view', () => {
  it('keeps Runtime as one full-view lazy execution table', () => {
    const runtimePage = authoritativeDashboard.dashboard.pages.find(
      (/** @type {{ id: string }} */ page) => page.id === 'runtime',
    )

    expect(runtimePage).toMatchObject({
      id: 'runtime',
      kind: 'custom',
      title: 'Runtime & episodes',
    })
    expect(runtimePage.sections).toBeUndefined()
    expect(runtimePage.views).toEqual([
      expect.objectContaining({
        id: 'runtime-execution-episodes',
        mark: 'table',
        controls: 'interactive',
        'lazy-list': true,
        layout: 'full-view',
      }),
    ])
  })

  it('renders declarative triage signals, episode summary, and episode tables', () => {
    const document = {
      languageVersion: '0.1.0',
      dashboard: {
        id: 'runtime-dashboard',
        title: 'Runtime dashboard',
        pages: [
          {
            id: 'runtime',
            kind: /** @type {'custom'} */ ('custom'),
            title: 'Runtime',
            sections: [
              {
                id: 'runtime-triage',
                title: 'Needs attention',
                description: 'Ranked execution evidence.',
                layout: /** @type {'full'} */ ('full'),
                'count-source': 'runtime-signals',
                'count-label': 'signals',
                views: ['anomaly-readiness', 'attention'],
              },
              {
                id: 'observed-behavior',
                title: 'Execution episodes',
                layout: /** @type {'full'} */ ('full'),
                views: ['summary', 'episodes', 'gaps'],
              },
            ],
            views: [
              {
                id: 'anomaly-readiness',
                title: 'Statistical anomaly readiness',
                data: { sources: ['runtime-anomaly-readiness'] },
                mark: 'element',
                element: 'anomaly-readiness',
              },
              {
                id: 'attention',
                title: 'Needs attention',
                data: { sources: ['runtime-signals'] },
                mark: 'element',
                element: 'signal-list',
              },
              {
                id: 'summary',
                title: 'Execution episodes',
                data: { source: 'runtime-episode-summary' },
                mark: 'element',
                element: 'summary-grid',
              },
              {
                id: 'episodes',
                title: 'Observed root episodes',
                data: { source: 'runtime-episodes' },
                mark: 'table',
                encoding: {
                  columns: [
                    { field: 'run', title: 'Run' },
                    { field: 'package', title: 'Package' },
                    { field: 'workflow', title: 'Workflow' },
                    { field: 'duration', title: 'Duration' },
                    { field: 'status', title: 'Result', display: 'status' },
                    { field: 'attribution', title: 'Evidence' },
                  ],
                },
              },
              {
                id: 'gaps',
                title: 'Worker attribution gaps',
                data: { source: 'runtime-attribution-gaps' },
                mark: 'table',
                encoding: {
                  columns: [
                    { field: 'run', title: 'Run' },
                    { field: 'workflow', title: 'Workflow' },
                    { field: 'status', title: 'Result', display: 'status' },
                    { field: 'evidence', title: 'Evidence gap' },
                  ],
                },
              },
            ],
          },
        ],
      },
    }
    const sources = {
      workflows: {
        source: 'workflows',
        rows: [
          {
            organization: 'githubnext',
            repository: 'gh-aw-cao',
            package: 'dependabot',
            'package-name': 'Dependabot',
            workflow: '.github/workflows/dependabot.md',
            'workflow-name': 'Dependabot',
            'workflow-role': 'orchestrator',
          },
          {
            organization: 'githubnext',
            repository: 'gh-aw-cao',
            package: 'dependabot',
            'package-name': 'Dependabot',
            workflow: '.github/workflows/dependabot-worker.md',
            'workflow-name': 'Dependabot worker',
            'workflow-role': 'worker',
          },
        ],
        metadata,
      },
      runs: {
        source: 'runs',
        rows: [
          {
            organization: 'githubnext',
            repository: 'gh-aw-cao',
            workflow: '.github/workflows/dependabot.md',
            run: '10',
            'run-title': 'Dependabot review',
            'started-at': '2026-08-30T10:00:00Z',
            'ended-at': '2026-08-30T10:05:00Z',
            'run-status': 'completed',
            'run-conclusion': 'action-required',
            'run-link': {
              relation: 'run',
              href: 'https://github.com/githubnext/gh-aw-cao/actions/runs/10',
              label: 'View run 10',
            },
          },
          {
            organization: 'githubnext',
            repository: 'gh-aw-cao',
            workflow: '.github/workflows/dependabot-worker.md',
            run: '11',
            'run-title': 'Update train',
            'started-at': '2026-08-30T10:01:00Z',
            'ended-at': '2026-08-30T10:04:00Z',
            'run-status': 'completed',
            'run-conclusion': 'failure',
            'run-link': {
              relation: 'run',
              href: 'https://github.com/githubnext/gh-aw-cao/actions/runs/11',
              label: 'View run 11',
            },
          },
        ],
        metadata,
      },
      outcomes: { source: 'outcomes', rows: [], metadata },
      findings: { source: 'findings', rows: [], metadata },
      usage: { source: 'usage', rows: [], metadata },
    }

    const rendered = renderDashboard({ document, sources })

    expect(
      rendered.querySelector('[data-nav-page-id="runtime"]'),
    ).not.toBeNull()
    const runtimePage = rendered.querySelector('[data-page-id="runtime"]')
    expect(
      runtimePage?.querySelector(
        '[data-section-id="runtime-triage"] .scope-kicker',
      )?.textContent,
    ).toBe('Runtime Triage')
    expect(
      runtimePage?.querySelector(
        '[data-section-id="runtime-triage"] .layout-section-header h3',
      )?.textContent,
    ).toBe('Needs attention')
    expect(
      runtimePage?.querySelector('.anomaly-readiness')?.getAttribute('role'),
    ).toBe('note')
    expect(
      runtimePage?.querySelector('.anomaly-readiness')?.textContent,
    ).toContain('Statistical anomalies · not evaluated')
    expect(
      runtimePage?.querySelector('.anomaly-readiness .octicon-pulse'),
    ).not.toBeNull()
    const attention = rendered.querySelector('.signal-list-region')?.textContent
    expect(attention).toContain('Approval gate')
    expect(attention).toContain('Run failures')
    expect(attention).toContain('1 worker dispatch lacks episode evidence')
    expect(attention).toContain(
      '1 root episode has no correlated worker attempt or output',
    )
    expect(
      rendered
        .querySelector('.signal-critical .signal-icon use')
        ?.getAttribute('href'),
    ).toContain('#octicon-issue-opened')
    expect(
      [...rendered.querySelectorAll('.signal-list > li > a')].map((link) =>
        link.getAttribute('href'),
      ),
    ).toEqual([
      '#page-workflow-runtime?workflow=githubnext%2Fgh-aw-cao%3A.github%2Fworkflows%2Fdependabot-worker.md',
      '#page-workflow-runtime?workflow=githubnext%2Fgh-aw-cao%3A.github%2Fworkflows%2Fdependabot.md',
      '#page-runtime?section=runtime-observed-root-episodes-heading',
      '#page-runtime?section=runtime-worker-attribution-gaps-heading',
    ])
    expect(rendered.querySelector('.signal-list a[target]')).toBeNull()
    expect(rendered.querySelector('.summary-grid')?.textContent).toContain(
      'Worker attribution0 / 1',
    )
    expect(rendered.querySelector('.summary-grid')?.textContent).toContain(
      'Repeated coverageUnavailable',
    )
    const tables = rendered.querySelectorAll('.custom-table')
    expect(tables).toHaveLength(2)
    expect(tables[0]?.textContent).toContain(
      '10DependabotDependabot5m 0saction-requiredRoot only',
    )
    expect(tables[1]?.textContent).toContain(
      '11Dependabot workerfailureNo retained root correlation ID',
    )
  })
})
