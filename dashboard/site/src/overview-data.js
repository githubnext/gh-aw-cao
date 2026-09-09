/**
 * Derived overview sources for generic JSON-selected dashboard rendering.
 */

import { formatNumber, formatPercent } from './view-formatters.js';
import { formatAic, formatCount, pluralSuffix, titleCase } from './components/count-formatters.js';
import { classifyUtilizationRatio, isApprovalConclusion, isFailureConclusion } from './components/run-classification.js';
import { buildAttentionItems } from './components/attention-rules.js';

const GITHUB_RATE_LIMIT_DOCS = 'https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api';

/**
 * @param {Record<string, import('./presenter.js').LogicalSourceInput>} sources
 * @param {{ readinessWindow?: { start: string, end: string } }} [options]
 * @returns {Record<string, import('./presenter.js').LogicalSourceInput>}
 */
export function deriveOverviewSources(sources, options = {}) {
  const workflows = rowsFor(sources, 'workflows');
  const repositories = rowsFor(sources, 'repositories');
  const runs = rowsFor(sources, 'runs');
  const usage = rowsFor(sources, 'usage');
  const outcomes = rowsFor(sources, 'outcomes');
  const findings = rowsFor(sources, 'findings');
  const graderObservations = rowsFor(sources, 'grader-observations');
  const operationalValues = rowsFor(sources, 'operational-values');
  const packageActivity = summarizePackageActivity(workflows, runs, outcomes);
  const packages = summarizePackages(workflows).map((entry) => {
    const activity = packageActivity.get(entry.id);
    const runActivityAvailable = sourceIsAvailable(sources.runs);
    return {
      ...entry,
      dispatches: runActivityAvailable ? activity?.dispatches ?? 0 : null,
      successfulDispatches: runActivityAvailable ? activity?.successfulDispatches ?? 0 : null,
      failedDispatches: runActivityAvailable ? activity?.failedDispatches ?? 0 : null,
      approvalDispatches: runActivityAvailable ? activity?.approvalDispatches ?? 0 : null,
      pendingDispatches: runActivityAvailable ? activity?.pendingDispatches ?? 0 : null,
      dispatchesWithSafeOutputs: sourceIsAvailable(sources.outcomes) ? activity?.dispatchesWithSafeOutputs ?? 0 : null,
      activityWindow: sourceWindowLabel(sources.runs)
    };
  });
  const health = summarizeRunHealth(runs);
  const disabledWorkflows = workflows.filter((row) => String(row['workflow-active']) === 'false').length;
  const overviewMetadata = createOverviewMetadata(sources);
  const packageUsage = summarizePackageAicUsage(workflows, usage);
  const securitySignals = buildSecuritySignals({ workflows, runs, findings, outcomes });
  const valueSignals = buildValueSignals({ sources, graderObservations, operationalValues, outcomes });
  const costSignals = buildCostSignals(sources.usage);
  const roleFor = buildWorkflowRoleResolver(workflows);
  const readinessSources = readinessWindowSources(sources, options.readinessWindow);
  const readinessRuns = rowsFor(readinessSources, 'runs');
  const readinessFindings = rowsFor(readinessSources, 'findings');
  const readinessOutcomes = rowsFor(readinessSources, 'outcomes');
  const readiness = buildReadiness({
    sources: readinessSources,
    workflows,
    runs: readinessRuns,
    findings: readinessFindings,
    outcomes: readinessOutcomes,
    packages,
    health: summarizeRunHealth(readinessRuns),
    roleFor
  });
  const readinessActivity = buildReadinessActivity(runs.filter(isCompletedRun), roleFor, options.readinessWindow);
  const readinessMetadata = createOverviewMetadata({
    workflows: sources.workflows,
    runs: readinessSources.runs,
    findings: readinessSources.findings,
    outcomes: readinessSources.outcomes,
    'coverage-diagnostics': sources['coverage-diagnostics']
  });
  const overviewInbox = buildOverviewInboxRows(sources);
  const overviewInboxMetadata = createOverviewMetadata({
    'attention-signals': sources['attention-signals'],
    'agent-assignments': sources['agent-assignments'],
    'evidence-records': sources['evidence-records'],
    'github-api-rate-limits': sources['github-api-rate-limits'],
    usage: sources.usage,
    'operational-values': sources['operational-values']
  });

  return {
    ...sources,
    'attention-signals': {
      source: 'attention-signals',
      rows: overviewInbox,
      metadata: overviewInboxMetadata
    },
    'overview-status': {
      source: 'overview-status',
      rows: [buildOverviewStatusRow({ sources, workflows, repositories, runs, usage, packages, health, disabledWorkflows })],
      metadata: overviewMetadata
    },
    'overview-vitals': {
      source: 'overview-vitals',
      rows: buildOverviewVitals({ sources, packages, health, workflows, repositories, runs }),
      metadata: overviewMetadata
    },
    'overview-execution-health': {
      source: 'overview-execution-health',
      rows: buildExecutionHealthRows(health),
      metadata: overviewMetadata
    },
    'overview-attention': {
      source: 'overview-attention',
      rows: buildAttentionRows({ sources, workflows, runs, findings: rowsFor(sources, 'findings'), packages, disabledWorkflows, health }),
      metadata: overviewMetadata
    },
    'overview-attention-domains': {
      source: 'overview-attention-domains',
      rows: buildDomainAttentionRows({
        sources,
        workflows,
        runs,
        usage,
        outcomes,
        findings,
        operationalValues,
        health
      }),
      metadata: overviewMetadata
    },
    'overview-managed-packages': {
      source: 'overview-managed-packages',
      rows: packages.map((entry) => ({
        package: entry.id,
        title: entry.name,
        icon: entry.icon,
        mode: entry.mode,
        'rollout-percent': entry.rolloutPercent,
        'live-coverage-percent': entry.liveCoveragePercent,
        'repository-modes': entry.repositoryModes,
        'rollout-live-repositories': entry.rolloutLiveRepositories,
        'rollout-repositories': entry.rolloutRepositories,
        'dispatch-count': entry.dispatches,
        'dispatch-success-count': entry.successfulDispatches,
        'dispatch-failure-count': entry.failedDispatches,
        'dispatch-approval-count': entry.approvalDispatches,
        'dispatch-pending-count': entry.pendingDispatches,
        'dispatches-with-safe-output': entry.dispatchesWithSafeOutputs,
        'activity-window': entry.activityWindow,
        workers: entry.workers,
        'aic-allowance': entry.allowance,
        inventory: entry.ready ? 'Ready' : 'Needs attention',
        'inventory-state': entry.ready ? 'inventory-ready' : 'inventory-attention',
        href: `#page-package-insights?package=${encodeURIComponent(entry.id)}`
      })),
      metadata: overviewMetadata
    },
    'overview-package-utilization': {
      source: 'overview-package-utilization',
      rows: packages
        .filter((entry) => typeof entry.allowance === 'number' && entry.allowance > 0)
        .map((entry) => buildPackageUtilizationRow(entry, packageUsage, sources.usage)),
      metadata: overviewMetadata
    },
    'readiness-checks': {
      source: 'readiness-checks',
      rows: readiness.checks,
      metadata: readinessMetadata
    },
    'readiness-activity': {
      source: 'readiness-activity',
      rows: readinessActivity,
      metadata: sources.runs?.metadata ?? overviewMetadata
    },
    'readiness-observations': {
      source: 'readiness-observations',
      rows: readiness.observations,
      metadata: readinessMetadata
    },
    'readiness-summary': {
      source: 'readiness-summary',
      rows: readiness.summary,
      metadata: readinessMetadata
    },
    'readiness-signals': {
      source: 'readiness-signals',
      rows: readiness.signals,
      metadata: readinessMetadata
    },
    'security-summary': {
      source: 'security-summary',
      rows: buildSecuritySummary({ runs, workflows, findings }),
      metadata: overviewMetadata
    },
    'security-signals': {
      source: 'security-signals',
      rows: securitySignals,
      metadata: overviewMetadata
    },
    'value-summary': {
      source: 'value-summary',
      rows: buildValueSummary(graderObservations, operationalValues, outcomes),
      metadata: overviewMetadata
    },
    'value-signals': {
      source: 'value-signals',
      rows: valueSignals,
      metadata: overviewMetadata
    },
    'value-workflows': {
      source: 'value-workflows',
      rows: buildValueWorkflowRows(operationalValues),
      metadata: overviewMetadata
    },
    'cost-summary': {
      source: 'cost-summary',
      rows: buildCostSummary(sources.usage),
      metadata: overviewMetadata
    },
    'cost-signals': {
      source: 'cost-signals',
      rows: costSignals,
      metadata: overviewMetadata
    }
  };
}

/**
 * Builds the quiet Overview inbox from explicit actionable states owned by the
 * Work, Agents, Evidence, and Insights views.
 * @param {Record<string, import('./presenter.js').LogicalSourceInput>} sources
 */
function buildOverviewInboxRows(sources) {
  const workSignals = rowsFor(sources, 'attention-signals')
    .filter((row) => /blocked|failure|approval|review|authority|human/i.test([
      row['signal-type'], row.reason, row.action
    ].join(' ')))
    .map((row) => ({ ...row, 'navigation-page': 'work' }));

  const agentSignals = rowsFor(sources, 'agent-assignments')
    .filter((row) => Boolean(row.stale) || Boolean(row['long-running']))
    .map((row) => {
      const stale = Boolean(row.stale);
      const runtimeSeconds = Number(row['total-runtime-seconds']);
      const runtime = Number.isFinite(runtimeSeconds) ? `${formatNumber(Math.round(runtimeSeconds / 60))} min runtime` : '';
      return {
        'attention-signal-id': `agent:${row['assignment-id'] ?? row['agent-id']}`,
        'signal-type': stale ? 'stale-agent' : 'expensive-agent',
        objective: row['agent-name'] ?? row.objective ?? 'Agent needs attention',
        scope: row.objective ?? '',
        reason: stale ? 'Agent telemetry is stale.' : 'Agent runtime exceeded the long-running threshold.',
        action: 'Review agent',
        'expected-actor': 'agent owner',
        'consequence-tier': stale ? 'medium' : 'low',
        priority: stale ? 2 : 3,
        'observed-at': row['last-observed-at'] ?? row['observed-at'],
        evidence: runtime,
        'navigation-page': 'agents',
        'evidence-link': row['evidence-link'],
        'run-link': row['run-link']
      };
    });

  const uncertainEvidenceStates = new Set(['pending', 'unknown', 'unavailable', 'incomplete', 'unsupported']);
  const evidenceSignals = rowsFor(sources, 'evidence-records')
    .filter((row) => uncertainEvidenceStates.has(String(row['verification-state']).toLowerCase())
      || uncertainEvidenceStates.has(String(row['provenance-state']).toLowerCase())
      || ['inferred', 'unsupported'].includes(String(row['evidence-class']).toLowerCase()))
    .map((row) => ({
      'attention-signal-id': `evidence:${row['evidence-id']}`,
      'signal-type': 'evidence-uncertainty',
      objective: row.objective ?? 'Evidence needs review',
      scope: row['evidence-kind'] ?? '',
      reason: row.claim ?? 'Evidence is incomplete or uncertain.',
      action: 'Review evidence',
      'expected-actor': 'evidence owner',
      'consequence-tier': 'medium',
      priority: 2,
      'observed-at': row['observed-at'],
      'navigation-page': 'insights',
      'evidence-link': row['evidence-link'],
      'run-link': row['run-link']
    }));

  const insightSources = ['github-api-rate-limits', 'usage', 'operational-values'];
  const insightSignals = insightSources.flatMap((sourceName) => rowsFor(sources, sourceName)
    .filter((row) => ['critical', 'warning', 'exceeded'].includes(String(row['risk-status'] ?? row.status).toLowerCase())
      || row['threshold-exceeded'] === true
      || (Number.isFinite(Number(row.threshold)) && Number.isFinite(Number(row.value)) && Number(row.value) > Number(row.threshold)))
    .map((row, index) => ({
      'attention-signal-id': `insight:${sourceName}:${row.run ?? row.invocation ?? index}`,
      'signal-type': 'threshold-exceeded',
      objective: row.title ?? row.metric ?? row.resource ?? 'Operational threshold exceeded',
      scope: [row.organization, row.repository].filter(Boolean).join('/'),
      reason: row.detail ?? row.reason ?? 'An observed operational threshold was exceeded.',
      action: 'Review insight',
      'expected-actor': row.owner ?? 'operations owner',
      'consequence-tier': String(row['risk-status']).toLowerCase() === 'critical' ? 'high' : 'medium',
      priority: String(row['risk-status']).toLowerCase() === 'critical' ? 0 : 2,
      'observed-at': row['observed-at'],
      evidence: Number.isFinite(Number(row['remaining-percent'])) ? `${row['remaining-percent']}% remaining` : '',
      'navigation-page': 'insights',
      'run-link': row['run-link']
    })));

  const rows = /** @type {Array<Record<string, unknown>>} */ ([
    ...workSignals,
    ...agentSignals,
    ...evidenceSignals,
    ...insightSignals
  ]);
  const seenIds = new Set();
  return rows.filter((row) => {
    const id = row['attention-signal-id'];
    if (seenIds.has(id)) return false;
    seenIds.add(id);
    return true;
  });
}

/**
 * @param {Record<string, import('./presenter.js').LogicalSourceInput>} sources
 * @param {{ start: string, end: string } | undefined} window
 * @returns {Record<string, import('./presenter.js').LogicalSourceInput>}
 */
function readinessWindowSources(sources, window) {
  const windowStart = window?.start ?? '';
  const windowEnd = window?.end ?? '';
  const start = Date.parse(windowStart);
  const end = Date.parse(windowEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) return sources;

  const scoped = { ...sources };
  for (const name of ['runs', 'findings', 'outcomes']) {
    const source = sources[name];
    if (!Array.isArray(source?.rows)) continue;
    scoped[name] = {
      ...source,
      rows: source.rows.filter((row) => {
        const timestamp = Date.parse(String(row['observed-at'] || row['started-at'] || row['published-at'] || ''));
        return Number.isFinite(timestamp) && timestamp >= start && timestamp < end;
      }),
      metadata: {
        ...source.metadata,
        'coverage-start': windowStart,
        'coverage-end': windowEnd
      }
    };
  }
  return scoped;
}

/**
 * @param {Array<Record<string, unknown>>} runs
 * @param {(row: Record<string, unknown>) => string} roleFor
 * @param {{ start: string, end: string } | undefined} [window]
 */
function buildReadinessActivity(runs, roleFor, window) {
  const windowStart = Date.parse(window?.start ?? '');
  const windowEnd = Date.parse(window?.end ?? '');
  const hasWindow = Number.isFinite(windowStart) && Number.isFinite(windowEnd) && windowStart < windowEnd;
  const windowDuration = hasWindow ? windowEnd - windowStart : 0;
  const contextDuration = Math.min(Math.max(windowDuration, 24 * 3_600_000), 7 * 24 * 3_600_000);
  const contextStart = hasWindow ? windowStart - contextDuration : Number.NEGATIVE_INFINITY;
  /** @type {Map<string, Record<string, unknown>>} */
  const hourlyActivity = new Map();
  for (const row of runs) {
    const role = roleFor(row);
    const startedAt = Date.parse(String(row['started-at'] || ''));
    if (!['orchestrator', 'worker'].includes(role)
        || !Number.isFinite(startedAt)
        || startedAt < contextStart
        || (hasWindow && startedAt >= windowEnd)) continue;
    const hour = new Date(startedAt);
    hour.setUTCMinutes(0, 0, 0);
    const activityHour = hour.toISOString();
    const key = `${activityHour}:${role}`;
    const existing = hourlyActivity.get(key);
    hourlyActivity.set(key, {
      'activity-hour': activityHour,
      'workflow-role': role,
      'run-count': Number(existing?.['run-count'] || 0) + 1,
      'in-window': !hasWindow || (startedAt >= windowStart && startedAt < windowEnd)
    });
  }
  return [...hourlyActivity.values()].toSorted((left, right) =>
    Date.parse(String(left['activity-hour'])) - Date.parse(String(right['activity-hour']))
      || String(left['workflow-role']).localeCompare(String(right['workflow-role'])));
}

/**
 * @param {{ sources: Record<string, import('./presenter.js').LogicalSourceInput>, workflows: Array<Record<string, unknown>>, runs: Array<Record<string, unknown>>, findings: Array<Record<string, unknown>>, outcomes: Array<Record<string, unknown>>, packages: ReturnType<typeof summarizePackages>, health: ReturnType<typeof summarizeRunHealth>, roleFor: (row: Record<string, unknown>) => string }} input
 */
function buildReadiness(input) {
  const requiredSources = ['workflows', 'runs', 'findings', 'outcomes', 'coverage-diagnostics'];
  const sourceGaps = requiredSources.filter((name) => {
    const metadata = input.sources[name]?.metadata;
    return metadata?.availability !== 'available'
      || metadata.completeness !== 'complete'
      || metadata.freshness !== 'fresh';
  });
  const policyBlocks = rowsFor(input.sources, 'coverage-diagnostics')
    .filter((row) => String(row.title) === 'Control policy resolution unavailable');
  const admissionBlocks = input.workflows.filter((row) => String(row['admission-status']) === 'blocked');
  const inventoryGaps = input.packages.filter((entry) => !entry.ready);
  const completedRuns = input.runs.filter(isCompletedRun);
  const controlPlaneRuns = completedRuns.filter((row) => ['orchestrator', 'worker'].includes(input.roleFor(row)));
  const engineHealth = summarizeRunHealth(controlPlaneRuns);
  const runSourceAvailable = sourceIsAvailable(input.sources.runs);
  const unresolvedRuns = completedRuns.filter((row) => input.roleFor(row) === 'unknown');
  const unresolvedWarnings = input.findings.filter((row) => isAuthoredWarning(row) && input.roleFor(row) === 'unknown');
  const unresolvedNoops = input.outcomes.filter((row) => String(row['outcome-category']) === 'noop' && input.roleFor(row) === 'unknown');
  const attributionGapCount = unresolvedRuns.length + unresolvedWarnings.length + unresolvedNoops.length;
  const warnings = input.findings.filter((row) => isAuthoredWarning(row)
    && ['orchestrator', 'worker'].includes(input.roleFor(row)));
  const noops = input.outcomes.filter((row) => String(row['outcome-category']) === 'noop'
    && ['orchestrator', 'worker'].includes(input.roleFor(row)));
  const failuresByRole = groupRows(engineHealth.failedRows, input.roleFor);
  const warningsByRole = groupRows(warnings, input.roleFor);
  /** @type {(groups: Array<[string, Array<Record<string, unknown>>]>, role: string) => Array<Record<string, unknown>>} */
  const rowsForRole = (groups, role) => groups.find(([candidate]) => candidate === role)?.[1] ?? [];
  const orchestratorFailures = rowsForRole(failuresByRole, 'orchestrator');
  const workerFailures = rowsForRole(failuresByRole, 'worker');
  const orchestratorWarnings = rowsForRole(warningsByRole, 'orchestrator');
  const workerWarnings = rowsForRole(warningsByRole, 'worker');
  /** @type {Array<[string, Array<Record<string, unknown>>]>} */
  const runtimeFailureGroups = [
    ['orchestrator', orchestratorFailures],
    ['worker', workerFailures]
  ];
  const runtimeFailureSignals = runtimeFailureGroups.filter(([, rows]) => rows.length > 0).map(([role, rows]) => {
    const latest = latestRow(rows);
    const latestDetail = String(latest?.['failure-message'] || latest?.['failure-step'] || 'Open the latest failed run for details.');
    return {
      priority: 0,
      urgency: 'P0',
      count: rows.length,
      tone: 'danger',
      icon: 'issue',
      kind: 'Runtime regression',
      title: `${formatNumber(rows.length)} ${role} run${pluralSuffix(rows.length)} failed`,
      detail: `Latest: ${latestDetail}`,
      evidence: `${formatNumber(rows.length)} failed run${pluralSuffix(rows.length)}`,
      action: 'Open latest run',
      'run-link': latest?.['run-link']
    };
  });

  const checks = [
    readinessCheck('Engine activity', !runSourceAvailable ? 'Unknown' : engineHealth.total === 0 || engineHealth.failed > 0 || engineHealth.approval > 0 ? 'Blocked' : 'Ready', !runSourceAvailable
      ? 'Run telemetry is unavailable, so engine activity cannot be established.'
      : engineHealth.total === 0
        ? 'No completed control-plane runs were observed in the current window.'
        : engineHealth.failed > 0 || engineHealth.approval > 0
          ? `${formatNumber(engineHealth.total)} completed run${pluralSuffix(engineHealth.total)} observed: ${formatNumber(engineHealth.failed)} failed and ${formatNumber(engineHealth.approval)} approval-gated.`
          : `${formatNumber(engineHealth.successful)} runs completed successfully.`),
    readinessCheck('Evidence', sourceGaps.length > 0 ? 'Unknown' : attributionGapCount > 0 ? 'Blocked' : 'Ready', sourceGaps.length > 0
      ? `${formatNumber(sourceGaps.length)} required source${pluralSuffix(sourceGaps.length)} incomplete, stale, or unavailable`
      : attributionGapCount > 0
        ? `${formatNumber(attributionGapCount)} relevant record${pluralSuffix(attributionGapCount)} could not be joined to workflow inventory.`
        : 'Required control-plane sources are complete, fresh, and attributed.'),
    readinessCheck('Inventory', inventoryGaps.length > 0 || input.packages.length === 0 ? 'Blocked' : 'Ready', input.packages.length === 0
      ? 'No managed package inventory was discovered.'
      : inventoryGaps.length > 0
        ? `${formatNumber(inventoryGaps.length)} package${pluralSuffix(inventoryGaps.length)} failed inventory checks.`
        : `${formatNumber(input.packages.length)} managed package${pluralSuffix(input.packages.length)} passed inventory checks.`),
    readinessCheck('Controls', policyBlocks.length > 0 || admissionBlocks.length > 0 ? 'Blocked' : 'Ready', policyBlocks.length > 0 || admissionBlocks.length > 0
      ? `${formatNumber(policyBlocks.length)} policy and ${formatNumber(admissionBlocks.length)} admission block${pluralSuffix(admissionBlocks.length)} detected.`
      : 'Policy resolution and workflow admission are clear.'),
    readinessCheck('Outputs', !sourceIsAvailable(input.sources.findings) ? 'Unknown' : warnings.length > 0 ? 'Blocked' : 'Ready', !sourceIsAvailable(input.sources.findings)
      ? 'Warning output evidence is unavailable.'
      : warnings.length > 0
        ? `${formatNumber(warnings.length)} retained output${warnings.length === 1 ? ' contains' : 's contain'} an explicit warning.`
        : 'No explicit output warnings were observed.')
  ];

  const signals = [
    ...(runSourceAvailable && engineHealth.total === 0 ? [{
      priority: 0,
      urgency: 'P0',
      count: 1,
      tone: 'critical',
      icon: 'stop',
      kind: 'Engine stalled',
      title: 'No control-plane runs observed',
      detail: 'Confirm schedules, workflow registration, and dispatch credentials before investigating downstream output.',
      evidence: 'Actions run history',
      action: 'Review runtime',
      'navigation-page': 'runtime'
    }] : []),
    ...runtimeFailureSignals,
    ...sourceGaps.map((name) => ({
      priority: 1,
      urgency: 'P0',
      count: 1,
      tone: 'critical',
      icon: 'database',
      kind: 'Evidence regression',
      title: `${titleCase(name)} evidence is not release-ready`,
      detail: sourceHealthDetail(input.sources[name]),
      evidence: 'Required source',
      action: 'Review coverage',
      'navigation-page': 'data-health'
    })),
    ...(attributionGapCount > 0 ? [{
      priority: 1,
      urgency: 'P0',
      count: attributionGapCount,
      tone: 'critical',
      icon: 'workflow',
      kind: 'Attribution regression',
      title: `${formatNumber(attributionGapCount)} record${pluralSuffix(attributionGapCount)} could not be attributed`,
      detail: 'The runtime repository and Actions workflow path did not match authoritative workflow inventory.',
      evidence: 'Workflow inventory join',
      action: 'Review coverage',
      'navigation-page': 'data-health'
    }] : []),
    ...policyBlocks.map((row) => ({
      priority: 1,
      urgency: 'P0',
      count: 1,
      tone: 'critical',
      icon: 'shield',
      kind: 'Control regression',
      title: 'Control policy resolution unavailable',
      detail: String(row.effect || 'The authoritative control policy could not be resolved.'),
      evidence: 'Control policy',
      action: 'Review coverage',
      'navigation-page': 'data-health'
    })),
    ...admissionBlocks.map((row) => ({
      priority: 1,
      urgency: 'P0',
      count: 1,
      tone: 'critical',
      icon: 'stop',
      kind: 'Admission regression',
      title: String(row['workflow-name'] || row.workflow || 'Workflow blocked'),
      detail: String(row['admission-reason'] || 'Workflow admission is blocked.'),
      evidence: 'Checked-in control policy',
      action: 'Review workflow',
      'navigation-page': 'workflows'
    })),
    ...inventoryGaps.map((entry) => ({
      priority: 2,
      urgency: 'P1',
      count: 1,
      tone: 'warning',
      icon: 'package',
      kind: 'Inventory regression',
      title: entry.name,
      detail: 'The package inventory is incomplete or does not contain an active orchestrator and worker.',
      evidence: 'Package inventory',
      action: 'Review package',
      'navigation-page': 'packages'
    })),
    ...warningsByRole.map(([role, rows]) => {
      const latest = latestRow(rows);
      return {
        priority: 2,
        urgency: 'P1',
        count: rows.length,
        tone: 'warning',
        icon: 'report',
        kind: 'Output warning',
        title: `${titleCase(role)} warnings`,
        detail: `${formatNumber(rows.length)} retained output${rows.length === 1 ? ' contains' : 's contain'} an explicit warning block.`,
        evidence: 'Output content',
        action: 'View output',
        'run-link': latest?.['run-link'],
        'external-link': latest?.['external-link']
      };
    }),
    ...(engineHealth.approval > 0 ? [{
      priority: 2,
      urgency: 'P1',
      count: engineHealth.approval,
      tone: 'warning',
      icon: 'issue',
      kind: 'Approval gate',
      title: `${formatNumber(engineHealth.approval)} run${pluralSuffix(engineHealth.approval)} require approval`,
      detail: 'Required maintainer approval prevents a release-ready verdict.',
      evidence: 'Run conclusion',
      action: 'Review runs',
      'navigation-page': 'runtime'
    }] : []),
  ].sort((left, right) => left.priority - right.priority);

  const readyChecks = checks.filter((row) => row['readiness-state'] === 'Ready').length;
  const blockedChecks = checks.filter((row) => row['readiness-state'] === 'Blocked').length;
  const verdict = blockedChecks > 0 ? 'Not ready' : readyChecks === checks.length ? 'Ready to ship' : 'Evidence incomplete';
  return {
    checks,
    signals,
    observations: [
      ...(orchestratorFailures.length > 0
        ? [readinessObservation('Orchestrator failures', orchestratorFailures, input.sources.runs, 'failure')]
        : []),
      ...(orchestratorWarnings.length > 0
        ? [readinessObservation('Orchestrator warnings', orchestratorWarnings, input.sources.findings, 'warning')]
        : []),
      ...(workerFailures.length > 0
        ? [readinessObservation('Worker failures', workerFailures, input.sources.runs, 'failure')]
        : []),
      ...(workerWarnings.length > 0
        ? [readinessObservation('Worker warnings', workerWarnings, input.sources.findings, 'warning')]
        : []),
      ...(noops.length > 0
        ? [readinessObservation('No-op reports', noops, input.sources.outcomes, 'noop')]
        : [])
    ],
    summary: [
      { label: 'Control plane', value: verdict },
      { label: 'Unblock first', value: signals[0]?.title || 'No blockers' },
      { label: 'Engine activity', value: engineHealth.total === 0
        ? '0 completed runs observed'
        : `${formatNumber(engineHealth.total)} completed runs observed · ${formatNumber(engineHealth.failed)} failed` },
      { label: 'Readiness checks', value: `${readyChecks} / ${checks.length} passing` },
    ]
  };
}

/**
 * @param {string} signal
 * @param {Array<Record<string, unknown>>} rows
 * @param {import('./presenter.js').LogicalSourceInput | undefined} source
 * @param {'failure'|'warning'|'noop'} kind
 */
function readinessObservation(signal, rows, source, kind) {
  const available = sourceIsAvailable(source);
  const complete = available && source?.metadata?.completeness === 'complete' && source.metadata.freshness === 'fresh';
  const latest = latestRow(rows);
  const noun = kind === 'noop' ? 'no-op report' : kind;
  return {
    signal,
    count: available ? rows.length : null,
    status: !available ? 'Unavailable' : rows.length > 0 ? kind === 'noop' ? 'Observed' : 'Attention' : complete ? 'Clear' : 'Partial',
    detail: !available
      ? sourceHealthDetail(source)
      : rows.length > 0
        ? `${formatNumber(rows.length)} ${noun}${pluralSuffix(rows.length)} observed${complete ? '.' : '; source coverage is partial or stale.'}`
        : complete ? `No ${noun}s observed.` : `No ${noun}s observed, but source coverage is partial or stale.`,
    'latest-at': latest?.['observed-at'] || latest?.['started-at'] || null,
    'evidence-link': latest?.['external-link'] || latest?.['run-link'] || null
  };
}

/**
 * @param {string} check
 * @param {'Ready'|'Blocked'|'Unknown'} state
 * @param {string} detail
 */
function readinessCheck(check, state, detail) {
  return { check, 'readiness-state': state, detail };
}

/**
 * @param {import('./presenter.js').LogicalSourceInput | undefined} source
 */
function sourceHealthDetail(source) {
  if (!source || source.metadata?.availability !== 'available') return 'The source is unavailable.';
  if (source.metadata?.completeness !== 'complete') return 'The source is incomplete.';
  if (source.metadata?.freshness !== 'fresh') return 'The source is stale.';
  return 'The source does not satisfy the readiness contract.';
}

/**
 * @param {import('./presenter.js').LogicalSourceInput | undefined} usageSource
 */
function buildCostSummary(usageSource) {
  const available = sourceIsAvailable(usageSource);
  const measuredRows = (usageSource?.rows ?? []).filter((row) => Number.isFinite(Number(row.aic)) && Number(row.aic) >= 0);
  const measuredAic = measuredRows.reduce((total, row) => total + Number(row.aic), 0);
  const measuredRuns = new Set(measuredRows.map((row) => usageRunKey(row)).filter(Boolean)).size;
  return [
    {
      label: 'Measured AIC',
      value: available ? formatAic(measuredAic) : '—'
    },
    { label: 'Measured runs', value: available ? formatNumber(measuredRuns) : '—' },
    { label: 'Measured episode AIC', value: '—' },
    { label: 'Episode output yield', value: '—' }
  ];
}

/**
 * @param {import('./presenter.js').LogicalSourceInput | undefined} usageSource
 */
function buildCostSignals(usageSource) {
  const available = sourceIsAvailable(usageSource);
  const complete = available && usageSource?.metadata?.completeness === 'complete';
  const signals = [];
  if (!available || !complete) {
    signals.push({
      priority: 1,
      count: 1,
      tone: 'informational',
      icon: 'codescan',
      kind: 'Usage coverage',
      title: available ? 'AI Credit telemetry is partial' : 'AI Credit telemetry is unavailable',
      detail: available
        ? 'Measured totals exclude runs whose usage artifacts were not collected.'
        : 'No complete usage feed is available for the configured scope.',
      evidence: available ? 'Partial evidence' : 'Evidence unavailable',
      action: 'View evidence',
      'navigation-page': 'coverage'
    });
  }
  return [
    ...signals,
    {
      priority: 2,
      count: 1,
      tone: 'informational',
      icon: 'meter',
      kind: 'Budget boundary',
      title: 'Budget status is unavailable',
      detail: 'Retained usage is not aligned to a complete monthly budget measurement window.',
      evidence: 'Threshold unavailable',
      action: 'View evidence',
      'navigation-page': 'cost'
    },
    {
      priority: 3,
      count: 1,
      tone: 'informational',
      icon: 'graph',
      kind: 'Anomaly boundary',
      title: 'Cost anomalies are not evaluated',
      detail: 'The retained window does not establish a representative historical usage baseline.',
      evidence: 'Baseline unavailable',
      action: 'View evidence',
      'navigation-page': 'cost'
    }
  ];
}

/**
 * @param {Array<Record<string, unknown>>} graderObservations
 * @param {Array<Record<string, unknown>>} operationalValues
 * @param {Array<Record<string, unknown>>} outcomes
 */
function buildValueSummary(graderObservations, operationalValues, outcomes) {
  const selected = Math.max(graderObservations.length, operationalValues.length);
  const values = operationalValues
    .map((row) => row['operational-value'])
    .filter(isFiniteNumber);
  const mean = values.length > 0
    ? values.reduce((total, value) => total + value, 0) / values.length
    : null;
  return [
    { label: 'Grader coverage', value: `${operationalValues.length} / ${selected}` },
    { label: 'Mature evidence', value: operationalValues.filter((row) => String(row['maturity-status']) === 'matured').length },
    { label: 'Mean operational value', value: mean === null ? '—' : formatPercent(mean) },
    { label: 'Open outputs', value: outcomes.filter((row) => String(row['outcome-state']) === 'pending').length }
  ];
}

/**
 * @param {{
 *   sources: Record<string, import('./presenter.js').LogicalSourceInput>,
 *   graderObservations: Array<Record<string, unknown>>,
 *   operationalValues: Array<Record<string, unknown>>,
 *   outcomes: Array<Record<string, unknown>>
 * }} input
 */
function buildValueSignals(input) {
  const signals = [];
  const valueMetadata = input.sources['operational-values']?.metadata;
  if (valueMetadata?.availability !== 'available') {
    signals.push({
      priority: 0,
      count: 1,
      tone: 'critical',
      icon: 'graph',
      kind: 'Missing grader data',
      title: 'Operational-value telemetry is unavailable',
      detail: 'No available operational-value source was retained.',
      evidence: 'Value unavailable',
      action: 'Review workflows',
      'navigation-page': 'workflows'
    });
  } else if (input.operationalValues.length === 0 && input.graderObservations.length === 0) {
    signals.push({
      priority: 1,
      count: 1,
      tone: 'informational',
      icon: 'graph',
      kind: 'Missing grader data',
      title: 'No operational-value observations retained',
      detail: 'The available source contains no operational-value observations.',
      evidence: 'Value unavailable',
      action: 'Review workflows',
      'navigation-page': 'workflows'
    });
  } else if (valueMetadata.completeness !== 'complete') {
    signals.push({
      priority: 0,
      count: 1,
      tone: 'critical',
      icon: 'issue',
      kind: 'Grader collection gap',
      title: 'Operational-value coverage is incomplete',
      detail: 'The retained operational-value source reports partial or unknown completeness.',
      evidence: 'Artifact gap',
      action: 'Review observations'
    });
  }

  const unavailable = input.graderObservations.filter((row) => (
    String(row.status) !== 'pass'
    || String(row['maturity-status']) === 'unavailable'
    || !isFiniteNumber(row.value)
  ));
  if (unavailable.length > 0) {
    signals.push({
      priority: 0,
      count: unavailable.length,
      tone: 'critical',
      icon: 'issue',
      kind: 'Grader unavailable',
      title: 'Operational-value results could not be used',
      detail: `${formatNumber(unavailable.length)} grader record${unavailable.length === 1 ? ' is' : 's are'} unavailable, invalid, or missing an observation`,
      evidence: 'Grader status',
      action: 'Review observations'
    });
  }

  const interim = input.operationalValues.filter((row) => String(row['maturity-status']) !== 'matured');
  if (interim.length > 0) {
    signals.push({
      priority: 1,
      count: interim.length,
      tone: 'action',
      icon: 'play',
      kind: 'Maturity pending',
      title: 'Outcome evidence is not mature',
      detail: `${formatNumber(interim.length)} observation${interim.length === 1 ? ' has not reached its' : 's have not reached their'} maturity time`,
      evidence: 'Re-evaluation due',
      action: 'Review observations'
    });
  }

  const usageMetadata = input.sources.usage?.metadata;
  if (usageMetadata?.availability !== 'available' || usageMetadata.completeness !== 'complete') {
    const unavailable = usageMetadata?.availability !== 'available';
    signals.push({
      priority: 2,
      count: 1,
      tone: 'informational',
      icon: 'meter',
      kind: 'AIC coverage',
      title: unavailable ? 'AI Credit telemetry is unavailable' : 'AI Credit telemetry is partial',
      detail: unavailable
        ? 'No available usage source was retained.'
        : 'The retained usage source reports partial or unknown completeness.',
      evidence: 'Usage gap',
      action: 'Review usage',
      'navigation-page': 'usage'
    });
  }

  const pendingOutcomes = input.outcomes.filter((row) => String(row['outcome-state']) === 'pending');
  if (pendingOutcomes.length > 0) {
    const latest = latestRow(pendingOutcomes);
    signals.push({
      priority: 3,
      count: pendingOutcomes.length,
      tone: 'warning',
      icon: 'issue',
      kind: 'Open output',
      title: 'Durable outputs still need disposition',
      detail: `${formatNumber(pendingOutcomes.length)} retained output${pendingOutcomes.length === 1 ? ' remains' : 's remain'} pending`,
      evidence: 'Outcome pending',
      action: 'View evidence',
      'run-link': latest?.['run-link'],
      'external-link': latest?.['external-link']
    });
  }

  const experimentsAvailable = input.sources.experiments?.metadata?.availability === 'available'
    && rowsFor(input.sources, 'experiments').length > 0
    && input.sources['experiment-assignments']?.metadata?.availability === 'available'
    && rowsFor(input.sources, 'experiment-assignments').length > 0;
  if (!experimentsAvailable) {
    signals.push({
      priority: 4,
      count: 1,
      tone: 'informational',
      icon: 'graph',
      kind: 'Experiment readiness',
      title: 'Experiment comparisons are unavailable',
      detail: 'No authoritative experiment definitions and assignment-to-run links are available for comparison.',
      evidence: 'Comparison unavailable',
      action: 'Review experiments',
      'navigation-page': 'experiments'
    });
  }

  return signals.sort((left, right) => left.priority - right.priority || right.count - left.count || left.title.localeCompare(right.title));
}

/**
 * @param {Array<Record<string, unknown>>} operationalValues
 */
function buildValueWorkflowRows(operationalValues) {
  return groupRows(operationalValues, (row) => [
    row.organization,
    row.repository,
    row.workflow || row['operational-value-definition']
  ].map(String).join(':')).flatMap(([, rows]) => {
    const valid = rows.filter((row) => (
      typeof row['operational-value'] === 'number'
      && Number.isFinite(row['operational-value'])
      && typeof row['evaluator-digest'] === 'string'
      && row['evaluator-digest'].length > 0
      && typeof row['operational-case'] === 'string'
      && row['operational-case'].length > 0
    ));
    const latestEvaluator = valid
      .toSorted((left, right) => evidenceAssignmentTime(right) - evidenceAssignmentTime(left))[0]?.['evaluator-digest'];
    if (!latestEvaluator) return [];

    const opportunities = new Map();
    for (const row of valid.filter((candidate) => candidate['evaluator-digest'] === latestEvaluator)) {
      const key = `${String(row.organization)}/${String(row.repository)}:${String(row['operational-case'])}`;
      const existing = opportunities.get(key);
      if (!existing || rowTimestamp(row) >= rowTimestamp(existing)) opportunities.set(key, row);
    }
    const comparable = [...opportunities.values()];
    if (comparable.length === 0) return [];

    const latest = /** @type {Record<string, unknown>} */ (latestRow(comparable));
    const values = comparable.map((row) => /** @type {number} */ (row['operational-value']));
    const baselines = comparable.flatMap((row) => (
      typeof row['delta-from-baseline'] === 'number' && Number.isFinite(row['delta-from-baseline'])
        ? [/** @type {number} */ (row['operational-value']) - row['delta-from-baseline']]
        : []
    ));
    return [{
      organization: latest.organization,
      repository: latest.repository,
      workflow: latest.workflow || latest['operational-value-definition'],
      'operational-value-definition': latest['operational-value-definition'],
      opportunities: comparable.length,
      'mature-observations': comparable.filter((row) => String(row['maturity-status']) === 'matured').length,
      'mean-operational-value': roundMetric(values.reduce((total, value) => total + value, 0) / values.length),
      'mean-baseline': baselines.length > 0
        ? roundMetric(baselines.reduce((total, value) => total + value, 0) / baselines.length)
        : null,
      run: latest.run,
      'observed-at': latest['observed-at'],
      'run-link': latest['run-link'] || latest['evidence-link']
    }];
  }).sort((left, right) => Number(right['mean-operational-value']) - Number(left['mean-operational-value']));
}

/**
 * @param {Record<string, unknown>} row
 */
function evidenceAssignmentTime(row) {
  const timestamp = Date.parse(String(row['requested-evidence-at'] ?? row['observed-at'] ?? ''));
  return Number.isFinite(timestamp) ? timestamp : 0;
}

/**
 * @param {unknown} value
 * @returns {value is number}
 */
function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * @param {{ sources: Record<string, import('./presenter.js').LogicalSourceInput>, workflows: Array<Record<string, unknown>>, runs: Array<Record<string, unknown>>, usage: Array<Record<string, unknown>>, outcomes: Array<Record<string, unknown>>, findings: Array<Record<string, unknown>>, operationalValues: Array<Record<string, unknown>>, health: ReturnType<typeof summarizeRunHealth> }} input
 */
function buildDomainAttentionRows(input) {
  const runTelemetryAvailable = input.sources.runs?.metadata?.availability === 'available';
  const runTelemetryComplete = input.sources.runs?.metadata?.completeness === 'complete';
  const controlPolicyDiagnostics = rowsFor(input.sources, 'coverage-diagnostics')
    .filter((row) => String(row.title) === 'Control policy resolution unavailable');
  const controlPolicyBlocks = controlPolicyDiagnostics.length;
  const admissionBlocks = input.workflows.filter((row) => String(row['admission-status']) === 'blocked').length;
  const apiCapacityBlocks = input.runs.filter(isApiCapacityBlock).length;
  const controlBlocks = controlPolicyBlocks + admissionBlocks + apiCapacityBlocks;
      const warningOutputs = input.findings.filter(isAuthoredWarning).length;
      const inventoryGaps = input.workflows.filter((row) => row['inventory-ready'] === false).length;
      const openOutputs = input.outcomes.filter((row) => String(row['outcome-state']) === 'pending').length;
      const orchestratorPaths = new Set(input.workflows
        .filter((row) => String(row['workflow-role']) === 'orchestrator')
        .map((row) => String(row.workflow ?? ''))
        .filter(Boolean));
      const rootRuns = input.runs.filter((row) => orchestratorPaths.has(String(row.workflow ?? '')));
      const rootFailures = rootRuns.filter((row) => isFailureConclusion(row['run-conclusion'])).length;
      const selectedValueRuns = new Set(input.operationalValues
        .map((row) => String(row.run ?? ''))
        .filter(Boolean)).size || input.operationalValues.length;
      const valueAttentionRequired = openOutputs > 0
        || input.operationalValues.some((row) => row['maturity-status'] && row['maturity-status'] !== 'matured')
        || input.sources['operational-values']?.metadata?.completeness === 'partial';
      const measuredUsage = input.usage.filter((row) =>
        row.aic !== null && row.aic !== undefined && row.aic !== '' && Number.isFinite(Number(row.aic))
      );
      const measuredRuns = new Set(measuredUsage.map((row) => usageRunKey(row)).filter(Boolean)).size;
      const usageAvailable = input.sources.usage?.metadata?.availability === 'available';
      const usageComplete = input.sources.usage?.metadata?.completeness === 'complete';
      const usageTotal = measuredUsage.reduce((total, row) => total + Number(row.aic), 0);
      const collectionGaps = ['workflows', 'runs', 'usage'].filter((name) => {
        const metadata = input.sources[name]?.metadata;
        return metadata?.availability !== 'available'
          || metadata.completeness !== 'complete'
          || metadata.freshness !== 'fresh';
      }).length + inventoryGaps;
      const attributionGaps = rootRuns.length;
      const evidenceGaps = collectionGaps + attributionGaps;
      const securitySignals = controlBlocks + input.health.approval + warningOutputs + inventoryGaps;

      return [
        domainRow({
          order: 0,
          priority: input.health.failed > 0 ? 0 : input.health.approval > 0 ? 1 : runTelemetryAvailable ? 2 : 3,
          state: input.health.failed > 0 ? 'Act now' : input.health.approval > 0 ? 'Investigate' : runTelemetryAvailable ? 'Monitor' : 'Unavailable',
          icon: input.health.failed > 0 ? 'issue' : 'check-circle',
          domain: 'Runtime health',
          value: runTelemetryAvailable ? `${formatCount(input.health.failed)} failed` : 'Not observed',
          detail: runTelemetryAvailable
            ? `${formatCount(input.health.successful)} of ${formatCount(input.health.total)} runs succeeded · ${formatCount(input.health.approval)} approval gates${runTelemetryComplete ? '' : ' · run coverage is partial'}`
            : 'Actions run telemetry is unavailable; workflow registrations may still be current.',
          href: '#page-runtime'
        }),
        domainRow({
          order: 1,
          priority: controlBlocks > 0 ? 0 : input.health.approval > 0 || warningOutputs > 0 || inventoryGaps > 0 ? 1 : 3,
          state: controlBlocks > 0 ? 'Act now' : input.health.approval > 0 || warningOutputs > 0 || inventoryGaps > 0 ? 'Investigate' : 'Unavailable',
          icon: 'shield',
          domain: 'Security & controls',
          value: `${formatCount(securitySignals)} signal${pluralSuffix(securitySignals)}`,
          detail: `${formatCount(admissionBlocks)} admission gates · ${formatCount(apiCapacityBlocks)} API capacity gates · ${formatCount(controlPolicyBlocks)} policy resolution blocks · ${formatCount(input.health.approval)} approval gates · ${formatCount(inventoryGaps)} integrity gaps`,
          href: controlPolicyBlocks > 0 ? '#page-coverage' : '#page-security'
        }),
        domainRow({
          order: 3,
          priority: rootFailures > 0 ? 0 : attributionGaps > 0 ? 1 : 2,
          state: rootFailures > 0 ? 'Act now' : attributionGaps > 0 ? 'Investigate' : 'Monitor',
          icon: 'workflow',
          domain: 'Episodes & autonomy',
          value: `${formatCount(rootRuns.length)} observed`,
          detail: `0 of 0 worker dispatches attributed · ${formatCount(rootFailures)} root failure${pluralSuffix(rootFailures)}`,
          href: '#page-runtime?section=runtime-observed-root-episodes-heading'
        }),
        domainRow({
          order: 2,
          priority: valueAttentionRequired ? 1 : 3,
          state: valueAttentionRequired ? 'Investigate' : 'Unavailable',
          icon: 'beaker',
          domain: 'Value & outcomes',
          value: 'Threshold unavailable',
          detail: `${formatCount(input.operationalValues.length)} of ${formatCount(selectedValueRuns)} grader observations · ${formatCount(openOutputs)} open outputs · no ROI is inferred`,
          href: '#page-operational-value'
        }),
        domainRow({
          order: 4,
          priority: usageAvailable && !usageComplete ? 1 : 3,
          state: !usageAvailable ? 'Unavailable' : !usageComplete ? 'Investigate' : 'Monitor',
          icon: 'meter',
          domain: 'Cost & efficiency',
          value: usageAvailable ? `${formatAic(usageTotal)} AIC` : 'Not observed',
          detail: usageAvailable
            ? `${formatCount(measuredRuns)} measured runs · ${usageComplete ? 'monthly budget verdict unavailable' : 'usage coverage is partial; monthly budget verdict unavailable'}`
            : 'AI Credit usage telemetry is unavailable; this does not change workflow registration evidence.',
          href: '#page-cost'
        }),
        domainRow({
          order: 5,
          priority: evidenceGaps > 0 ? 1 : 2,
          state: evidenceGaps > 0 ? 'Investigate' : 'Monitor',
          icon: 'codescan',
          domain: 'Evidence quality',
          value: `${formatCount(evidenceGaps)} gaps`,
          detail: `${formatCount(collectionGaps)} collection or inventory gaps · ${formatCount(attributionGaps)} attribution gaps`,
          href: '#page-coverage'
        })
      ].sort((left, right) => Number(left.priority) - Number(right.priority) || Number(left.order) - Number(right.order));
    }

/**
 * @param {{ order: number, priority: number, state: string, icon: string, domain: string, value: string, detail: string, href: string }} row
 */
function domainRow(row) {
      return {
        ...row,
        tone: row.state === 'Act now'
          ? 'critical'
          : row.state === 'Investigate'
            ? 'investigate'
            : row.state === 'Monitor' ? 'monitor' : 'unavailable'
      };
    }

/**
 * @param {number} value
 */
function roundMetric(value) {
  return Math.round(value * 1000) / 1000;
}


/** @param {Record<string, unknown>} row */
function isApiCapacityBlock(row) {
  return String(row['admission-status']) === 'resource-limited' && String(row.resource) === 'github-rest-api';
}

/** @param {Record<string, unknown>} row */
function apiCapacityDetail(row) {
  const resetAt = String(row['resource-reset-at'] ?? '');
  const waitHours = Number(row['resource-wait-hours']);
  if (!resetAt) return 'GitHub REST API capacity could not be verified. Check authentication before retrying.';
  if (!Number.isFinite(waitHours) || waitHours <= 0) return `The reported reset time ${resetAt} has passed; rerun now.`;
  return `Retry after ${resetAt}, approximately ${formatNumber(waitHours)} hours from dashboard collection.`;
}

/**
 * @param {{ runs: Array<Record<string, unknown>>, workflows: Array<Record<string, unknown>>, findings: Array<Record<string, unknown>> }} input
 */
function buildSecuritySummary(input) {
  return [
    { label: 'Admission gates', value: input.workflows.filter((row) => String(row['admission-status']) === 'blocked').length },
    { label: 'API capacity gates', value: input.runs.filter(isApiCapacityBlock).length },
    { label: 'Approval gates', value: input.runs.filter((row) => String(row['run-conclusion']) === 'action-required').length },
    { label: 'Explicit warnings', value: input.findings.filter(isAuthoredWarning).length },
    { label: 'Package integrity gaps', value: input.workflows.filter((row) => row['inventory-ready'] === false).length },
    { label: 'Vulnerability findings', value: '—' }
  ];
}

/**
 * @param {{ workflows: Array<Record<string, unknown>>, runs: Array<Record<string, unknown>>, findings: Array<Record<string, unknown>>, outcomes: Array<Record<string, unknown>> }} input
 */
function buildSecuritySignals(input) {
  const workflowNames = new Map(input.workflows.map((row) => [String(row.workflow ?? ''), String(row['workflow-name'] ?? row.workflow ?? 'Unknown workflow')]));
  const outcomeIds = new Set(input.outcomes.map((row) => String(row['safe-output'] ?? '')).filter(Boolean));
  const signals = [
    ...groupRows(input.workflows.filter((row) => String(row['admission-status']) === 'blocked'), (row) => String(row.package ?? row.workflow ?? ''))
      .map(([key, rows]) => ({
        priority: 0,
        count: rows.length,
        tone: 'danger',
        icon: 'shield',
        kind: 'Admission gate',
        title: String(rows[0]?.['package-name'] ?? rows[0]?.['workflow-name'] ?? key),
        detail: [...new Set(rows.map((row) => String(row['admission-reason'] || 'blocked')))].sort().join(', '),
        evidence: 'Checked-in control policy',
        action: 'View package',
        'navigation-page': 'packages'
      })),
    ...groupRows(input.runs.filter(isApiCapacityBlock), (row) => String(row.workflow ?? ''))
      .map(([workflow, rows]) => {
        const latest = latestRow(rows);
        return {
          priority: 0,
          count: rows.length,
          tone: 'danger',
          icon: 'meter',
          kind: 'Resource admission gate',
          title: workflowNames.get(workflow) ?? workflow,
          detail: apiCapacityDetail(latest),
          evidence: 'Pre-activation GitHub REST API check',
          action: 'Open official GitHub guidance',
          'external-link': {
            relation: 'official-guidance',
            href: GITHUB_RATE_LIMIT_DOCS,
            label: 'GitHub REST API rate-limit guidance'
          }
        };
      }),
    ...groupRows(input.runs.filter((row) => String(row['run-conclusion']) === 'action-required'), (row) => String(row.workflow ?? ''))
      .map(([workflow, rows]) => ({
        priority: 1,
        count: rows.length,
        tone: 'action',
        icon: 'shield',
        kind: 'Approval gate',
        title: workflowNames.get(workflow) ?? workflow,
        detail: `${formatNumber(rows.length)} run${rows.length === 1 ? ' requires' : 's require'} maintainer approval`,
        evidence: 'Execution control',
        action: 'View evidence',
        'run-link': latestRow(rows)?.['run-link']
      })),
    ...groupRows(input.workflows.filter((row) => row['inventory-ready'] === false), (row) => String(row.package ?? row.workflow ?? ''))
      .map(([key, rows]) => ({
        priority: 2,
        count: rows.length,
        tone: 'informational',
        icon: 'package',
        kind: 'Package integrity',
        title: String(rows[0]?.['package-name'] ?? rows[0]?.['workflow-name'] ?? key),
        detail: `${formatNumber(rows.length)} workflow definition${pluralSuffix(rows.length)} failed inventory readiness checks`,
        evidence: 'Inventory gap',
        action: 'View package',
        'navigation-page': 'packages'
      })),
    ...groupRows(input.findings.filter(isAuthoredWarning), findingWorkflowKey)
      .map(([workflow, rows]) => {
        const latest = latestRow(rows);
        const outcomeId = String(latest?.finding ?? '');
        return {
          priority: 3,
          count: rows.length,
          tone: 'warning',
          icon: 'issue',
          kind: 'Authored warning',
          title: workflowNames.get(workflow) ?? String(rows[0]?.['finding-summary'] ?? workflow),
          detail: `${formatNumber(rows.length)} retained output${rows.length === 1 ? ' contains' : 's contain'} an explicit warning block`,
          evidence: 'Output content',
          action: 'View evidence',
          ...(outcomeIds.has(outcomeId)
            ? { 'navigation-href': `#page-outcome-detail?outcome=${encodeURIComponent(outcomeId)}` }
            : { 'external-link': latest?.['external-link'] })
        };
      })
  ];
  return signals.sort((left, right) => left.priority - right.priority || right.count - left.count || left.title.localeCompare(right.title));
}

/**
 * @param {Record<string, unknown>} row
 */
function isAuthoredWarning(row) {
  return String(row['finding-kind']) === 'authored-warning';
}

/**
 * @param {Record<string, unknown>} row
 */
function findingWorkflowKey(row) {
  return String(row.workflow ?? '');
}

/**
 * @param {Array<Record<string, unknown>>} rows
 * @param {(row: Record<string, unknown>) => string} keyFor
 */
function groupRows(rows, keyFor) {
  /** @type {Map<string, Array<Record<string, unknown>>>} */
  const groups = new Map();
  for (const row of rows) {
    const key = keyFor(row);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return [...groups.entries()];
}

/**
 * @param {Array<Record<string, unknown>>} rows
 */
function latestRow(rows) {
  return rows.toSorted((left, right) => rowTimestamp(right) - rowTimestamp(left))[0];
}

/**
 * @param {Record<string, unknown>} row
 */
function rowTimestamp(row) {
  const timestamp = Date.parse(String(row['observed-at'] ?? row['started-at'] ?? ''));
  return Number.isFinite(timestamp) ? timestamp : 0;
}

/**
 * @param {{ sources: Record<string, import('./presenter.js').LogicalSourceInput>, workflows: Array<Record<string, unknown>>, repositories: Array<Record<string, unknown>>, runs: Array<Record<string, unknown>>, usage: Array<Record<string, unknown>>, packages: ReturnType<typeof summarizePackages>, health: ReturnType<typeof summarizeRunHealth>, disabledWorkflows: number }} input
 */
function buildOverviewStatusRow(input) {
  const { sources, workflows, repositories, runs, usage, packages, health, disabledWorkflows } = input;
  const hasRunTelemetry = sources.runs?.metadata?.availability !== 'unavailable';
  const repositoryCount = repositories.length > 0
    ? new Set(repositories.map(repositoryKey).filter(Boolean)).size
    : distinctRepositories(workflows, runs);
  const failureRepositories = new Set(health.failedRows.map(repositoryKey).filter(Boolean)).size;
  const scope = [...new Set(workflows
    .map((row) => String(row.organization ?? '').trim())
    .filter(Boolean))]
    .sort()
    .join(' + ') || 'Configured repositories';
  const status = !hasRunTelemetry
    ? { className: 'control-plane-monitoring', icon: 'eye', label: 'Monitoring' }
    : health.failed > 0
      ? { className: 'control-plane-critical', icon: 'issue', label: 'Attention required' }
      : health.approval > 0 || disabledWorkflows > 0
        ? { className: 'control-plane-monitoring', icon: 'issue', label: 'Approval required' }
        : { className: 'control-plane-healthy', icon: 'check-circle', label: 'Healthy' };
  const statusCopy = !hasRunTelemetry
    ? 'Run telemetry is unavailable, so execution health cannot be determined.'
    : health.failed > 0
      ? `${formatNumber(health.failed)} of ${formatNumber(health.total)} runs failed across ${formatNumber(failureRepositories)} of ${formatNumber(repositoryCount)} repositories in the current window.`
      : health.approval > 0
        ? `${formatNumber(health.approval)} run${health.approval === 1 ? ' is' : 's are'} waiting for maintainer approval.`
        : `No failures observed across ${formatNumber(health.total)} runs in the current window.`;
  const usageCoverage = usage.length > 0
    ? `${formatNumber(new Set(usage.map((row) => String(row.run ?? '')).filter(Boolean)).size)} AIC artifacts`
    : 'AIC unavailable';
  const usageCompleteness = sources.usage?.metadata?.completeness === 'partial' ? 'partial' : '';

  return {
    scope,
    'status-class': status.className,
    'status-icon': status.icon,
    'status-label': status.label,
    'status-copy': statusCopy,
    'health-total': health.total,
    'coverage-label': `${usageCoverage}${usageCompleteness ? ` · ${usageCompleteness}` : ''}`,
    packages: packages.length,
    'managed-workers': packages.reduce((total, entry) => total + entry.workers, 0),
    'active-workflows': workflows.filter(isActiveWorkflow).length,
    'disabled-workflows': disabledWorkflows,
    repositories: repositoryCount,
    'has-run-telemetry': hasRunTelemetry
  };
}

/**
 * @param {{ sources: Record<string, import('./presenter.js').LogicalSourceInput>, packages: ReturnType<typeof summarizePackages>, health: ReturnType<typeof summarizeRunHealth>, workflows: Array<Record<string, unknown>>, repositories: Array<Record<string, unknown>>, runs: Array<Record<string, unknown>> }} input
 */
function buildOverviewVitals(input) {
  const { sources, packages, health, workflows, repositories, runs } = input;
  const hasRunTelemetry = sources.runs?.metadata?.availability !== 'unavailable';
  const disabledWorkflows = workflows.filter((row) => String(row['workflow-active']) === 'false').length;
  const managedWorkers = packages.reduce((total, entry) => total + entry.workers, 0);
  const repositoryCount = repositories.length > 0
    ? new Set(repositories.map(repositoryKey).filter(Boolean)).size
    : distinctRepositories(workflows, runs);
  return [
    { label: 'Managed packages', value: packages.length, detail: `${managedWorkers} worker workflow${pluralSuffix(managedWorkers)}` },
    { label: 'Active workflows', value: workflows.filter(isActiveWorkflow).length, detail: `${disabledWorkflows} disabled · ${repositoryCount} repositories` },
    { label: 'Runs · 24h', value: hasRunTelemetry ? health.total : '—', detail: sourceWindowLabel(sources.runs) },
    {
      label: 'Failure rate',
      value: hasRunTelemetry && health.total > 0 ? formatPercent(health.failed / health.total) : '—',
      detail: hasRunTelemetry ? `${health.failed} failed runs` : 'Telemetry unavailable',
      className: 'vital-failures'
    }
  ];
}

/**
 * @param {ReturnType<typeof summarizeRunHealth>} health
 */
function buildExecutionHealthRows(health) {
  return [
    ['successful', health.successful, 'execution-success'],
    ['failed', health.failed, 'execution-failed'],
    ['approval required', health.approval, 'execution-approval'],
    ['other', health.other, 'execution-other']
  ].map(([label, value, className]) => ({ label, value, className, total: health.total }));
}

/**
 * @param {{ sources: Record<string, import('./presenter.js').LogicalSourceInput>, workflows: Array<Record<string, unknown>>, runs: Array<Record<string, unknown>>, findings: Array<Record<string, unknown>>, packages: ReturnType<typeof summarizePackages>, disabledWorkflows: number, health: ReturnType<typeof summarizeRunHealth> }} input
 */
function buildAttentionRows(input) {
  const apiCapacityBlocks = input.runs.filter(isApiCapacityBlock);
  const apiCapacityRunIds = new Set(apiCapacityBlocks.map((row) => String(row.run ?? '')).filter(Boolean));
  const unclassifiedFailures = input.health.failedRows.filter((row) => !apiCapacityRunIds.has(String(row.run ?? '')));
  const failedRepositories = new Set(unclassifiedFailures.map(repositoryKey).filter(Boolean)).size;
  const packageGaps = input.packages.filter((entry) => !entry.ready).length;
  const openFindings = input.findings.filter((row) => String(row['finding-status']) === 'open').length;
  const controlPolicyDiagnostics = rowsFor(input.sources, 'coverage-diagnostics')
    .filter((row) => String(row.title) === 'Control policy resolution unavailable');
  const admissionBlocks = input.workflows.filter((row) => String(row['admission-status']) === 'blocked');
  const admissionReasons = [...new Set(admissionBlocks.map((row) => String(row['admission-reason'] || 'blocked')))].sort();
  const coverageGaps = ['workflows', 'runs', 'usage'].filter((name) => {
    const metadata = input.sources[name]?.metadata;
    return metadata?.availability !== 'available' || metadata.completeness !== 'complete' || metadata.freshness !== 'fresh';
  });
  const latestCapacityBlock = latestRow(apiCapacityBlocks);
  return buildAttentionItems({
    'control-policy-unavailable': {
      count: controlPolicyDiagnostics.length,
      reason: controlPolicyDiagnostics[0]?.effect || 'The authoritative control policy could not be resolved.'
    },
    'admission-blocked': {
      count: admissionBlocks.length,
      list: admissionReasons.join(', ')
    },
    'api-capacity-blocked': {
      count: apiCapacityBlocks.length,
      detail: apiCapacityBlocks.length > 0 ? apiCapacityDetail(latestCapacityBlock) : ''
    },
    'runs-failed': { count: unclassifiedFailures.length, repositories: failedRepositories },
    'runs-approval': { count: input.health.approval },
    'disabled-workflows': { count: input.disabledWorkflows },
    'package-gaps': { count: packageGaps },
    'open-findings': { count: openFindings },
    'coverage-gaps': { count: coverageGaps.length, list: coverageGaps.join(', ') }
  });
}

/**
 * @param {ReturnType<typeof summarizePackages>[number]} entry
 * @param {ReturnType<typeof summarizePackageAicUsage>} usageByPackage
 * @param {import('./presenter.js').LogicalSourceInput | undefined} usageSource
 */
function buildPackageUtilizationRow(entry, usageByPackage, usageSource) {
  const available = usageSource?.metadata?.availability !== 'unavailable';
  const used = usageByPackage.used.get(entry.id) ?? 0;
  const reportedRuns = usageByPackage.reportedRuns.get(entry.id) ?? 0;
  const allowance = /** @type {number} */ (entry.allowance);
  const ratio = available && allowance > 0 ? used / allowance : null;
  const meterPercent = ratio === null ? 0 : Math.min(100, ratio * 100);
  const status = !available || ratio === null ? 'empty' : classifyUtilizationRatio(ratio);
  return {
    package: entry.id,
    title: entry.name,
    status,
    value: !available || ratio === null ? '—' : formatPercent(ratio),
    'meter-percent': meterPercent,
    detail: !available
      ? 'AI Credit usage artifacts are unavailable.'
      : reportedRuns === 0
        ? 'No completed runs in the retained window.'
        : `${formatNumber(used)} of ${formatNumber(allowance)} AIC across ${formatNumber(reportedRuns)} reported run${pluralSuffix(reportedRuns)}.`,
    'aria-label': ratio === null
      ? `${entry.name}: no utilization available`
      : `${entry.name}: ${formatNumber(used)} of ${formatNumber(allowance)} AI Credits used, ${formatPercent(ratio)}`
  };
}

/**
 * @param {Array<Record<string, unknown>>} workflows
 * @param {Array<Record<string, unknown>>} usage
 * @returns {{ used: Map<string, number>, reportedRuns: Map<string, number> }}
 */
function summarizePackageAicUsage(workflows, usage) {
  /** @type {Map<string, string>} */
  const workflowToPackage = new Map();
  for (const row of workflows) {
    const packageId = row.package;
    const workflowPath = row.workflow;
    if (typeof packageId === 'string' && packageId.length > 0 && typeof workflowPath === 'string' && workflowPath.length > 0) {
      workflowToPackage.set(workflowPath, packageId);
    }
  }
  /** @type {Map<string, number>} */
  const used = new Map();
  /** @type {Map<string, number>} */
  const reportedRuns = new Map();
  for (const row of usage) {
    const workflowPath = typeof row.workflow === 'string' ? row.workflow : '';
    const packageId = workflowToPackage.get(workflowPath);
    if (!packageId) continue;
    const aic = Number(row.aic);
    if (!Number.isFinite(aic)) continue;
    used.set(packageId, (used.get(packageId) ?? 0) + aic);
    reportedRuns.set(packageId, (reportedRuns.get(packageId) ?? 0) + 1);
  }
  return { used, reportedRuns };
}

/**
 * @param {Array<Record<string, unknown>>} workflows
 * @param {Array<Record<string, unknown>>} runs
 * @param {Array<Record<string, unknown>>} outcomes
 */
function summarizePackageActivity(workflows, runs, outcomes) {
  const workflowPackages = new Map(workflows
    .filter((row) => typeof row.package === 'string' && row.package && typeof row.workflow === 'string' && row.workflow)
    .map((row) => [scopedWorkflowKey(row), String(row.package)]));
  /** @type {Map<string, { dispatches: Set<string>, successful: Set<string>, failed: Set<string>, approval: Set<string>, pending: Set<string> }>} */
  const activityByPackage = new Map();
  const packageByDispatch = new Map();
  for (const run of runs) {
    if (String(run.event) !== 'workflow_dispatch') continue;
    const packageId = workflowPackages.get(scopedWorkflowKey(run));
    const dispatchKey = runtimeRunKey(run);
    if (!packageId || !dispatchKey) continue;
    const activity = activityByPackage.get(packageId) ?? {
      dispatches: new Set(),
      successful: new Set(),
      failed: new Set(),
      approval: new Set(),
      pending: new Set()
    };
    activity.dispatches.add(dispatchKey);
    if (isFailureConclusion(run['run-conclusion'])) activity.failed.add(dispatchKey);
    else if (isApprovalConclusion(run['run-conclusion'])) activity.approval.add(dispatchKey);
    else if (String(run['run-status'] ?? '') && String(run['run-status']) !== 'completed') activity.pending.add(dispatchKey);
    else if (String(run['run-conclusion']) === 'success') activity.successful.add(dispatchKey);
    activityByPackage.set(packageId, activity);
    packageByDispatch.set(dispatchKey, packageId);
  }

  /** @type {Map<string, Set<string>>} */
  const outputDispatchesByPackage = new Map();
  for (const outcome of outcomes) {
    if (!String(outcome['safe-output'] ?? '').trim()) continue;
    const dispatchKey = runtimeRunKey(outcome);
    const packageId = packageByDispatch.get(dispatchKey);
    if (!packageId) continue;
    const outputDispatches = outputDispatchesByPackage.get(packageId) ?? new Set();
    outputDispatches.add(dispatchKey);
    outputDispatchesByPackage.set(packageId, outputDispatches);
  }

  return new Map([...new Set(workflowPackages.values())].map((packageId) => {
    const activity = activityByPackage.get(packageId);
    return [packageId, {
      dispatches: activity?.dispatches.size ?? 0,
      successfulDispatches: activity?.successful.size ?? 0,
      failedDispatches: activity?.failed.size ?? 0,
      approvalDispatches: activity?.approval.size ?? 0,
      pendingDispatches: activity?.pending.size ?? 0,
      dispatchesWithSafeOutputs: outputDispatchesByPackage.get(packageId)?.size ?? 0
    }];
  }));
}

/**
 * @param {Array<Record<string, unknown>>} rows
 */
function summarizeRunHealth(rows) {
  const failedRows = rows.filter((row) => isFailureConclusion(row['run-conclusion']));
  const approval = rows.filter((row) => isApprovalConclusion(row['run-conclusion'])).length;
  const successful = rows.filter((row) => String(row['run-conclusion']) === 'success').length;
  return {
    total: rows.length,
    successful,
    failed: failedRows.length,
    failedRows,
    approval,
    other: Math.max(0, rows.length - successful - failedRows.length - approval)
  };
}

/** @param {Record<string, unknown>} row */
function isCompletedRun(row) {
  return String(row['run-status']) === 'completed';
}

/**
 * @param {Array<Record<string, unknown>>} rows
 */
function summarizePackages(rows) {
  /** @type {Map<string, Array<Record<string, unknown>>>} */
  const grouped = new Map();
  for (const row of rows) {
    if (typeof row.package !== 'string' || row.package.length === 0) continue;
    const packageRows = grouped.get(row.package) ?? [];
    packageRows.push(row);
    grouped.set(row.package, packageRows);
  }
  return [...grouped.entries()]
    .map(([id, packageRows]) => {
      const workers = packageRows.filter((row) => String(row['workflow-role']) === 'worker');
      const orchestrators = packageRows.filter((row) => String(row['workflow-role']) === 'orchestrator');
      const allowances = packageRows
        .map((row) => Number(row['max-ai-credits']))
        .filter((value) => Number.isFinite(value) && value > 0);
      const packageAllowance = Number(packageRows.find((row) => Number.isFinite(Number(row['package-aic-allowance'])))?.['package-aic-allowance']);
      const packageWorkerCount = Number(packageRows.find((row) => Number.isFinite(Number(row['package-worker-count'])))?.['package-worker-count']);
      const explicitReady = packageRows.map((row) => row['inventory-ready']).filter((value) => typeof value === 'boolean');
      const packageRolloutPercent = Number(packageRows.find((row) => Number.isFinite(Number(row['package-rollout-percent'])))?.['package-rollout-percent']);
      const fallbackRolloutPercent = Number(packageRows.find((row) => Number.isFinite(Number(row['rollout-percent'])))?.['rollout-percent']);
      const rolloutPercent = Number.isFinite(packageRolloutPercent)
        ? packageRolloutPercent
        : Number.isFinite(fallbackRolloutPercent) ? fallbackRolloutPercent : null;
      const repositoryModes = summarizePackageRepositoryModes(packageRows);
      const rolloutRepositories = repositoryModes.length;
      const rolloutLiveRepositories = repositoryModes.filter((entry) => entry.mode === 'live').length;
      const liveCoveragePercent = rolloutRepositories > 0
        ? Math.round((rolloutLiveRepositories / rolloutRepositories) * 100)
        : null;
      return {
        id,
        name: String(packageRows.find((row) => typeof row['package-name'] === 'string')?.['package-name'] ?? titleCase(id)),
        icon: String(packageRows.find((row) => typeof row['package-icon'] === 'string')?.['package-icon'] ?? 'package'),
        workers: Number.isFinite(packageWorkerCount) ? packageWorkerCount : workers.length,
        mode: String(orchestrators[0]?.['rollout-mode'] ?? packageRows[0]?.['rollout-mode'] ?? 'unknown'),
        rolloutPercent,
        liveCoveragePercent,
        rolloutLiveRepositories,
        rolloutRepositories,
        repositoryModes,
        allowance: Number.isFinite(packageAllowance)
          ? packageAllowance
          : allowances.length > 0 ? allowances.reduce((total, value) => total + value, 0) : null,
        ready: explicitReady.includes(false)
          ? false
          : explicitReady.length > 0
            ? true
            : orchestrators.length === 1 && workers.length > 0 && packageRows.every(isActiveWorkflow)
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * @param {Array<Record<string, unknown>>} packageRows
 * @returns {Array<{ repository: string, mode: string }>} 
 */
function summarizePackageRepositoryModes(packageRows) {
  const repositoryModes = new Map();
  for (const target of packageRows.flatMap((row) => Array.isArray(row['package-targets']) ? row['package-targets'] : [])) {
    const repository = String(target?.repository ?? '').trim();
    const mode = normalizeRolloutMode(target?.mode);
    if (!repository || !mode || mode === 'unknown') continue;
    repositoryModes.set(repository, mode);
  }
  if (repositoryModes.size > 0) return [...repositoryModes.entries()].map(([repository, mode]) => ({ repository, mode }));
  for (const row of packageRows) {
    const repository = repositoryKey(row);
    const mode = normalizeRolloutMode(row['rollout-mode'] ?? row['package-target-mode']);
    if (!repository || !mode || mode === 'unknown') continue;
    repositoryModes.set(repository, mode);
  }
  return [...repositoryModes.entries()].map(([repository, mode]) => ({ repository, mode }));
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalizeRolloutMode(value) {
  const text = String(value ?? '').trim().toLowerCase();
  return text === 'review' || text === 'live' ? text : 'unknown';
}

/**
 * @param {Record<string, import('./presenter.js').LogicalSourceInput | undefined>} sources
 * @returns {import('./presenter.js').SourceMetadata}
 */
function createOverviewMetadata(sources) {
  const sourceMetadata = Object.values(sources)
    .map((source) => source?.metadata)
    .filter((metadata) => metadata !== undefined);
  const latest = sourceMetadata
    .map((metadata) => metadata['retrieved-at'])
    .filter((value) => typeof value === 'string' && Number.isFinite(Date.parse(value)))
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? new Date(0).toISOString();
  return {
    'source-id': 'derived-overview',
    'source-kind': 'derived',
    'as-of': latest,
    'retrieved-at': latest,
    completeness: sourceMetadata.some((metadata) => metadata.completeness === 'partial')
      ? 'partial'
      : sourceMetadata.length > 0 && sourceMetadata.every((metadata) => metadata.completeness === 'complete') ? 'complete' : 'unknown',
    freshness: sourceMetadata.some((metadata) => metadata.freshness === 'stale')
      ? 'stale'
      : sourceMetadata.length > 0 && sourceMetadata.every((metadata) => metadata.freshness === 'fresh') ? 'fresh' : 'unknown',
    availability: 'available'
  };
}

/**
 * @param {Record<string, import('./presenter.js').LogicalSourceInput>} sources
 * @param {string} name
 * @returns {Array<Record<string, unknown>>}
 */
function rowsFor(sources, name) {
  return Array.isArray(sources[name]?.rows) ? sources[name].rows : [];
}

/**
 * @param {Record<string, unknown>} row
 * @returns {boolean}
 */
function isActiveWorkflow(row) {
  return String(row['workflow-active']) === 'true';
}

/**
 * @param {Record<string, unknown>} row
 * @returns {string}
 */
function repositoryKey(row) {
  const repository = String(row.repository ?? '').trim();
  if (!repository) return '';
  const organization = String(row.organization ?? '').trim();
  return organization ? `${organization}/${repository}` : repository;
}

/** @param {Record<string, unknown>} row */
function scopedWorkflowKey(row) {
  const repository = String(row['runtime-repository'] ?? repositoryKey(row)).trim().toLowerCase();
  return `${repository}:${String(row.workflow ?? '')}`;
}

/**
 * @param {Array<Record<string, unknown>>} workflows
 * @returns {(row: Record<string, unknown>) => string}
 */
function buildWorkflowRoleResolver(workflows) {
  const roleByScopedWorkflow = new Map(workflows.map((row) => [
    scopedWorkflowKey(row),
    String(row['workflow-role'] || 'unknown')
  ]));
  return (row) => String(row['workflow-role'] || '')
    || roleByScopedWorkflow.get(scopedWorkflowKey(row))
    || 'unknown';
}

/** @param {Record<string, unknown>} row */
function runtimeRunKey(row) {
  const repository = String(row['runtime-repository'] ?? repositoryKey(row)).trim().toLowerCase();
  const run = String(row.run ?? '').trim();
  return repository && run ? `${repository}:${run}` : '';
}

/**
 * @param {import('./presenter.js').LogicalSourceInput | undefined} source
 */
function sourceIsAvailable(source) {
  return Boolean(source && Array.isArray(source.rows) && source.metadata?.availability !== 'unavailable');
}

/**
 * @param {Record<string, unknown>} row
 */
function usageRunKey(row) {
  const run = String(row.run ?? '').trim();
  const context = `${repositoryKey(row)}:${String(row.workflow ?? '')}`;
  if (run) return `${context}:${run}`;
  const invocation = String(row.invocation ?? '').trim();
  return invocation ? `${context}:${invocation}` : '';
}

/**
 * @param {...Array<Record<string, unknown>>} collections
 * @returns {number}
 */
function distinctRepositories(...collections) {
  return new Set(collections.flat().map(repositoryKey).filter(Boolean)).size;
}

/**
 * @param {import('./presenter.js').LogicalSourceInput | undefined} source
 * @returns {string}
 */
function sourceWindowLabel(source) {
  if (!source || source.metadata?.availability === 'unavailable') return 'Actions run data unavailable';
  const state = source.metadata?.completeness === 'complete' ? 'Complete' : 'Partial';
  return `${state} 24-hour Actions run window`;
}

/**
 * @param {number} value
 * @returns {string}
 */
