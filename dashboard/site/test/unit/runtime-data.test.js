import { describe, expect, it } from 'vitest'
import { deriveRuntimeSources } from '../../src/runtime-data.js'

const metadata = {
  'source-id': 'runtime-fixture',
  'source-kind': 'fixture',
  'as-of': '2026-08-30T12:00:00Z',
  'retrieved-at': '2026-08-30T12:01:00Z',
  completeness: /** @type {'complete'} */ ('complete'),
  freshness: /** @type {'fresh'} */ ('fresh'),
  availability: /** @type {'available'} */ ('available'),
}

describe('runtime data', () => {
  it('adds display-ready failure detail to legacy run rows', () => {
    const sources = deriveRuntimeSources({
      runs: {
        source: 'runs',
        rows: [
          { run: '1', 'failure-message': 'Target authority missing' },
          { run: '2', 'failure-step': 'Compile workflows' },
          { run: '3' },
          { run: '4', 'failure-detail': 'Producer detail' },
        ],
        metadata,
      },
    })

    expect(sources.runs.rows.map((row) => row['failure-detail'])).toEqual([
      'Target authority missing',
      'Compile workflows',
      'Run 3',
      'Producer detail',
    ])
    expect(sources.runs.metadata).toBe(metadata)
  })

  it('derives reusable signal-list rows independently from presentation', () => {
    const sources = deriveRuntimeSources({
      workflows: {
        source: 'workflows',
        rows: [
          {
            organization: 'githubnext',
            repository: 'gh-aw-cao',
            workflow: '.github/workflows/root.md',
            'workflow-name': 'Root',
            'workflow-role': 'orchestrator',
            package: 'ops',
          },
          {
            organization: 'githubnext',
            repository: 'gh-aw-cao',
            workflow: '.github/workflows/worker.md',
            'workflow-name': 'Worker',
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
            workflow: '.github/workflows/root.md',
            run: '1',
            'run-conclusion': 'action-required',
          },
          {
            organization: 'githubnext',
            repository: 'gh-aw-cao',
            workflow: '.github/workflows/worker.md',
            run: '2',
            'run-conclusion': 'failure',
          },
        ],
        metadata,
      },
    })

    expect(sources['runtime-signals'].rows.map((row) => row.kind)).toEqual([
      'Run failures',
      'Approval gate',
      'Evidence gap',
      'Evidence gap',
    ])
    expect(sources['runtime-anomaly-readiness'].rows).toEqual([
      {
        icon: 'pulse',
        title: 'Statistical anomalies · not evaluated',
        detail:
          'The current window does not provide a representative historical baseline. Direct evidence remains visible without inferred anomaly labels.',
      },
    ])
    expect(sources['runtime-signals'].rows[0]['navigation-href']).toBe(
      '#page-workflow-runtime?workflow=githubnext%2Fgh-aw-cao%3A.github%2Fworkflows%2Fworker.md',
    )
    expect(sources['runtime-signals'].metadata).toBe(metadata)
    expect(sources['runtime-episode-summary'].rows).toEqual([
      { label: 'Root episodes', value: '1' },
      { label: 'Worker attribution', value: '0 / 1' },
      { label: 'Run window', value: 'Complete 24h' },
      { label: 'Repeated coverage', value: 'Unavailable' },
    ])
    expect(sources['runtime-episodes'].rows).toEqual([
      expect.objectContaining({
        run: '1',
        workflow: 'Root',
        status: 'action-required',
        'control-transition': 'workflow_dispatch → root run',
        attribution: 'Root only',
      }),
    ])
    expect(sources['runtime-attribution-gaps'].rows).toEqual([
      expect.objectContaining({
        run: '2',
        workflow: 'Worker',
        status: 'failure',
        'control-transition': 'worker dispatch → attribution unavailable',
        'reason-code': 'missing-root-correlation',
        evidence: 'No retained root correlation ID',
      }),
    ])
  })

  it('derives JSON-classified workflow_dispatch rows independently from presentation', () => {
    const sources = deriveRuntimeSources({
      workflows: {
        source: 'workflows',
        rows: [
          {
            organization: 'githubnext',
            repository: 'control',
            workflow: 'worker.yml',
            'workflow-name': 'Dependency updater',
            'workflow-role': 'worker',
            package: 'dependabot',
            'package-name': 'Dependabot',
          },
          {
            organization: 'githubnext',
            repository: 'control',
            workflow: 'root.yml',
            'workflow-name': 'Dependency orchestrator',
            'workflow-role': 'orchestrator',
            package: 'dependabot',
          },
          {
            organization: 'githubnext',
            repository: 'control',
            workflow: 'standalone.yml',
            'workflow-name': 'Standalone task',
            'workflow-role': 'standalone',
          },
        ],
        metadata,
      },
      runs: {
        source: 'runs',
        rows: [
          {
            organization: 'githubnext',
            repository: 'control',
            workflow: 'worker.yml',
            run: '3',
            event: 'workflow_dispatch',
            'run-title': 'Update dependencies',
            'started-at': '2026-08-30T07:00:00Z',
            'run-conclusion': 'success',
            engine: 'copilot',
            'resolved-model': 'gpt-5',
            'run-link': {
              relation: 'run',
              href: 'https://github.com/githubnext/control/actions/runs/3',
              label: 'Run 3',
            },
          },
          {
            organization: 'githubnext',
            repository: 'control',
            workflow: 'root.yml',
            run: '2',
            event: 'workflow_dispatch',
            'run-conclusion': 'failure',
            'admission-reason': 'github-api-capacity-insufficient',
            'resource-reset-at': '2026-09-03T13:00:00Z',
            engine: 'copilot',
            'requested-model': 'gpt-5',
          },
          {
            organization: 'githubnext',
            repository: 'control',
            workflow: 'standalone.yml',
            run: '1',
            event: 'workflow_dispatch',
            'run-status': 'in-progress',
          },
          {
            organization: 'githubnext',
            repository: 'control',
            workflow: 'worker.yml',
            run: '4',
            event: 'workflow_dispatch',
            'run-conclusion': 'skipped',
          },
          {
            organization: 'githubnext',
            repository: 'control',
            workflow: 'worker.yml',
            run: '0',
            event: 'schedule',
            'run-conclusion': 'failure',
          },
        ],
        metadata,
      },
      usage: {
        source: 'usage',
        rows: [
          {
            organization: 'githubnext',
            repository: 'control',
            workflow: 'worker.yml',
            run: '3',
            invocation: '1',
            aic: 12.5,
            engine: 'copilot',
            'resolved-model': 'gpt-5',
          },
        ],
        metadata,
      },
    })

    expect(sources.dispatches.rows).toEqual([
      expect.objectContaining({
        'dispatch-type': 'Package worker',
        package: 'dependabot',
        'package-name': 'Dependabot',
        'run-title': 'Update dependencies',
        status: 'success',
      }),
      expect.objectContaining({
        'dispatch-type': 'Package orchestrator',
        package: 'dependabot',
        'package-name': 'dependabot',
        'run-title': 'Run 2',
        status: 'failure',
        'status-detail': 'GitHub API capacity insufficient',
        'status-detail-at': '2026-09-03T13:00:00Z',
      }),
      expect.objectContaining({
        'dispatch-type': 'Standalone workflow',
        package: '',
        'package-name': 'Not packaged',
        'runtime-repository': 'githubnext/control',
        status: 'in-progress',
        'status-detail': '—',
      }),
      expect.objectContaining({
        'dispatch-type': 'Package worker',
        package: 'dependabot',
        'package-name': 'Dependabot',
        'run-title': 'Run 4',
        status: 'skipped',
        'status-detail': 'Skipped by a control-plane guard',
      }),
    ])
    expect(sources.dispatches.metadata).toBe(metadata)
    expect(sources['dispatch-activation-summary'].rows).toEqual([
      { label: 'Activation rate', value: '75%' },
      { label: 'Activated', value: '3' },
      { label: 'Skipped by guards', value: '1' },
      { label: 'Total dispatches', value: '4' },
    ])
    expect(sources['dispatch-activation-summary'].metadata).toBe(metadata)
    expect(sources['package-dispatch-state'].rows).toEqual([
      {
        package: 'dependabot',
        'package-name': 'Dependabot',
        'dispatch-runs': 3,
        skipped: 1,
        failed: 1,
        succeeded: 1,
        'worker-dispatches': 'Dependency updater: 2',
        aic: 12.5,
        agent: 'copilot',
        model: 'gpt-5',
      },
    ])
  })

  it('reports activation rate as not observed when no dispatches were retained', () => {
    const sources = deriveRuntimeSources({
      workflows: { source: 'workflows', rows: [], metadata },
      runs: { source: 'runs', rows: [], metadata },
    })

    expect(sources['dispatch-activation-summary'].rows).toEqual([
      { label: 'Activation rate', value: 'Not observed' },
      { label: 'Activated', value: '0' },
      { label: 'Skipped by guards', value: '0' },
      { label: 'Total dispatches', value: '0' },
    ])
  })

  it('uses retained Actions job and step evidence for failed dispatch details', () => {
    const sources = deriveRuntimeSources({
      workflows: {
        source: 'workflows',
        rows: [
          {
            organization: 'githubnext',
            repository: 'control',
            workflow: 'worker.yml',
            'workflow-name': 'Worker',
            'workflow-role': 'worker',
            package: 'dependabot',
          },
        ],
        metadata,
      },
      runs: {
        source: 'runs',
        rows: [
          {
            organization: 'githubnext',
            repository: 'control',
            workflow: 'worker.yml',
            run: '3',
            event: 'workflow_dispatch',
            'run-conclusion': 'failure',
            'failure-message':
              'Target authority missing: add .github/workflows/cao.json to the target default branch for live mode',
            'failure-job': 'pre_activation',
            'failure-step': 'Run CAO control precompute',
          },
          {
            organization: 'githubnext',
            repository: 'control',
            workflow: 'worker.yml',
            run: '2',
            event: 'workflow_dispatch',
            'run-conclusion': 'failure',
            'failure-job': 'pre_activation',
            'failure-step': 'Run CAO control precompute',
          },
          {
            organization: 'githubnext',
            repository: 'control',
            workflow: 'worker.yml',
            run: '1',
            event: 'workflow_dispatch',
            'run-conclusion': 'startup-failure',
            'failure-job': 'pre_activation',
          },
        ],
        metadata,
      },
    })

    expect(sources.dispatches.rows.map((row) => row['status-detail'])).toEqual([
      'Target authority missing: add .github/workflows/cao.json to the target default branch for live mode',
      'Run CAO control precompute failed',
      'Job failed: pre activation',
    ])
  })
})
