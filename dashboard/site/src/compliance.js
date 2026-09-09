/**
 * Compliance fixtures and machine-readable conformance helpers for the dashboard validator and presenter.
 */

import { validateDashboardDocument, validateLogicalSources } from './validator.js'
import { renderDashboard } from './presenter.js'

export const IMPLEMENTATION_VERSION = '0.1.0-prototype'

/** @typedef {'pass'|'fail'} ComplianceStatus */
/** @typedef {{ testId: string, requirementId: string, implementationVersion: string, status: ComplianceStatus, failureEvidence: string | null }} ComplianceResult */

export const appendixAFixture = `language-version: "0.1.0"
dashboard:
  id: agentic-operations
  title: Agentic Operations
  description: Workflow activity, usage, findings, and operational value.
  defaults:
    scope:
      organizations:
        - octo-org
    time:
      range: 30d
    filters:
      rollout-mode:
        - review
        - live
  pages:
    - id: overview
      kind: built-in
      page: overview
      title: Overview
      definition:
        data-state:
          availability: true
          completeness: true
          freshness: true
        views:
          - id: repository-overview
            data:
              source: repositories
            mark: metric
            encoding:
              value:
                field: repository
                aggregate: distinct-count
          - id: workflow-overview
            data:
              source: workflows
            mark: table
            encoding:
              columns:
                - field: workflow-active
                - field: rollout-mode
          - id: run-overview
            disclosure: supplemental
            data:
              source: runs
            mark: table
            encoding:
              columns:
                - field: run-status
                - field: run-conclusion
                - field: repository
                - field: workflow
          - id: usage-overview
            data:
              source: usage
            mark: metric
            encoding:
              value:
                field: aic
                type: quantitative
                aggregate: sum
          - id: findings-overview
            disclosure: supplemental
            data:
              source: findings
            mark: table
            encoding:
              columns:
                - field: finding-summary
                - field: observed-at
                - field: issue-link
                - field: pull-request-link
                - field: run-link
          - id: value-overview
            disclosure: supplemental
            data:
              source: operational-values
            mark: table
            encoding:
              columns:
                - field: operational-value
                - field: operational-value-definition
                - field: observed-at
    - id: workflows
      kind: built-in
      page: workflows
      title: Workflows
      definition:
        data-state:
          availability: true
          completeness: true
          freshness: true
        views:
          - id: workflow-inventory
            data:
              source: workflow-inventory
            mark: table
            encoding:
              columns:
                - field: package-name
                - field: repository
                - field: workflow
                - field: workflow-role
                - field: workflow-active
                - field: rollout-mode
                - field: aic
                - field: runs
    - id: usage-by-repository
      kind: custom
      title: Usage by Repository
      views:
        - id: total-aic
          title: Total AI Credits
          data:
            source: usage
          mark: metric
          encoding:
            value:
              field: aic
              type: quantitative
              aggregate: sum
        - id: daily-runs
          title: Daily Runs
          data:
            source: runs
          mark: chart
          encoding:
            x:
              field: started-at
              type: temporal
              time-unit: day
            y:
              field: run
              type: quantitative
              aggregate: count
            color:
              field: rollout-mode
              type: nominal
        - id: largest-spenders
          title: Largest AIC Spenders
          data:
            source: usage
            limit: 10
            order-by:
              - field: sum-aic
                direction: desc
          mark: table
          encoding:
            columns:
              - field: repository
                type: nominal
              - field: aic
                type: quantitative
                aggregate: sum
                as: sum-aic
`

export const appendixCFixtures = {
  multipleDocuments: {
    requirementId: 'DLS-DOC-001',
    yaml: `language-version: "0.1.0"
dashboard: {}
---
language-version: "0.1.0"
dashboard: {}
`,
    expectedCode: 'DLS-E002',
  },
  nonCanonicalId: {
    requirementId: 'DLS-DOC-005',
    yaml: `language-version: "0.1.0"
dashboard:
  id: Agentic_Operations
  title: Agentic Operations
  pages: []
`,
    expectedCode: 'DLS-E005',
  },
  forbiddenJoinAndExpression: {
    requirementId: 'DLS-DOC-007',
    yaml: `language-version: "0.1.0"
dashboard:
  id: combined-usage
  title: Combined Usage
  pages:
    - id: combined-usage
      kind: custom
      views:
        - id: calculated-cost
          data:
            source: usage
          join: runs
          mark: metric
          encoding:
            value:
              expression: raw-token-count * rate
`,
    expectedCode: 'DLS-E004',
  },
  incompatibleMeasure: {
    requirementId: 'DLS-AGG-005',
    yaml: `language-version: "0.1.0"
dashboard:
  id: summed-value
  title: Summed Value
  pages:
    - id: value-page
      kind: custom
      title: Value
      views:
        - id: value-total
          data:
            source: operational-values
          mark: metric
          encoding:
            value:
              field: operational-value
              aggregate: sum
`,
    expectedCode: 'DLS-E010',
  },
  invalidWorkflowRelationship: {
    requirementId: 'DLS-SEM-003',
    yaml: `language-version: "0.1.0"
dashboard:
  id: invalid-workflow-scope
  title: Invalid Workflow Scope
  pages:
    - id: invalid-page
      kind: custom
      title: Invalid Page
      views:
        - id: invalid-view
          data:
            source: repositories
            filters:
              workflow: .github/workflows/ci.yml
          mark: table
          encoding:
            columns:
              - field: repository
`,
    expectedCode: 'DLS-E004',
  },
  invalidRunUnknownConclusion: {
    requirementId: 'DLS-SEM-006',
    yaml: `language-version: "0.1.0"
dashboard:
  id: invalid-run-conclusion
  title: Invalid Run Conclusion
  pages:
    - id: runs-page
      kind: custom
      title: Runs
      views:
        - id: invalid-filter
          data:
            source: runs
            filters:
              run-conclusion: in_progress
          mark: table
          encoding:
            columns:
              - field: run
`,
    expectedCode: 'DLS-E005',
  },
  invalidRolloutMode: {
    requirementId: 'DLS-SEM-021',
    yaml: `language-version: "0.1.0"
dashboard:
  id: invalid-rollout-mode
  title: Invalid Rollout Mode
  pages:
    - id: runs-page
      kind: custom
      title: Runs
      views:
        - id: invalid-rollout-filter
          data:
            source: runs
            filters:
              rollout-mode: preview
          mark: table
          encoding:
            columns:
              - field: run
`,
    expectedCode: 'DLS-E005',
  },
  invalidTimeRangeCombination: {
    requirementId: 'DLS-CTX-009',
    yaml: `language-version: "0.1.0"
dashboard:
  id: invalid-time-range
  title: Invalid Time Range
  defaults:
    time:
      range: 7d
      start: '2026-08-01T00:00:00Z'
  pages:
    - id: usage-page
      kind: custom
      title: Usage
      views:
        - id: total-aic
          data:
            source: usage
          mark: metric
          encoding:
            value:
              field: aic
              type: quantitative
              aggregate: sum
`,
    expectedCode: 'DLS-E010',
  },
}

/**
 * @returns {ComplianceResult[]}
 */
export function runComplianceSmokeSuite() {
  /** @type {ComplianceResult[]} */
  const results = []

  const appendixAValidation = validateDashboardDocument(appendixAFixture)
  const appendixASources = createAppendixASources()
  results.push(createResult('T-DOC-001', 'DLS-DOC-001', appendixAValidation.ok, appendixAValidation.ok ? null : summarizeErrors(appendixAValidation.errors)))
  results.push(createResult('T-PAGE-001', 'DLS-PAGE-001', appendixAValidation.ok, appendixAValidation.ok ? null : summarizeErrors(appendixAValidation.errors)))
  results.push(
    createResult(
      'T-TEST-001',
      'DLS-TEST-003',
      fixtureIncludesExactTimeAndMissingDataCoverage(),
      fixtureIncludesExactTimeAndMissingDataCoverage()
        ? null
        : 'Appendix A fixture metadata did not include exact time and explicit missing-data distinctions.',
    ),
  )
  results.push(...runSemanticComplianceChecks())
  results.push(...runContextComplianceChecks())

  for (const fixture of Object.values(appendixCFixtures)) {
    const result = validateDashboardDocument(fixture.yaml)
    const hasExpectedCode = !result.ok && result.errors.some((error) => error.code === fixture.expectedCode)
    results.push(
      createResult(
        fixtureToTestId(fixture.requirementId),
        fixture.requirementId,
        hasExpectedCode,
        hasExpectedCode ? null : summarizeErrors(result.ok ? [] : result.errors),
      ),
    )
  }

  if (appendixAValidation.ok) {
    const element = renderDashboard({
      document: appendixAValidation.value,
      sources: appendixASources,
    })
    const summaryText = element.textContent || ''
    const exposesDataState = summaryText.includes('Availability') && summaryText.includes('Completeness') && summaryText.includes('Freshness')
    results.push(
      createResult(
        'T-DATA-001',
        'DLS-DATA-003',
        exposesDataState,
        exposesDataState ? null : 'Rendered Appendix A fixture did not expose page or view source metadata and data-state text.',
      ),
    )
    results.push(...runPageComplianceChecks(appendixAValidation.value, appendixASources))
    results.push(...runLinkComplianceChecks(appendixAValidation.value, appendixASources))
  } else {
    results.push(createResult('T-DATA-001', 'DLS-DATA-003', false, summarizeErrors(appendixAValidation.errors)))
    results.push(createResult('T-PAGE-001', 'DLS-PAGE-014', false, summarizeErrors(appendixAValidation.errors)))
    results.push(createResult('T-LINK-001', 'DLS-LINK-006', false, summarizeErrors(appendixAValidation.errors)))
  }

  return results
}

/**
 * @returns {ComplianceResult[]}
 */
function runSemanticComplianceChecks() {
  const validDocument = validateDashboardDocument(semanticFoundationsFixture)
  const semanticSources = createSemanticFixtureSources()
  const validSources = validateLogicalSources(semanticSources)
  const semanticAcceptanceRequirements = [
    'DLS-SEM-001',
    'DLS-SEM-002',
    'DLS-SEM-004',
    'DLS-SEM-005',
    'DLS-SEM-007',
    'DLS-SEM-008',
    'DLS-SEM-009',
    'DLS-SEM-010',
    'DLS-SEM-011',
    'DLS-SEM-012',
    'DLS-SEM-013',
    'DLS-SEM-015',
    'DLS-SEM-016',
    'DLS-SEM-017',
    'DLS-SEM-021',
  ]

  /** @type {ComplianceResult[]} */
  const results = semanticAcceptanceRequirements.map((requirementId) =>
    createResult(requirementToTestId(requirementId), requirementId, validDocument.ok, validDocument.ok ? null : summarizeErrors(validDocument.errors)),
  )

  const presenterElement = validDocument.ok
    ? renderDashboard({
        document: validDocument.value,
        sources: semanticSources,
      })
    : null
  const presenterText = presenterElement?.textContent || ''
  const hasNonCausationStatement = presenterText.includes('without implying causation')
  results.push(
    createResult(
      'T-SEM-002',
      'DLS-SEM-014',
      hasNonCausationStatement,
      hasNonCausationStatement ? null : 'Presenter output did not include the required non-causation statement for experiments.',
    ),
  )

  const invalidMembership = validateLogicalSources({
    workflows: {
      rows: [
        { workflow: 'orchestrator.yml', 'workflow-role': 'orchestrator' },
        {
          workflow: 'standalone.yml',
          'workflow-role': 'standalone',
          package: 'invalid-package',
        },
      ],
    },
  })
  const packageMembershipCovered = validSources.ok && !invalidMembership.ok
  results.push(
    createResult(
      'T-SEM-003',
      'DLS-SEM-022',
      packageMembershipCovered,
      packageMembershipCovered ? null : 'Package workflow role and membership fixtures did not produce the expected acceptance and rejection results.',
    ),
  )

  const invalidNegativeAllowance = validateLogicalSources({
    workflows: {
      rows: [
        {
          organization: 'octo-org',
          repository: 'platform',
          package: 'daily-ops',
          workflow: 'orchestrator.yml',
          'workflow-role': 'orchestrator',
          'max-ai-credits': -1,
        },
      ],
    },
  })
  const invalidMismatchedAllowance = validateLogicalSources({
    workflows: {
      rows: [
        {
          organization: 'octo-org',
          repository: 'platform',
          package: 'daily-ops',
          workflow: 'orchestrator.yml',
          'workflow-role': 'orchestrator',
          'max-ai-credits': 100,
          'package-aic-allowance': 99,
        },
      ],
    },
  })
  const packageAllowanceCovered = validSources.ok && !invalidNegativeAllowance.ok && !invalidMismatchedAllowance.ok
  results.push(
    createResult(
      'T-SEM-003',
      'DLS-SEM-023',
      packageAllowanceCovered,
      packageAllowanceCovered ? null : 'Package allowance fixtures did not produce the expected non-negative and summed-limit validation results.',
    ),
  )

  return results
}

/**
 * @returns {ComplianceResult[]}
 */
function runContextComplianceChecks() {
  const validDocument = validateDashboardDocument(contextFixture)
  const requirements = ['DLS-CTX-001', 'DLS-CTX-002', 'DLS-CTX-004', 'DLS-CTX-005', 'DLS-CTX-006', 'DLS-CTX-009']

  return requirements.map((requirementId) =>
    createResult(requirementToTestId(requirementId), requirementId, validDocument.ok, validDocument.ok ? null : summarizeErrors(validDocument.errors)),
  )
}

/**
 * @param {import('./presenter.js').PresentationDocument} document
 * @param {Record<string, import('./presenter.js').LogicalSourceInput>} sources
 * @returns {ComplianceResult[]}
 */
function runPageComplianceChecks(document, sources) {
  const rendered = renderDashboard({ document, sources })
  const text = rendered.textContent || ''
  const exposesAvailability = text.includes('Availability')
  const exposesCompleteness = text.includes('Completeness')
  const exposesFreshness = text.includes('Freshness')
  const hasIndependentDataStates = exposesAvailability && exposesCompleteness && exposesFreshness
  const pageTitles = ['Overview', 'Workflows', 'Usage by Repository']
  const hasRequiredPageTitles = pageTitles.every((title) => text.includes(title))

  return [
    createResult(
      'T-PAGE-001',
      'DLS-PAGE-001',
      hasRequiredPageTitles,
      hasRequiredPageTitles ? null : 'Rendered Appendix A fixture did not expose the expected built-in and custom page titles.',
    ),
    createResult(
      'T-PAGE-001',
      'DLS-PAGE-014',
      hasIndependentDataStates,
      hasIndependentDataStates ? null : 'Rendered built-in fixture did not expose independent availability, completeness, and freshness text.',
    ),
  ]
}

/**
 * @param {import('./presenter.js').PresentationDocument} document
 * @param {Record<string, import('./presenter.js').LogicalSourceInput>} sources
 * @returns {ComplianceResult[]}
 */
function runLinkComplianceChecks(document, sources) {
  const rendered = renderDashboard({ document, sources })
  const pageSections = [...rendered.querySelectorAll('.dashboard-page')].filter((page) => page instanceof HTMLElement && !page.hidden)
  const activePage = pageSections[0] ?? rendered
  const linkElements = [...activePage.querySelectorAll('a[href]')]
  const anchorsByLabel = new Map(linkElements.map((element) => [element.textContent?.trim() || '', element]))
  const expectedLinks = [
    {
      label: 'Issue #7',
      href: 'https://github.com/octo-org/platform/issues/7',
    },
    { label: 'PR #12', href: 'https://github.com/octo-org/platform/pull/12' },
    {
      label: 'Run 1001',
      href: 'https://github.com/octo-org/platform/actions/runs/1001',
    },
  ]
  /**
   * @param {string | null | undefined} text
   * @returns {string}
   */
  const normalizeAnchorText = (text) =>
    String(text || '')
      .replace(/\s+/g, ' ')
      .trim()
  const missingLinks = expectedLinks.filter(({ label, href }) => {
    const anchor = anchorsByLabel.get(label) ?? linkElements.find((element) => normalizeAnchorText(element.textContent) === label) ?? null
    return !(anchor instanceof HTMLAnchorElement) || anchor.getAttribute('href') !== href
  })
  const passes = missingLinks.length === 0

  return [
    createResult(
      'T-LINK-001',
      'DLS-LINK-003',
      passes,
      passes ? null : `Rendered fixture did not expose required available associations: ${missingLinks.map(({ label }) => label).join(', ')}`,
    ),
    createResult(
      'T-LINK-001',
      'DLS-LINK-006',
      passes,
      passes
        ? null
        : `Rendered fixture did not render every available GitHub-addressable entity as a link: ${missingLinks.map(({ label }) => label).join(', ')}`,
    ),
  ]
}

/**
 * @param {string} requirementId
 * @returns {string}
 */
function requirementToTestId(requirementId) {
  if (requirementId.startsWith('DLS-SEM-')) {
    const numeric = Number.parseInt(requirementId.slice('DLS-SEM-'.length), 10)
    return numeric >= 17 ? 'T-SEM-003' : numeric >= 8 ? 'T-SEM-002' : 'T-SEM-001'
  }
  if (requirementId.startsWith('DLS-CTX-')) {
    return 'T-CTX-001'
  }
  if (requirementId.startsWith('DLS-LINK-')) {
    return 'T-LINK-001'
  }
  if (requirementId.startsWith('DLS-PAGE-')) {
    return 'T-PAGE-001'
  }
  if (requirementId.startsWith('DLS-VAL-')) {
    return 'T-VAL-001'
  }
  return 'T-DOC-001'
}

/**
 * @param {string} requirementId
 * @returns {string}
 */
function fixtureToTestId(requirementId) {
  return requirementToTestId(requirementId)
}

/**
 * @param {string} testId
 * @param {string} requirementId
 * @param {boolean} passed
 * @param {string | null} failureEvidence
 * @returns {ComplianceResult}
 */
function createResult(testId, requirementId, passed, failureEvidence) {
  return {
    testId,
    requirementId,
    implementationVersion: IMPLEMENTATION_VERSION,
    status: passed ? 'pass' : 'fail',
    failureEvidence: passed ? null : failureEvidence || 'No failure evidence recorded.',
  }
}

/**
 * @param {Array<{ code: string, path: string, message: string }>} errors
 * @returns {string}
 */
function summarizeErrors(errors) {
  if (errors.length === 0) {
    return 'Expected a validation failure but no coded errors were produced.'
  }
  return errors.map((error) => `${error.code} at ${error.path}: ${error.message}`).join('; ')
}

/**
 * @returns {boolean}
 */
function fixtureIncludesExactTimeAndMissingDataCoverage() {
  const sources = createAppendixASources()
  return Object.values(sources).every(
    (source) =>
      typeof source.metadata['as-of'] === 'string' &&
      typeof source.metadata['retrieved-at'] === 'string' &&
      typeof source.metadata.availability === 'string' &&
      typeof source.metadata.completeness === 'string' &&
      typeof source.metadata.freshness === 'string',
  )
}

const semanticFoundationsFixture = `language-version: "0.1.0"
dashboard:
  id: semantic-foundations
  title: Semantic Foundations
  pages:
    - id: experiments
      kind: built-in
      page: experiments
      title: Experiments & Evaluation
      definition:
        data-state:
          availability: true
          completeness: true
          freshness: true
        views:
          - id: experiments-definition
            data:
              source: experiments
            mark: table
            encoding:
              columns:
                - field: experiment
          - id: experiments-assignments
            disclosure: supplemental
            data:
              source: experiment-assignments
            mark: table
            encoding:
              columns:
                - field: run
                - field: variant
          - id: experiments-graders
            disclosure: supplemental
            data:
              source: grader-observations
            mark: table
            encoding:
              columns:
                - field: grader
          - id: experiments-evals
            disclosure: supplemental
            data:
              source: eval-observations
            mark: table
            encoding:
              columns:
                - field: eval
          - id: experiments-outcomes
            disclosure: supplemental
            data:
              source: outcomes
            mark: table
            encoding:
              columns:
                - field: outcome-state
          - id: experiments-usage
            data:
              source: usage
            mark: metric
            encoding:
              value:
                field: aic
                type: quantitative
                aggregate: sum
          - id: experiments-value
            disclosure: supplemental
            data:
              source: operational-values
            mark: table
            encoding:
              columns:
                - field: operational-value
    - id: semantic-custom
      kind: custom
      title: Semantic Custom
      views:
        - id: usage-inventory
          data:
            source: usage
            filters:
              rollout-mode: review
          mark: table
          encoding:
            columns:
              - field: run
              - field: engine
              - field: requested-model
              - field: resolved-model
              - field: input-tokens
              - field: output-tokens
              - field: cache-read-tokens
              - field: cache-write-tokens
              - field: reasoning-tokens
              - field: aic
        - id: eval-observations
          disclosure: supplemental
          data:
            source: eval-observations
            filters:
              eval-result:
                - YES
                - UNKNOWN
          mark: table
          encoding:
            columns:
              - field: eval
              - field: eval-result
              - field: requested-model
              - field: resolved-model
        - id: grader-observations
          disclosure: supplemental
          data:
            source: grader-observations
            filters:
              status:
                - pass
                - unavailable
          mark: table
          encoding:
            columns:
              - field: grader
              - field: value
              - field: status
        - id: operational-values
          disclosure: supplemental
          data:
            source: operational-values
          mark: table
          encoding:
            columns:
              - field: operational-value-definition
              - field: operational-value
              - field: delta-from-baseline
              - field: requested-evidence-at
              - field: evidence-cutoff
              - field: maturity-at
              - field: maturity-status
`

const contextFixture = `language-version: "0.1.0"
dashboard:
  id: context-composition
  title: Context Composition
  defaults:
    scope:
      organizations:
        - octo-org
      repositories:
        - octo-org/platform
      workflows:
        - .github/workflows/ci.yml
    time:
      start: '2026-08-01T00:00:00Z'
      end: '2026-09-01T00:00:00Z'
    filters:
      rollout-mode:
        - review
        - unknown
  pages:
    - id: context-page
      kind: custom
      title: Context Page
      views:
        - id: filtered-runs
          data:
            source: runs
            scope:
              repositories:
                - octo-org/platform
            time:
              start: '2026-08-10T00:00:00Z'
              end: '2026-08-20T00:00:00Z'
            filters:
              run-status:
                - completed
                - unknown
              rollout-mode: review
          mark: table
          encoding:
            columns:
              - field: run
              - field: rollout-mode
              - field: run-status
`

/**
 * @returns {Record<string, import('./presenter.js').LogicalSourceInput>}
 */
function createAppendixASources() {
  return {
    workflows: {
      source: 'workflows',
      metadata: {
        'source-id': 'workflows-source',
        'source-kind': 'fixture',
        'as-of': '2026-08-29T12:00:00Z',
        'retrieved-at': '2026-08-29T12:05:00Z',
        availability: 'available',
        completeness: 'complete',
        freshness: 'fresh',
      },
      rows: [
        {
          organization: 'octo-org',
          repository: 'octo-org/platform',
          workflow: '.github/workflows/ci.yml',
          'workflow-active': 'true',
          'rollout-mode': 'review',
          'observed-at': '2026-08-29T11:00:00Z',
        },
      ],
    },
    runs: {
      source: 'runs',
      metadata: {
        'source-id': 'runs-source',
        'source-kind': 'fixture',
        'as-of': '2026-08-29T12:00:00Z',
        'retrieved-at': '2026-08-29T12:05:00Z',
        availability: 'available',
        completeness: 'partial',
        freshness: 'stale',
      },
      rows: [
        {
          organization: 'octo-org',
          repository: 'octo-org/platform',
          workflow: '.github/workflows/ci.yml',
          run: '1001',
          'run-status': 'completed',
          'run-conclusion': 'success',
          'rollout-mode': 'review',
          engine: 'github-models',
          'requested-model': 'gpt-4.1',
          'resolved-model': 'gpt-4.1-mini',
          'started-at': '2026-08-29T10:00:00Z',
        },
      ],
    },
    usage: {
      source: 'usage',
      metadata: {
        'source-id': 'usage-source',
        'source-kind': 'fixture',
        'as-of': '2026-08-29T12:00:00Z',
        'retrieved-at': '2026-08-29T12:05:00Z',
        availability: 'empty',
        completeness: 'unknown',
        freshness: 'fresh',
      },
      rows: [],
    },
    outcomes: {
      source: 'outcomes',
      metadata: {
        'source-id': 'outcomes-source',
        'source-kind': 'fixture',
        'as-of': '2026-08-29T12:00:00Z',
        'retrieved-at': '2026-08-29T12:05:00Z',
        availability: 'available',
        completeness: 'complete',
        freshness: 'fresh',
      },
      rows: [
        {
          run: '1001',
          'outcome-state': 'accepted',
        },
      ],
    },
    findings: {
      source: 'findings',
      metadata: {
        'source-id': 'findings-source',
        'source-kind': 'fixture',
        'as-of': '2026-08-29T12:00:00Z',
        'retrieved-at': '2026-08-29T12:05:00Z',
        availability: 'available',
        completeness: 'complete',
        freshness: 'fresh',
      },
      rows: [
        {
          organization: 'octo-org',
          repository: 'octo-org/platform',
          workflow: '.github/workflows/ci.yml',
          run: '1001',
          finding: 'finding-1',
          'finding-summary': 'Pull request needed manual review',
          'finding-severity': 'medium',
          'finding-status': 'open',
          'observed-at': '2026-08-29T11:30:00Z',
          'issue-link': {
            relation: 'issue',
            href: 'https://github.com/octo-org/platform/issues/7',
            label: 'Issue #7',
          },
          'pull-request-link': {
            relation: 'pull-request',
            href: 'https://github.com/octo-org/platform/pull/12',
            label: 'PR #12',
          },
          'run-link': {
            relation: 'run',
            href: 'https://github.com/octo-org/platform/actions/runs/1001',
            label: 'Run 1001',
          },
        },
      ],
    },
    'operational-values': {
      source: 'operational-values',
      metadata: {
        'source-id': 'value-source',
        'source-kind': 'fixture',
        'as-of': '2026-08-29T12:00:00Z',
        'retrieved-at': '2026-08-29T12:05:00Z',
        availability: 'unavailable',
        completeness: 'unknown',
        freshness: 'unknown',
      },
      rows: [],
    },
  }
}

/**
 * @returns {Record<string, import('./presenter.js').LogicalSourceInput>}
 */
function createSemanticFixtureSources() {
  return {
    workflows: {
      source: 'workflows',
      metadata: {
        'source-id': 'workflows-source',
        'source-kind': 'fixture',
        'as-of': '2026-08-29T12:00:00Z',
        'retrieved-at': '2026-08-29T12:05:00Z',
        availability: 'available',
        completeness: 'complete',
        freshness: 'fresh',
      },
      rows: [
        {
          organization: 'octo-org',
          repository: 'platform',
          package: 'daily-ops',
          workflow: '.github/workflows/daily-ops.yml',
          'workflow-role': 'orchestrator',
          'max-ai-credits': 100,
          'package-aic-allowance': 250,
        },
        {
          organization: 'octo-org',
          repository: 'platform',
          package: 'daily-ops',
          workflow: '.github/workflows/daily-ops-worker.yml',
          'workflow-role': 'worker',
          'max-ai-credits': 150,
          'package-aic-allowance': 250,
        },
        {
          organization: 'octo-org',
          repository: 'target-service',
          workflow: '.github/workflows/ci.yml',
          'workflow-role': 'standalone',
        },
      ],
    },
    experiments: {
      source: 'experiments',
      metadata: {
        'source-id': 'experiments-source',
        'source-kind': 'fixture',
        'as-of': '2026-08-29T12:00:00Z',
        'retrieved-at': '2026-08-29T12:05:00Z',
        availability: 'available',
        completeness: 'complete',
        freshness: 'fresh',
      },
      rows: [
        {
          experiment: 'exp-1',
          'experiment-name': 'Variant Selection',
          'observed-at': '2026-08-29T09:00:00Z',
        },
      ],
    },
    'experiment-assignments': {
      source: 'experiment-assignments',
      metadata: {
        'source-id': 'experiment-assignments-source',
        'source-kind': 'fixture',
        'as-of': '2026-08-29T12:00:00Z',
        'retrieved-at': '2026-08-29T12:05:00Z',
        availability: 'available',
        completeness: 'complete',
        freshness: 'fresh',
      },
      rows: [
        {
          organization: 'octo-org',
          repository: 'octo-org/platform',
          workflow: '.github/workflows/ci.yml',
          run: '2001',
          experiment: 'exp-1',
          variant: 'treatment-a',
          'observed-at': '2026-08-29T09:05:00Z',
        },
      ],
    },
    'grader-observations': {
      source: 'grader-observations',
      metadata: {
        'source-id': 'grader-observations-source',
        'source-kind': 'fixture',
        'as-of': '2026-08-29T12:00:00Z',
        'retrieved-at': '2026-08-29T12:05:00Z',
        availability: 'available',
        completeness: 'complete',
        freshness: 'fresh',
      },
      rows: [
        {
          organization: 'octo-org',
          repository: 'octo-org/platform',
          workflow: '.github/workflows/ci.yml',
          run: '2001',
          experiment: 'exp-1',
          grader: 'grader-1',
          value: 0.91,
          status: 'pass',
          'rollout-mode': 'review',
          'observed-at': '2026-08-29T09:10:00Z',
        },
        {
          organization: 'octo-org',
          repository: 'octo-org/platform',
          workflow: '.github/workflows/ci.yml',
          run: '2002',
          experiment: 'exp-1',
          grader: 'grader-1',
          value: null,
          status: 'unavailable',
          'rollout-mode': 'unknown',
          'observed-at': '2026-08-29T09:15:00Z',
        },
      ],
    },
    'eval-observations': {
      source: 'eval-observations',
      metadata: {
        'source-id': 'eval-observations-source',
        'source-kind': 'fixture',
        'as-of': '2026-08-29T12:00:00Z',
        'retrieved-at': '2026-08-29T12:05:00Z',
        availability: 'available',
        completeness: 'complete',
        freshness: 'fresh',
      },
      rows: [
        {
          organization: 'octo-org',
          repository: 'octo-org/platform',
          workflow: '.github/workflows/ci.yml',
          run: '2001',
          experiment: 'exp-1',
          eval: 'eval-1',
          'eval-result': 'YES',
          'requested-model': 'gpt-4.1',
          'resolved-model': 'gpt-4.1-mini',
          'rollout-mode': 'review',
          'observed-at': '2026-08-29T09:12:00Z',
        },
        {
          organization: 'octo-org',
          repository: 'octo-org/platform',
          workflow: '.github/workflows/ci.yml',
          run: '2002',
          experiment: 'exp-1',
          eval: 'eval-1',
          'eval-result': 'UNKNOWN',
          'requested-model': 'gpt-4.1',
          'resolved-model': 'unknown',
          'rollout-mode': 'unknown',
          'observed-at': '2026-08-29T09:18:00Z',
        },
      ],
    },
    outcomes: {
      source: 'outcomes',
      metadata: {
        'source-id': 'outcomes-source',
        'source-kind': 'fixture',
        'as-of': '2026-08-29T12:00:00Z',
        'retrieved-at': '2026-08-29T12:05:00Z',
        availability: 'available',
        completeness: 'complete',
        freshness: 'fresh',
      },
      rows: [
        {
          organization: 'octo-org',
          repository: 'octo-org/platform',
          workflow: '.github/workflows/ci.yml',
          run: '2001',
          'safe-output': 'pr-1',
          'outcome-state': 'lifecycle-close',
          'evidence-strength': 'high',
          'observed-at': '2026-08-29T09:20:00Z',
        },
      ],
    },
    usage: {
      source: 'usage',
      metadata: {
        'source-id': 'usage-source',
        'source-kind': 'fixture',
        'as-of': '2026-08-29T12:00:00Z',
        'retrieved-at': '2026-08-29T12:05:00Z',
        availability: 'available',
        completeness: 'complete',
        freshness: 'fresh',
      },
      rows: [
        {
          organization: 'octo-org',
          repository: 'octo-org/platform',
          workflow: '.github/workflows/ci.yml',
          run: '2001',
          invocation: 'invoke-1',
          engine: 'github-models',
          'requested-model': 'gpt-4.1',
          'resolved-model': 'gpt-4.1-mini',
          'rollout-mode': 'review',
          'input-tokens': 120,
          'output-tokens': 42,
          'cache-read-tokens': 10,
          'cache-write-tokens': 5,
          'reasoning-tokens': 3,
          aic: 1.75,
          'observed-at': '2026-08-29T09:08:00Z',
        },
      ],
    },
    'operational-values': {
      source: 'operational-values',
      metadata: {
        'source-id': 'operational-values-source',
        'source-kind': 'fixture',
        'as-of': '2026-08-29T12:00:00Z',
        'retrieved-at': '2026-08-29T12:05:00Z',
        availability: 'available',
        completeness: 'complete',
        freshness: 'fresh',
      },
      rows: [
        {
          organization: 'octo-org',
          repository: 'octo-org/platform',
          workflow: '.github/workflows/ci.yml',
          run: '2001',
          experiment: 'exp-1',
          'operational-case': 'merge-latency',
          'evaluator-digest': 'digest-1',
          'rollout-mode': 'review',
          'operational-value': 0.72,
          'operational-value-definition': 'merge-speed',
          'requested-evidence-at': '2026-08-28T12:00:00Z',
          'evidence-cutoff': '2026-08-29T08:00:00Z',
          'maturity-at': '2026-08-29T11:00:00Z',
          'maturity-status': 'complete',
          'delta-from-baseline': 0.11,
          'observed-at': '2026-08-29T09:25:00Z',
          'evidence-link': {
            relation: 'evidence',
            href: 'https://example.com/evidence/1',
            label: 'Evidence 1',
          },
        },
      ],
    },
  }
}
