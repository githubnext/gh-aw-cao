import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  effectiveDashboardSources,
  missingDashboardSources,
} from '../e2e/dashboard-view-sources.mjs'

const available = {
  availability: 'available',
  completeness: 'complete',
}

test('dashboard view assessment recognizes renderer-derived sources', () => {
  const sources = effectiveDashboardSources({
    repositories: { rows: [], metadata: available },
    workflows: { rows: [], metadata: available },
    runs: { rows: [], metadata: available },
    usage: { rows: [], metadata: available },
    outcomes: { rows: [], metadata: available },
    findings: { rows: [], metadata: available },
  })
  const page = {
    views: [
      { data: { source: 'readiness-activity' } },
      { data: { source: 'repository-activity' } },
      { data: { source: 'workflow-runs' } },
      { data: { source: 'packaged-workflows' } },
      { data: { source: 'dispatches' } },
      { data: { source: 'package-reports' } },
      { data: { source: 'data-health-summary' } },
    ],
  }

  assert.deepEqual(missingDashboardSources(page, sources), [])
})

test('dashboard view assessment still reports unavailable derived sources', () => {
  const sources = effectiveDashboardSources({
    workflows: { rows: [], metadata: available },
    outcomes: {
      rows: [],
      metadata: { availability: 'unavailable', completeness: 'unknown' },
    },
  })

  assert.deepEqual(
    missingDashboardSources({ data: { source: 'workflow-reports' } }, sources),
    ['workflow-reports: missing or unavailable'],
  )
})
