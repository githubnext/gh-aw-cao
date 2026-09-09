import { describe, expect, it } from 'vitest'
import { deriveOverviewSources } from '../../src/overview-data.js'

/** @type {import('../../src/presenter.js').SourceMetadata} */
const metadata = {
  'source-id': 'overview-fixture',
  'source-kind': 'fixture',
  'as-of': '2026-09-02T12:00:00Z',
  'retrieved-at': '2026-09-02T12:01:00Z',
  availability: 'available',
  completeness: 'complete',
  freshness: 'fresh',
}

/**
 * @param {string} name
 * @param {Array<Record<string, unknown>>} [rows]
 * @returns {import('../../src/presenter.js').LogicalSourceInput}
 */
function source(name, rows = []) {
  return { source: name, rows, metadata }
}

describe('overview attention', () => {
  it('recomputes readiness from event evidence inside the selected time window', () => {
    const workflow = {
      organization: 'githubnext',
      repository: 'gh-aw-cao',
      package: 'daily-ops',
      'package-name': 'Daily Ops',
      workflow: '.github/workflows/control.md',
      'workflow-role': 'orchestrator',
      'workflow-active': 'true',
      'inventory-ready': true,
    }
    const sources = deriveOverviewSources(
      {
        workflows: source('workflows', [workflow]),
        repositories: source('repositories'),
        runs: source('runs', [
          {
            ...workflow,
            run: 'old-failure',
            'started-at': '2026-09-01T10:00:00Z',
            'run-status': 'completed',
            'run-conclusion': 'failure',
          },
          {
            ...workflow,
            run: 'recent-success',
            'started-at': '2026-09-02T10:00:00Z',
            'run-status': 'completed',
            'run-conclusion': 'success',
          },
        ]),
        usage: source('usage'),
        outcomes: source('outcomes'),
        findings: source('findings', [
          {
            ...workflow,
            finding: 'old-warning',
            'finding-kind': 'authored-warning',
            'observed-at': '2026-09-01T11:00:00Z',
          },
        ]),
        'grader-observations': source('grader-observations'),
        'operational-values': source('operational-values'),
        'coverage-diagnostics': source('coverage-diagnostics'),
      },
      {
        readinessWindow: {
          start: '2026-09-02T00:00:00Z',
          end: '2026-09-03T00:00:00Z',
        },
      },
    )

    expect(sources['readiness-summary'].rows).toContainEqual({
      label: 'Control plane',
      value: 'Ready to ship',
    })
    expect(sources['readiness-observations'].rows).toEqual([])
    expect(sources['readiness-activity'].rows).toEqual([
      expect.objectContaining({
        'activity-hour': '2026-09-01T10:00:00.000Z',
        'in-window': false,
      }),
      expect.objectContaining({
        'activity-hour': '2026-09-02T10:00:00.000Z',
        'in-window': true,
      }),
    ])
    expect(sources['readiness-signals'].rows).not.toContainEqual(
      expect.objectContaining({
        kind: 'Runtime regression',
      }),
    )
    expect(sources['readiness-signals'].rows).not.toContainEqual(
      expect.objectContaining({
        kind: 'Output warning',
      }),
    )
  })

  it('blocks release readiness and surfaces runtime and evidence regressions', () => {
    const workflows = [
      {
        organization: 'githubnext',
        repository: 'gh-aw-cao',
        package: 'daily-ops',
        'package-name': 'Daily Ops',
        workflow: '.github/workflows/daily-ops.md',
        'workflow-role': 'orchestrator',
        'workflow-active': 'true',
        'inventory-ready': true,
      },
      {
        organization: 'githubnext',
        repository: 'gh-aw-cao',
        package: 'daily-ops',
        'package-name': 'Daily Ops',
        workflow: '.github/workflows/daily-ops-worker.md',
        'workflow-role': 'worker',
        'workflow-active': 'true',
        'inventory-ready': true,
      },
    ]
    const sources = deriveOverviewSources({
      workflows: source('workflows', workflows),
      repositories: source('repositories'),
      runs: {
        source: 'runs',
        metadata: { ...metadata, freshness: 'stale' },
        rows: [
          {
            organization: 'githubnext',
            repository: 'gh-aw-cao',
            workflow: workflows[0].workflow,
            run: '42',
            'started-at': '2026-09-02T11:12:00Z',
            'run-status': 'completed',
            'run-conclusion': 'failure',
            'failure-message': 'Readiness smoke test failed',
            'run-link': 'https://github.com/githubnext/gh-aw-cao/actions/runs/42',
          },
        ],
      },
      usage: source('usage'),
      outcomes: source('outcomes'),
      findings: source('findings'),
      'grader-observations': source('grader-observations'),
      'operational-values': source('operational-values'),
      'coverage-diagnostics': source('coverage-diagnostics'),
    })

    expect(sources['readiness-summary'].rows).toContainEqual({
      label: 'Control plane',
      value: 'Not ready',
    })
    expect(sources['readiness-checks'].rows).toContainEqual(
      expect.objectContaining({
        check: 'Evidence',
        'readiness-state': 'Unknown',
      }),
    )
    expect(sources['readiness-checks'].rows).toContainEqual(
      expect.objectContaining({
        check: 'Engine activity',
        'readiness-state': 'Blocked',
      }),
    )
    expect(sources['readiness-signals'].rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'Evidence regression',
          title: 'Runs evidence is not release-ready',
        }),
        expect.objectContaining({
          kind: 'Runtime regression',
          detail: expect.stringContaining('Readiness smoke test failed'),
        }),
      ]),
    )
  })

  it('attributes failures and warnings by control-plane role and retains no-op reports', () => {
    const workflows = [
      {
        organization: 'githubnext',
        repository: 'gh-aw-cao',
        workflow: '.github/workflows/control.md',
        'workflow-role': 'orchestrator',
      },
      {
        organization: 'githubnext',
        repository: 'gh-aw-cao',
        workflow: '.github/workflows/worker.md',
        'workflow-role': 'worker',
      },
      {
        organization: 'githubnext',
        repository: 'gh-aw-cao',
        workflow: '.github/workflows/standalone.md',
        'workflow-role': 'standalone',
      },
    ]
    const sources = deriveOverviewSources({
      workflows: source('workflows', workflows),
      repositories: source('repositories'),
      runs: source('runs', [
        {
          organization: 'githubnext',
          repository: 'gh-aw-cao',
          workflow: workflows[0].workflow,
          run: '1',
          'started-at': '2026-09-02T10:05:00Z',
          'run-status': 'completed',
          'run-conclusion': 'failure',
        },
        {
          organization: 'githubnext',
          repository: 'gh-aw-cao',
          workflow: workflows[1].workflow,
          run: '2',
          'started-at': '2026-09-02T10:35:00Z',
          'run-status': 'completed',
          'run-conclusion': 'failure',
        },
        {
          organization: 'githubnext',
          repository: 'gh-aw-cao',
          workflow: workflows[2].workflow,
          run: '3',
          'started-at': '2026-09-02T10:45:00Z',
          'run-status': 'completed',
          'run-conclusion': 'failure',
        },
      ]),
      usage: source('usage'),
      outcomes: source('outcomes', [
        {
          workflow: workflows[1].workflow,
          'workflow-role': 'worker',
          run: '4',
          'outcome-category': 'noop',
          'observed-at': '2026-09-02T11:00:00Z',
        },
        {
          workflow: workflows[2].workflow,
          'workflow-role': 'standalone',
          run: '5',
          'outcome-category': 'noop',
          'observed-at': '2026-09-02T11:30:00Z',
        },
      ]),
      findings: source('findings', [
        {
          workflow: workflows[0].workflow,
          'workflow-role': 'orchestrator',
          finding: 'warning-1',
          'finding-kind': 'authored-warning',
          'observed-at': '2026-09-02T10:00:00Z',
        },
        {
          workflow: workflows[1].workflow,
          'workflow-role': 'worker',
          finding: 'warning-2',
          'finding-kind': 'authored-warning',
          'observed-at': '2026-09-02T10:30:00Z',
        },
        {
          workflow: workflows[2].workflow,
          'workflow-role': 'standalone',
          finding: 'warning-3',
          'finding-kind': 'authored-warning',
          'observed-at': '2026-09-02T10:45:00Z',
        },
      ]),
      'grader-observations': source('grader-observations'),
      'operational-values': source('operational-values'),
      'coverage-diagnostics': source('coverage-diagnostics'),
    })

    expect(sources['readiness-activity'].rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          'activity-hour': '2026-09-02T10:00:00.000Z',
          'workflow-role': 'orchestrator',
          'run-count': 1,
        }),
        expect.objectContaining({
          'activity-hour': '2026-09-02T10:00:00.000Z',
          'workflow-role': 'worker',
          'run-count': 1,
        }),
      ]),
    )
    expect(sources['readiness-observations'].rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          signal: 'Orchestrator failures',
          count: 1,
          status: 'Attention',
        }),
        expect.objectContaining({
          signal: 'Orchestrator warnings',
          count: 1,
          status: 'Attention',
        }),
        expect.objectContaining({
          signal: 'Worker failures',
          count: 1,
          status: 'Attention',
        }),
        expect.objectContaining({
          signal: 'Worker warnings',
          count: 1,
          status: 'Attention',
        }),
        expect.objectContaining({
          signal: 'No-op reports',
          count: 1,
          status: 'Observed',
        }),
      ]),
    )
    expect(sources['readiness-observations'].rows).toHaveLength(5)
    expect(sources['readiness-signals'].rows.filter((row) => row.kind === 'Runtime regression')).toHaveLength(2)
    expect(sources['readiness-checks'].rows).toContainEqual(
      expect.objectContaining({
        check: 'Outputs',
        'readiness-state': 'Blocked',
      }),
    )
  })

  it('blocks readiness when the control-plane engine is not churning', () => {
    const sources = deriveOverviewSources({
      workflows: source('workflows', [
        {
          package: 'daily-ops',
          workflow: '.github/workflows/control.md',
          'workflow-role': 'orchestrator',
          'workflow-active': 'true',
          'inventory-ready': true,
        },
        {
          package: 'daily-ops',
          workflow: '.github/workflows/worker.md',
          'workflow-role': 'worker',
          'workflow-active': 'true',
          'inventory-ready': true,
        },
      ]),
      repositories: source('repositories'),
      runs: source('runs'),
      usage: source('usage'),
      outcomes: source('outcomes'),
      findings: source('findings'),
      'grader-observations': source('grader-observations'),
      'operational-values': source('operational-values'),
      'coverage-diagnostics': source('coverage-diagnostics'),
    })

    expect(sources['readiness-checks'].rows[0]).toEqual({
      check: 'Engine activity',
      'readiness-state': 'Blocked',
      detail: 'No completed control-plane runs were observed in the current window.',
    })
    expect(sources['readiness-summary'].rows).toContainEqual({
      label: 'Engine activity',
      value: '0 completed runs observed',
    })
  })

  it('ignores in-progress runs in readiness activity and release gating', () => {
    const workflow = {
      organization: 'githubnext',
      repository: 'gh-aw-cao',
      package: 'daily-ops',
      workflow: '.github/workflows/control.md',
      'workflow-role': 'orchestrator',
      'workflow-active': 'true',
      'inventory-ready': true,
    }
    const sources = deriveOverviewSources({
      workflows: source('workflows', [workflow]),
      repositories: source('repositories'),
      runs: source('runs', [
        {
          ...workflow,
          run: 'completed',
          'run-status': 'completed',
          'run-conclusion': 'success',
          'started-at': '2026-09-02T10:00:00Z',
        },
        {
          ...workflow,
          run: 'pending',
          'run-status': 'in_progress',
          'started-at': '2026-09-02T11:00:00Z',
        },
      ]),
      usage: source('usage'),
      outcomes: source('outcomes'),
      findings: source('findings'),
      'grader-observations': source('grader-observations'),
      'operational-values': source('operational-values'),
      'coverage-diagnostics': source('coverage-diagnostics'),
    })

    expect(sources['readiness-checks'].rows[0]).toEqual({
      check: 'Engine activity',
      'readiness-state': 'Ready',
      detail: '1 runs completed successfully.',
    })
    expect(sources['readiness-summary'].rows).toContainEqual({
      label: 'Engine activity',
      value: '1 completed runs observed · 0 failed',
    })
    expect(sources['readiness-signals'].rows).not.toContainEqual(expect.objectContaining({ kind: 'Run pending' }))
    expect(sources['readiness-activity'].rows).toEqual([expect.objectContaining({ 'run-count': 1 })])
  })

  it('blocks on unresolved role joins without rendering unattributed observations', () => {
    const sources = deriveOverviewSources({
      workflows: source('workflows', [
        {
          organization: 'githubnext',
          repository: 'gh-aw-cao',
          package: 'daily-ops',
          workflow: '.github/workflows/control.md',
          'workflow-role': 'orchestrator',
          'workflow-active': 'true',
          'inventory-ready': true,
        },
      ]),
      repositories: source('repositories'),
      runs: source('runs', [
        {
          organization: 'githubnext',
          repository: 'gh-aw-cao',
          workflow: '.github/workflows/control.md',
          run: '1',
          'run-status': 'completed',
          'run-conclusion': 'success',
        },
      ]),
      usage: source('usage'),
      outcomes: source('outcomes', [
        {
          workflow: '.github/workflows/missing.md',
          'workflow-role': 'unknown',
          'outcome-category': 'noop',
        },
      ]),
      findings: source('findings', [
        {
          workflow: '.github/workflows/missing.md',
          'workflow-role': 'unknown',
          'finding-kind': 'authored-warning',
        },
      ]),
      'grader-observations': source('grader-observations'),
      'operational-values': source('operational-values'),
      'coverage-diagnostics': source('coverage-diagnostics'),
    })

    expect(sources['readiness-checks'].rows).toContainEqual(
      expect.objectContaining({
        check: 'Evidence',
        'readiness-state': 'Blocked',
        detail: '2 relevant records could not be joined to workflow inventory.',
      }),
    )
    expect(sources['readiness-signals'].rows).toContainEqual(
      expect.objectContaining({
        kind: 'Attribution regression',
        count: 2,
      }),
    )
    expect(sources['readiness-observations'].rows.map((row) => row.signal)).not.toContain(expect.stringContaining('Unattributed'))
  })

  it('summarizes recent package dispatch states', () => {
    const workflow = {
      organization: 'githubnext',
      repository: 'gh-aw-cao',
      package: 'daily-ops',
      'package-name': 'Daily Ops',
      workflow: '.github/workflows/daily.yml',
      'workflow-role': 'orchestrator',
    }
    /** @param {string} run @param {string} conclusion @param {string} [status] */
    const dispatch = (run, conclusion, status = 'completed') => ({
      organization: 'githubnext',
      repository: 'gh-aw-cao',
      workflow: workflow.workflow,
      event: 'workflow_dispatch',
      run,
      'run-status': status,
      'run-conclusion': conclusion,
    })
    const sources = deriveOverviewSources({
      workflows: source('workflows', [workflow]),
      repositories: source('repositories'),
      runs: source('runs', [
        dispatch('1', 'success'),
        dispatch('2', 'failure'),
        dispatch('3', 'action-required'),
        dispatch('4', 'unknown', 'in-progress'),
        dispatch('5', 'cancelled'),
      ]),
      usage: source('usage'),
      outcomes: source('outcomes'),
      findings: source('findings'),
      'grader-observations': source('grader-observations'),
      'operational-values': source('operational-values'),
      'coverage-diagnostics': source('coverage-diagnostics'),
    })

    expect(sources['overview-managed-packages'].rows).toContainEqual(
      expect.objectContaining({
        package: 'daily-ops',
        'dispatch-count': 5,
        'dispatch-success-count': 1,
        'dispatch-failure-count': 1,
        'dispatch-approval-count': 1,
        'dispatch-pending-count': 1,
      }),
    )
  })

  it('promotes unavailable control policy resolution to act-now attention', () => {
    const sources = deriveOverviewSources({
      workflows: source('workflows'),
      repositories: source('repositories'),
      runs: source('runs'),
      usage: source('usage'),
      outcomes: source('outcomes'),
      findings: source('findings'),
      'grader-observations': source('grader-observations'),
      'operational-values': source('operational-values'),
      'coverage-diagnostics': source('coverage-diagnostics', [
        {
          title: 'Control policy resolution unavailable',
          effect: 'control-plane is required',
        },
      ]),
    })

    expect(sources['overview-attention'].rows).toContainEqual(
      expect.objectContaining({
        tone: 'danger',
        title: 'Control policy resolution unavailable',
        detail: 'control-plane is required',
      }),
    )
    expect(sources['overview-attention-domains'].rows).toContainEqual(
      expect.objectContaining({
        state: 'Act now',
        tone: 'critical',
        domain: 'Security & controls',
        value: '1 signal',
        detail: expect.stringContaining('1 policy resolution blocks'),
        href: '#page-coverage',
      }),
    )
  })

  it('promotes policy-blocked workflows to act-now admission attention', () => {
    const sources = deriveOverviewSources({
      workflows: source('workflows', [
        {
          package: 'dependabot',
          'package-name': 'Dependabot',
          workflow: '.github/workflows/dependabot-release-train-updater.md',
          'workflow-role': 'worker',
          'workflow-active': 'true',
          'admission-status': 'blocked',
          'admission-reason': 'worker-disabled',
        },
      ]),
      repositories: source('repositories'),
      runs: source('runs'),
      usage: source('usage'),
      outcomes: source('outcomes'),
      findings: source('findings'),
      'grader-observations': source('grader-observations'),
      'operational-values': source('operational-values'),
      'coverage-diagnostics': source('coverage-diagnostics'),
    })

    expect(sources['overview-attention'].rows).toContainEqual(
      expect.objectContaining({
        tone: 'danger',
        title: '1 workflow blocked by admission',
        detail: 'worker-disabled',
      }),
    )
    expect(sources['overview-attention-domains'].rows).toContainEqual(
      expect.objectContaining({
        state: 'Act now',
        tone: 'critical',
        domain: 'Security & controls',
        value: '1 signal',
        detail: expect.stringContaining('1 admission gates'),
        href: '#page-security',
      }),
    )
    expect(sources['security-summary'].rows).toContainEqual({
      label: 'Admission gates',
      value: 1,
    })
    expect(sources['security-signals'].rows).toContainEqual(
      expect.objectContaining({
        tone: 'danger',
        kind: 'Admission gate',
        title: 'Dependabot',
        detail: 'worker-disabled',
        evidence: 'Checked-in control policy',
        'navigation-page': 'packages',
      }),
    )
  })

  it('promotes GitHub API capacity admission blocks with retry guidance', () => {
    const workflow = '.github/workflows/self-care.md'
    const officialGuidance = 'https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api'
    const sources = deriveOverviewSources({
      workflows: source('workflows', [
        {
          workflow,
          'workflow-name': 'SelfCare',
          'workflow-role': 'orchestrator',
        },
      ]),
      repositories: source('repositories'),
      runs: source('runs', [
        {
          workflow,
          run: '33682053183',
          'run-conclusion': 'failure',
          'admission-status': 'resource-limited',
          'admission-reason': 'github-api-capacity-insufficient',
          resource: 'github-rest-api',
          'resource-reset-at': '2026-09-02T22:04:33.000Z',
          'resource-wait-hours': 1.08,
        },
      ]),
      usage: source('usage'),
      outcomes: source('outcomes'),
      findings: source('findings'),
      'grader-observations': source('grader-observations'),
      'operational-values': source('operational-values'),
      'coverage-diagnostics': source('coverage-diagnostics'),
    })

    expect(sources['overview-attention'].rows).toContainEqual(
      expect.objectContaining({
        tone: 'danger',
        title: '1 run blocked by GitHub API capacity',
        detail: expect.stringContaining('approximately 1.08 hours'),
      }),
    )
    expect(sources['overview-attention'].rows).not.toContainEqual(expect.objectContaining({ title: '1 failed run' }))
    expect(sources['overview-attention-domains'].rows).toContainEqual(
      expect.objectContaining({
        state: 'Act now',
        domain: 'Security & controls',
        value: '1 signal',
        detail: expect.stringContaining('1 API capacity gates'),
      }),
    )
    expect(sources['security-summary'].rows).toContainEqual({
      label: 'API capacity gates',
      value: 1,
    })
    expect(sources['security-signals'].rows).toContainEqual(
      expect.objectContaining({
        kind: 'Resource admission gate',
        title: 'SelfCare',
        detail: expect.stringContaining('2026-09-02T22:04:33.000Z'),
        action: 'Open official GitHub guidance',
        'external-link': expect.objectContaining({ href: officialGuidance }),
      }),
    )
  })

  it('builds the Overview inbox only from actionable Work, Agents, Evidence, and Insights states', () => {
    const sources = deriveOverviewSources({
      workflows: source('workflows'),
      repositories: source('repositories'),
      runs: source('runs'),
      outcomes: source('outcomes'),
      findings: source('findings'),
      'grader-observations': source('grader-observations'),
      'coverage-diagnostics': source('coverage-diagnostics'),
      'attention-signals': source('attention-signals', [
        {
          'attention-signal-id': 'blocked',
          'signal-type': 'blocked',
          objective: 'Blocked deployment',
          priority: 1,
        },
        {
          'attention-signal-id': 'scheduled',
          'signal-type': 'waiting',
          objective: 'Scheduled work',
          priority: 2,
        },
      ]),
      'agent-assignments': source('agent-assignments', [
        { 'assignment-id': 'stale', 'agent-name': 'Stale agent', stale: true },
        {
          'assignment-id': 'healthy',
          'agent-name': 'Healthy agent',
          stale: false,
          'long-running': false,
        },
      ]),
      'evidence-records': source('evidence-records', [
        {
          'evidence-id': 'uncertain',
          objective: 'Pending claim',
          'verification-state': 'pending',
          'provenance-state': 'complete',
        },
        {
          'evidence-id': 'accepted',
          objective: 'Accepted claim',
          'verification-state': 'accepted',
          'provenance-state': 'durable',
        },
      ]),
      usage: source('usage'),
      'operational-values': source('operational-values'),
      'github-api-rate-limits': source('github-api-rate-limits', [
        { resource: 'core', 'risk-status': 'warning', 'remaining-percent': 10 },
        {
          resource: 'graphql',
          'risk-status': 'healthy',
          'remaining-percent': 95,
        },
      ]),
    })

    expect(sources['attention-signals'].rows).toHaveLength(4)
    expect(sources['attention-signals'].rows.map((row) => row['navigation-page'])).toEqual(['work', 'agents', 'insights', 'insights'])
    expect(sources['attention-signals'].rows.map((row) => row.objective)).not.toContain('Scheduled work')
    expect(sources['attention-signals'].rows.map((row) => row.objective)).not.toContain('Healthy agent')
    expect(sources['attention-signals'].rows.map((row) => row.objective)).not.toContain('Accepted claim')
  })
})

describe('overview large data', () => {
  it('derives a high-cardinality inbox within a linear-time budget', () => {
    const attentionSignals = Array.from({ length: 50_000 }, (_, index) => ({
      'attention-signal-id': `signal-${index}`,
      'signal-type': 'runtime-failure',
      objective: `Investigate failure ${index}`,
      reason: `Run ${index} failed`,
    }))
    const startedAt = performance.now()

    const sources = deriveOverviewSources({
      'attention-signals': source('attention-signals', attentionSignals),
    })

    expect(sources['attention-signals'].rows).toHaveLength(50_000)
    expect(performance.now() - startedAt).toBeLessThan(2_000)
  }, 10_000)
})
