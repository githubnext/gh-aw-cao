/**
 * Derived repository sources for generic JSON-selected dashboard rendering.
 */

import { formatPercent } from './view-formatters.js';
import { formatCount, titleCase } from './components/count-formatters.js';
import { summarizeWorkflowAic } from './workflow-data.js';

const FAILURE_CONCLUSIONS = new Set(['failure', 'startup-failure', 'timed-out']);

/**
 * @typedef {{
 *   repository: string,
 *   workflows: number,
 *   disabled: number,
 *   reports: number,
 *   evaluatedWorkflowKeys: Set<string>,
 *   runs: number,
 *   failed: number,
 *   actionRequired: number,
 *   aic: number,
 *   repositoryLink?: unknown
 * }} RepositorySummary
 */

/**
 * @param {Record<string, import('./presenter.js').LogicalSourceInput>} sources
 * @returns {Record<string, import('./presenter.js').LogicalSourceInput>}
 */
export function deriveRepositorySources(sources) {
  const runsAvailable = sources.runs?.metadata?.availability !== 'unavailable';
  const summaries = summarizeRepositories(sources);
  const repositoryWorkflows = buildRepositoryWorkflowRows(
    sources.workflows?.rows ?? [],
    sources.usage?.rows ?? []
  );
  const workflowMetadata = sources.workflows?.metadata ?? unavailableMetadata();

  return {
    ...sources,
    'repository-summary': {
      source: 'repository-summary',
      rows: buildRepositorySummaryRows(sources),
      metadata: combinedMetadata(sources, ['repositories', 'runs', 'usage'])
    },
    'repository-activity': {
      source: 'repository-activity',
      rows: summaries.map((summary) => ({
        repository: summary.repository,
        workflows: summary.workflows,
        reports: summary.reports,
        'evaluated-workflows': summary.evaluatedWorkflowKeys.size,
        runs: runsAvailable ? summary.runs : null,
        'failure-summary': runsAvailable
          ? summary.runs > 0
            ? `${formatPercent(summary.failed / summary.runs)} · ${formatCount(summary.failed)} failed`
            : '—'
          : 'Unavailable',
        aic: summary.aic,
        status: repositoryStatus(summary),
        ...(summary.repositoryLink ? { 'repository-link': summary.repositoryLink } : {})
      })),
      metadata: combinedMetadata(sources, ['repositories', 'workflows', 'runs', 'outcomes', 'usage', 'operational-values'])
    },
    'repository-detail-summary': {
      source: 'repository-detail-summary',
      rows: buildRepositoryDetailSummaryRows(repositoryWorkflows),
      metadata: workflowMetadata
    },
    'repository-workflow-status': {
      source: 'repository-workflow-status',
      rows: buildRepositoryWorkflowStatusRows(repositoryWorkflows),
      metadata: workflowMetadata
    },
    'repository-workflow-usage': {
      source: 'repository-workflow-usage',
      rows: buildRepositoryWorkflowUsageRows(sources.usage?.rows ?? []),
      metadata: sources.usage?.metadata ?? unavailableMetadata()
    },
    'repository-workflows': {
      source: 'repository-workflows',
      rows: repositoryWorkflows,
      metadata: workflowMetadata
    }
  };
}

/**
 * @param {Array<Record<string, unknown>>} workflows
 * @param {Array<Record<string, unknown>>} usage
 */
function buildRepositoryWorkflowRows(workflows, usage) {
  const workflowAic = summarizeWorkflowAic(workflows, usage);
  return workflows
    .map((workflow) => ({
      repository: qualifiedRepository(workflow),
      workflow: String(workflow.workflow ?? ''),
      'workflow-name': String(workflow['workflow-name'] ?? workflow.workflow ?? ''),
      'workflow-role': titleCase(String(workflow['workflow-role'] ?? 'unknown')),
      'package-name': String(workflow['package-name'] ?? ''),
      'rollout-mode': String(workflow['rollout-mode'] ?? 'unknown'),
      'workflow-active': String(workflow['workflow-active'] ?? 'unknown'),
      'observed-at': workflow['observed-at'],
      ...(workflowAic.has(workflow) ? { aic: workflowAic.get(workflow) } : {}),
      ...(workflow['workflow-link'] ? { 'workflow-link': workflow['workflow-link'] } : {})
    }))
    .filter((workflow) => workflow.repository && workflow.workflow)
    .sort((left, right) => left.repository.localeCompare(right.repository)
      || left['workflow-name'].localeCompare(right['workflow-name']));
}

/** @param {Array<Record<string, unknown>>} workflows */
function buildRepositoryDetailSummaryRows(workflows) {
  /** @type {Map<string, Array<Record<string, unknown>>>} */
  const grouped = new Map();
  for (const workflow of workflows) {
    const repository = String(workflow.repository);
    grouped.set(repository, [...(grouped.get(repository) ?? []), workflow]);
  }
  return [...grouped].map(([repository, rows]) => {
    const latestUpdate = rows
      .map((/** @type {Record<string, unknown>} */ row) => String(row['observed-at'] ?? ''))
      .filter((/** @type {string} */ value) => Number.isFinite(Date.parse(value)))
      .sort((/** @type {string} */ left, /** @type {string} */ right) => Date.parse(right) - Date.parse(left))[0];
    return {
      repository,
      workflows: rows.length,
      ...(latestUpdate ? { 'latest-update': latestUpdate } : {}),
      'external-link': {
        relation: 'external',
        href: `https://github.com/${repository}/actions`,
        label: `View ${repository} Actions`
      }
    };
  });
}

/** @param {Array<Record<string, unknown>>} workflows */
function buildRepositoryWorkflowStatusRows(workflows) {
  const counts = new Map();
  for (const workflow of workflows) {
    const repository = String(workflow.repository);
    const status = workflow['workflow-active'] === 'true'
      ? 'Active'
      : workflow['workflow-active'] === 'false'
        ? 'Disabled'
        : 'Unknown';
    const key = `${repository}\0${status}`;
    counts.set(key, { repository, status, workflows: Number(counts.get(key)?.workflows ?? 0) + 1 });
  }
  return [...counts.values()];
}

/** @param {Array<Record<string, unknown>>} usage */
function buildRepositoryWorkflowUsageRows(usage) {
  return usage
    .map((row) => ({
      repository: qualifiedRepository(row),
      workflow: String(row.workflow ?? ''),
      invocation: String(row.invocation ?? ''),
      aic: Number(row.aic),
      ...(row['workflow-link'] ? { 'workflow-link': row['workflow-link'] } : {})
    }))
    .filter((row) => row.repository && row.workflow && row.invocation && Number.isFinite(row.aic) && row.aic >= 0);
}

/**
 * @param {Record<string, import('./presenter.js').LogicalSourceInput>} sources
 * @returns {Array<Record<string, unknown>>}
 */
function buildRepositorySummaryRows(sources) {
  const repositories = [...new Set((sources.repositories?.rows ?? [])
    .map(qualifiedRepository)
    .filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));
  const runs = sources.runs;
  const usage = sources.usage;
  const windowHours = coverageHours(runs?.metadata);
  const runWindow = runs?.metadata?.availability === 'unavailable'
    ? 'Actions run data unavailable'
    : `${windowHours ? `${windowHours}-hour ` : ''}Actions run window`;
  const usageCoverage = usage?.metadata?.availability === 'unavailable'
    ? 'Usage data unavailable'
    : `${formatCount(usage?.rows.length ?? 0)} artifacts`;

  return [
    {
      label: `Repository scope · ${formatCount(repositories.length)} configured`,
      items: repositories.map((repository) => ({
        label: repository,
        'navigation-href': `#page-repository-detail?repository=${encodeURIComponent(repository)}`
      }))
    },
    { label: 'Run window', value: runWindow },
    { label: 'AIC coverage', value: usageCoverage }
  ];
}

/**
 * @param {Record<string, import('./presenter.js').LogicalSourceInput>} sources
 * @returns {RepositorySummary[]}
 */
export function summarizeRepositories(sources) {
  /** @type {Map<string, RepositorySummary>} */
  const summaries = new Map();
  /**
   * @param {Record<string, unknown>} row
   * @returns {RepositorySummary | null}
   */
  const ensure = (row) => {
    const repository = qualifiedRepository(row);
    if (!repository) return null;
    const existing = summaries.get(repository);
    if (existing) {
      if (!existing.repositoryLink && row['repository-link']) existing.repositoryLink = row['repository-link'];
      return existing;
    }
    const summary = {
      repository,
      workflows: 0,
      disabled: 0,
      reports: 0,
      evaluatedWorkflowKeys: new Set(),
      runs: 0,
      failed: 0,
      actionRequired: 0,
      aic: 0,
      ...(row['repository-link'] ? { repositoryLink: row['repository-link'] } : {})
    };
    summaries.set(repository, summary);
    return summary;
  };

  for (const row of sources.repositories?.rows ?? []) ensure(row);
  for (const row of sources.workflows?.rows ?? []) {
    const summary = ensure(row);
    if (!summary) continue;
    summary.workflows += 1;
    if (String(row['workflow-active']) === 'false') summary.disabled += 1;
  }
  for (const row of sources.outcomes?.rows ?? []) {
    const summary = ensure(row);
    if (summary) summary.reports += 1;
  }
  for (const row of sources['operational-values']?.rows ?? []) {
    const summary = ensure(row);
    if (!summary || !Number.isFinite(row['operational-value']) || !row.workflow || !row['evaluator-digest']) continue;
    summary.evaluatedWorkflowKeys.add(String(row.workflow));
  }

  const runs = new Map();
  for (const row of sources.runs?.rows ?? []) {
    const repository = qualifiedRepository(row);
    const run = String(row.run ?? '');
    if (!repository || !run) continue;
    runs.set(`${repository}:${run}`, row);
    ensure(row);
  }
  for (const row of runs.values()) {
    const summary = ensure(row);
    if (!summary) continue;
    summary.runs += 1;
    const conclusion = String(row['run-conclusion'] ?? 'unknown');
    if (FAILURE_CONCLUSIONS.has(conclusion)) summary.failed += 1;
    if (conclusion === 'action-required') summary.actionRequired += 1;
  }
  for (const row of sources.usage?.rows ?? []) {
    const repository = qualifiedRepository(row);
    if (!repository) continue;
    const summary = summaries.get(repository);
    if (summary && Number.isFinite(row.aic)) summary.aic += Number(row.aic);
  }

  return [...summaries.values()].sort((left, right) => (
    right.failed - left.failed
    || right.runs - left.runs
    || left.repository.localeCompare(right.repository)
  ));
}

/** @param {RepositorySummary} summary */
function repositoryStatus(summary) {
  if (summary.failed > 0) return 'Needs attention';
  if (summary.actionRequired > 0) return 'Approval required';
  if (summary.runs > 0) return 'No failures observed';
  if (summary.disabled > 0) return 'Disabled workflows';
  if (summary.reports > 0 || summary.evaluatedWorkflowKeys.size > 0) return 'Outcomes observed';
  return 'No recent activity';
}

/** @param {Record<string, unknown>} row */
function qualifiedRepository(row) {
  const repository = String(row.repository ?? '').trim();
  if (!repository) return '';
  if (repository.includes('/')) return repository;
  const organization = String(row.organization ?? '').trim();
  return organization ? `${organization}/${repository}` : repository;
}

/** @param {import('./presenter.js').SourceMetadata | undefined} metadata */
function coverageHours(metadata) {
  const start = Date.parse(metadata?.['coverage-start'] ?? '');
  const end = Date.parse(metadata?.['coverage-end'] ?? '');
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  const hours = (end - start) / 3_600_000;
  return Number.isInteger(hours) ? hours : null;
}

/** @returns {import('./presenter.js').SourceMetadata} */
function unavailableMetadata() {
  return {
    'source-id': 'repository-detail-derived',
    'source-kind': 'derived',
    'as-of': new Date(0).toISOString(),
    'retrieved-at': new Date(0).toISOString(),
    completeness: 'unknown',
    freshness: 'unknown',
    availability: 'unavailable'
  };
}

/**
 * @param {Record<string, import('./presenter.js').LogicalSourceInput>} sources
 * @param {string[]} sourceNames
 * @returns {import('./presenter.js').SourceMetadata}
 */
function combinedMetadata(sources, sourceNames) {
  const metadata = sourceNames
    .map((name) => sources[name]?.metadata)
    .filter((value) => value !== undefined);
  /** @param {'as-of'|'retrieved-at'} field */
  const latest = (field) => metadata
    .map((value) => value?.[field])
    .filter((value) => typeof value === 'string' && Number.isFinite(Date.parse(value)))
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0];
  return {
    'source-id': 'repository-activity-derived',
    'source-kind': 'derived',
    'as-of': latest('as-of') ?? new Date(0).toISOString(),
    'retrieved-at': latest('retrieved-at') ?? new Date(0).toISOString(),
    completeness: metadata.some((value) => value?.completeness === 'partial')
      ? 'partial'
      : metadata.length > 0 && metadata.every((value) => value?.completeness === 'complete')
        ? 'complete'
        : 'unknown',
    freshness: metadata.some((value) => value?.freshness === 'stale')
      ? 'stale'
      : metadata.length > 0 && metadata.every((value) => value?.freshness === 'fresh')
        ? 'fresh'
        : 'unknown',
    availability: sources.repositories?.metadata?.availability ?? 'unavailable'
  };
}
