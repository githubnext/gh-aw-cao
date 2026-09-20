import { ingestDashboardSources } from '../ingest/coordinator.js';
import { workflowSourcePath } from '../model/ids.js';
import { readCollections } from '../storage/indexeddb.js';
import { createCanonicalQueries } from './index.js';

const monotonicNow = () => globalThis.performance?.now() ?? Date.now();

/**
 * @param {Record<string, unknown>} sources
 * @param {string} sourceName
 * @param {string} projectionName
 * @param {boolean} available
 * @returns {import('../../presenter.js').SourceMetadata}
 */
function projectionMetadata(sources, sourceName, projectionName, available) {
  const input = sources[sourceName] && typeof sources[sourceName] === 'object'
    ? /** @type {{ metadata?: Record<string, unknown> }} */ (sources[sourceName])
    : {};
  const metadata = input.metadata ?? {};
  const asOf = typeof metadata['as-of'] === 'string' ? metadata['as-of'] : '';
  return /** @type {import('../../presenter.js').SourceMetadata} */ ({
    ...metadata,
    'source-id': projectionName,
    'source-kind': 'canonical-query',
    'as-of': asOf,
    'retrieved-at': typeof metadata['retrieved-at'] === 'string' ? metadata['retrieved-at'] : asOf,
    availability: available ? 'available' : 'unavailable',
    completeness: available && ['complete', 'partial'].includes(String(metadata.completeness))
      ? metadata.completeness : 'unknown',
    freshness: available && ['fresh', 'stale'].includes(String(metadata.freshness))
      ? metadata.freshness : 'unknown'
  });
}

/**
 * @param {Record<string, unknown>} sources
 * @param {string} sourceName
 * @param {string} projectionName
 * @param {number} rowCount
 * @returns {import('../../presenter.js').SourceMetadata}
 */
function canonicalProjectionMetadata(sources, sourceName, projectionName, rowCount) {
  const metadata = projectionMetadata(sources, sourceName, projectionName, true);
  return {
    ...metadata,
    availability: rowCount > 0 ? 'available' : 'empty',
    completeness: metadata.completeness === 'unknown' ? 'complete' : metadata.completeness
  };
}

/**
 * @param {string} sourceName
 * @param {Record<string, unknown>} sources
 * @param {string} reason
 * @returns {import('../../presenter.js').LogicalSourceInput}
 */
function emptyCanonicalSource(sourceName, sources, reason) {
  return {
    source: sourceName,
    rows: [],
    metadata: /** @type {import('../../presenter.js').SourceMetadata} */ ({
      ...canonicalProjectionMetadata(sources, sourceName, sourceName, 0),
      completeness: 'unknown',
      freshness: 'unknown',
      'collection-state': 'not-collected',
      'collection-reason': reason
    })
  };
}

/** @param {Record<string, unknown>[]} runs @param {Record<string, unknown>} sources */
function failedRunsSource(runs, sources) {
  return {
    source: 'failed-runs',
    rows: runs.map((run) => ({
      organization: run.owner,
      repository: run.repository,
      workflow: run.workflowPath,
      run: String(run.githubRunId ?? ''),
      'run-attempt': run.attempt,
      'run-title': run.title,
      'started-at': run.startedAt,
      'ended-at': run.completedAt,
      'run-status': run.status,
      'run-conclusion': run.conclusion,
      'failure-detail': run.failureDetail,
      'run-link': run.runLink
    })),
    metadata: projectionMetadata(sources, 'runs', 'failed-runs', true)
  };
}

/** @param {unknown} value */
function normalizedKey(value) {
  return String(value ?? '').toLowerCase();
}

/** @param {Record<string, unknown>} run */
function runKey(run) {
  return [run.organization ?? run.owner, run.repository, run.run ?? run.githubRunId, run['run-attempt'] ?? run.attempt ?? 1]
    .map(normalizedKey).join(':');
}

/**
 * @param {Record<string, unknown>} run
 * @param {Map<string, Record<string, unknown>>} publishedRuns
 * @param {Map<unknown, Record<string, unknown>>} workflowsById
 */
function projectedRun(run, publishedRuns, workflowsById) {
  const workflow = workflowsById.get(run.workflowId) ?? {};
  return {
    ...(publishedRuns.get(runKey(run)) ?? {}),
    organization: run.owner,
    repository: run.repository,
    workflow: run.workflowPath ?? workflow.path,
    run: String(run.githubRunId ?? ''),
    'run-attempt': run.attempt,
    'run-title': run.title,
    'target-repository': run.targetRepository,
    event: run.event,
    branch: run.branch,
    'head-sha': run.headSha,
    'created-at': run.createdAt,
    'started-at': run.startedAt,
    'ended-at': run.completedAt,
    'updated-at': run.updatedAt,
    'run-status': run.status,
    'run-conclusion': run.conclusion,
    classification: run.classification,
    duration: run.duration,
    'action-minutes': run.actionMinutes,
    'github-api-calls': run.githubApiCalls,
    'safe-items-count': run.safeItemsCount,
    'error-count': run.errorCount,
    'failure-detail': run.failureDetail,
    'run-link': run.runLink,
    'rollout-mode': run.rolloutMode && run.rolloutMode !== 'unknown'
      ? run.rolloutMode
      : workflow.rolloutMode,
    'agent-id': run.agentId,
    'agent-version': run.agentVersion,
    'model-id': run.modelId,
    'gh-aw-version': run.ghAwVersion,
    'aic-total': run.aicTotal,
    engine: run.engine,
    'engine-id': run.engineId,
    'engine-version': run.engineVersion,
    'requested-model': run.requestedModel,
    'resolved-model': run.resolvedModel,
    'agent-runtime': run.agentRuntime,
    'firewall-version': run.firewallVersion,
    'gateway-version': run.gatewayVersion
  };
}

/**
 * @param {Record<string, unknown>[]} runs
 * @param {Map<unknown, Record<string, unknown>>} workflowsById
 * @param {Record<string, unknown>} sources
 */
function runsSource(runs, workflowsById, sources) {
  const publishedRuns = new Map(sourceRows(sources.runs).map((run) => [runKey(run), run]));
  return {
    source: 'runs',
    rows: runs.map((run) => projectedRun(run, publishedRuns, workflowsById)),
    metadata: projectionMetadata(sources, 'runs', 'runs', true)
  };
}

/** @param {Record<string, unknown>[]} repositories @param {Record<string, unknown>} sources */
function repositoriesSource(repositories, sources) {
  const publishedRepositories = new Map(sourceRows(sources.repositories).map((repository) => [
    [repository.organization, repository.repository].map(normalizedKey).join(':'),
    repository
  ]));
  return {
    source: 'repositories',
    rows: repositories.map((repository) => ({
      ...(publishedRepositories.get([repository.owner, repository.name].map(normalizedKey).join(':')) ?? {}),
      organization: repository.owner,
      repository: repository.name,
      'repository-name': repository.name,
      'repository-coordinate': `${String(repository.owner ?? '')}/${String(repository.name ?? '')}`,
      visibility: repository.visibility,
      'observed-at': repository.observedAt,
      'organization-link': repository.organizationLink,
      'repository-link': repository.repositoryLink
    })),
    metadata: projectionMetadata(sources, 'repositories', 'repositories', true)
  };
}

/** @param {Record<string, unknown>[]} campaigns @param {Record<string, unknown>} sources */
function campaignsSource(campaigns, sources) {
  return {
    source: 'campaigns',
    rows: campaigns.map((campaignRecord) => ({
      campaign: campaignRecord.slug,
      'campaign-name': campaignRecord.name,
      'campaign-description': campaignRecord.description,
      'campaign-icon': campaignRecord.icon,
      'campaign-mode': campaignRecord.mode,
      'campaign-enabled': campaignRecord.enabled,
      'campaign-registration': campaignRecord.enabled ? 'true' : 'false',
      'campaign-max-repositories': campaignRecord.maxRepositories,
      'campaign-rollout-percent': campaignRecord.rolloutPercent,
      'campaign-monthly-ai-credit-budget': campaignRecord.monthlyAiCreditBudget,
      'campaign-aic-allowance': campaignRecord.aiCreditAllowance,
      'campaign-worker-count': campaignRecord.workerCount,
      'campaign-inventory-warnings': campaignRecord.inventoryWarnings,
      'campaign-workers': campaignRecord.workers,
      'campaign-targets': campaignRecord.targets,
      'campaign-min-version': campaignRecord.minVersion,
      'campaign-version': campaignRecord.version,
      'campaign-current-version': campaignRecord.currentVersion,
      'campaign-update-state': campaignRecord.updateState,
      'campaign-experimental': campaignRecord.experimental,
      'campaign-readme-path': campaignRecord.readmePath,
      'campaign-readme': campaignRecord.readme,
      'observed-at': campaignRecord.observedAt,
      ...(campaignRecord.campaignLink ? { 'campaign-link': campaignRecord.campaignLink } : {})
    })),
    metadata: projectionMetadata(sources, 'campaigns', 'campaigns', true)
  };
}

/**
 * @param {Record<string, unknown>[]} workflows
 * @param {Map<unknown, Record<string, unknown>>} repositoriesById
 * @param {Record<string, unknown>} sources
 */
function workflowsSource(workflows, repositoriesById, sources) {
  const publishedWorkflows = new Map(sourceRows(sources.workflows).map((workflow) => [
    [
      workflow.organization,
      workflow.repository,
      workflowSourcePath(String(workflow.workflow ?? ''))
    ].map(normalizedKey).join(':'),
    workflow
  ]));
  return {
    source: 'workflows',
    rows: workflows.map((workflow) => {
      const repository = repositoriesById.get(workflow.repositoryId) ?? {};
      const publishedWorkflow = publishedWorkflows.get([
        repository.owner,
        repository.name,
        workflow.path
      ].map(normalizedKey).join(':'));
      return {
        ...(publishedWorkflow ?? {}),
        organization: repository.owner,
        repository: repository.name,
        workflow: workflow.path,
        'workflow-id': publishedWorkflow?.['workflow-id'] ?? workflow.githubId,
        'workflow-name': publishedWorkflow?.['workflow-name'] ?? workflow.name,
        'workflow-active': publishedWorkflow?.['workflow-active']
          ?? (workflow.state === 'active' ? 'true'
            : workflow.state === 'disabled' ? 'false' : 'unknown'),
        'workflow-registry-state': publishedWorkflow?.['workflow-registry-state'] ?? workflow.registryState,
        'created-at': publishedWorkflow?.['created-at'] ?? workflow.createdAt,
        'updated-at': publishedWorkflow?.['updated-at'] ?? workflow.updatedAt,
        campaign: workflow.campaign,
        'campaign-name': workflow.campaignName,
        'campaign-icon': workflow.campaignIcon,
        'workflow-role': workflow.role,
        'rollout-mode': workflow.rolloutMode,
        'max-ai-credits': workflow.maxAiCredits,
        'observed-at': workflow.observedAt,
        'gh-aw-version': workflow.ghAwVersion,
        'gh-aw-current-version': workflow.ghAwCurrentVersion,
        'gh-aw-update-state': workflow.ghAwUpdateState,
        'workflow-link': publishedWorkflow?.['workflow-link'] ?? workflow.workflowLink
      };
    }),
    metadata: projectionMetadata(sources, 'workflows', 'workflows', true)
  };
}

/** @param {Record<string, unknown>} record */
function definedFields(record) {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

/**
 * Projects retained run-linked records with their run and repository context.
 *
 * @param {string} sourceName
 * @param {Record<string, unknown>[]} records
 * @param {Map<unknown, Record<string, unknown>>} runsById
 * @param {Record<string, unknown>} sources
 */
function recordsSource(sourceName, records, runsById, sources) {
  const publishedRecords = new Map(sourceRows(sources[sourceName]).map((event) => [
    normalizedKey(event.event),
    event
  ]));
  const ordered = [...records].sort((left, right) =>
    String(left.runId).localeCompare(String(right.runId))
    || Number(left.sequence) - Number(right.sequence));
  return {
    source: sourceName,
    rows: ordered.map((event) => {
      const run = runsById.get(event.runId) ?? {};
      return {
        ...(publishedRecords.get(normalizedKey(event.id)) ?? {}),
        ...definedFields({
          organization: run.owner,
          repository: run.repository,
          workflow: run.workflowPath,
          run: run.githubRunId === undefined ? undefined : String(run.githubRunId),
          'run-attempt': run.attempt,
          event: event.id,
          'event-timestamp': event.timestamp,
          'event-source': event.source,
          'event-type': event.source === 'firewall'
            ? { net_allowed: 'firewall.request.allowed', net_blocked: 'firewall.request.blocked' }[String(event.type)] ?? event.type
            : event.type,
          'event-summary': event.summary,
          'event-status': event.status,
          'request-count': event.requestCount,
          'correlation-id': event.correlationId,
          'payload-ref': event.payloadRef,
          'mcp-server': event.mcpServer,
          'mcp-tool': event.mcpTool,
          'safe-output-type': event.safeOutputType,
          'github-entity-type': event.githubEntityType,
          'is-pull-request': event.isPullRequest,
          'tool-type': event.toolType,
          'is-skill': event.isSkill,
          name: event.name,
          'source-sequence': event.sourceSequence,
          'observed-at': event.observedAt,
          'run-link': run.runLink,
          'target-repo': event.targetRepo,
          'target-organization': event.targetOrganization,
          'target-repository': event.targetRepository,
          'target-workflow-path': event.targetWorkflowPath,
          'optimizer-run-attempt': event.optimizerRunAttempt,
          'optimizer-workflow-path': event.optimizerWorkflowPath,
          'optimizer-workflow-name': event.optimizerWorkflowName,
          'claim-run-id': event.claimRunId,
          'claim-run-attempt': event.claimRunAttempt,
          actor: event.actor,
          'source-provenance': event.sourceProvenance,
          'opportunity-id': event.opportunityId,
          'opportunity-kind': event.opportunityKind,
          'assignment-run': event.assignmentRunId,
          experiment: event.experimentId,
          'evidence-window-start': event.evidenceWindowStart,
          'evidence-window-end': event.evidenceWindowEnd,
          'evidence-state': event.evidenceState,
          'evidence-confidence': event.evidenceConfidence,
          'cost-grain': event.costGrain,
          'evidence-provenance': event.evidenceProvenance,
          'attributable-run-ids': event.attributableRunIds,
          'intervention-id': event.interventionId,
          'lifecycle-observation-id': event.lifecycleObservationId,
          'previous-intervention-state': event.previousInterventionState,
          'intervention-state': event.interventionState,
          'previous-recommendation-disposition': event.previousRecommendationDisposition,
          'recommendation-disposition': event.recommendationDisposition,
          'supersedes-intervention-id': event.supersedesInterventionId,
          'superseded-by-intervention-id': event.supersededByInterventionId,
          'recommendation-churn-count': event.recommendationChurnCount,
          'recommendation-churn-rate': event.recommendationChurnRate,
          'control-variant': event.controlVariant,
          'optimized-variant': event.optimizedVariant,
          'proposed-savings-aic': event.proposedSavingsAic,
          'missing-reason': event.missingReason,
          'safe-output-id': event.safeOutputId,
          'safe-output-url': event.safeOutputUrl,
          'implementation-change-id': event.implementationChangeId,
          'implementation-pull-request-url': event.implementationPullRequestUrl,
          'implementation-run-ids': event.implementationRunIds,
          'accepted-at': event.acceptedAt,
          'implementation-started-at': event.implementationStartedAt,
          'implementation-completed-at': event.implementationCompletedAt,
          'rejected-at': event.rejectedAt,
          'superseded-at': event.supersededAt
        })
      };
    }),
    metadata: projectionMetadata(sources, sourceName, sourceName, true)
  };
}

/**
 * Projects retained canonical MCP call events when no published MCP source is available.
 *
 * @param {Record<string, unknown>[]} events
 * @param {Map<unknown, Record<string, unknown>>} runsById
 * @param {Record<string, unknown>} sources
 */
function mcpCallsSource(events, runsById, sources) {
  const rows = events.flatMap((event) => {
    if (event.source !== 'mcp' || event.type !== 'tool.call') return [];
    const run = runsById.get(event.runId) ?? {};
    return [definedFields({
      organization: run.owner,
      repository: run.repository,
      workflow: run.workflowPath,
      run: run.githubRunId === undefined ? undefined : String(run.githubRunId),
      'mcp-observation': event.id,
      'mcp-server': event.mcpServer,
      'mcp-tool': event.mcpTool,
      'mcp-status': event.status,
      'observed-at': event.observedAt,
      'run-link': run.runLink
    })];
  });
  return {
    source: 'mcp-calls',
    rows,
    metadata: canonicalProjectionMetadata(sources, 'tools', 'mcp-calls', rows.length)
  };
}

/** @param {unknown} value */
function recordValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : {};
}

/**
 * @param {Record<string, unknown>[]} events
 * @param {Map<unknown, Record<string, unknown>>} runsById
 */
function graderRows(events, runsById) {
  return events.filter((event) => event.type === 'workflow_run_grader').map((event) => {
    const run = runsById.get(event.runId) ?? {};
    const implementation = recordValue(event.implementation);
    const observation = recordValue(event.observation);
    return {
      __event: event,
      organization: run.owner,
      repository: run.repository,
      workflow: run.workflowPath,
      run: String(run.githubRunId ?? ''),
      'run-attempt': run.attempt,
      grader: event.grader,
      'grader-name': event.graderName,
      'grader-source': event.graderSource,
      experiment: observation.experiment ?? event.experimentId,
      value: event.value,
      status: event.status ?? 'unavailable',
      included: Number.isFinite(event.value),
      'exclusion-reason': Number.isFinite(event.value) ? undefined : event.error ?? event.message,
      role: event.grader === 'operational-value' ? 'operational-value' : 'grader',
      direction: event.direction,
      unit: event.unit,
      'rollout-mode': run.rolloutMode,
      engine: run.engine,
      'engine-version': run.engineVersion,
      'requested-model': run.requestedModel ?? run.modelId,
      'resolved-model': run.resolvedModel ?? run.modelId,
      'maturity-status': Object.keys(observation).length === 0
        ? 'unavailable'
        : observation.mature === true ? 'matured' : 'interim',
      'baseline-value': event.baselineValue,
      'delta-from-baseline': event.deltaFromBaseline,
      'evaluator-digest': implementation.digest ?? '',
      'observed-at': observation.evidenceAt ?? event.timestamp,
      'run-link': run.runLink,
      'evidence-link': run.runLink
    };
  });
}

/** @param {Record<string, unknown>[]} graders @param {Record<string, unknown>} sources */
function graderObservationsSource(graders, sources) {
  return {
    source: 'grader-observations',
    rows: graders,
    metadata: canonicalProjectionMetadata(sources, 'audits', 'grader-observations', graders.length)
  };
}

/** @param {Record<string, unknown>[]} graders @param {Record<string, unknown>} sources */
function operationalValuesSource(graders, sources) {
  const rows = graders.flatMap((grader) => {
    if (grader.grader !== 'operational-value') return [];
    const event = recordValue(grader.__event);
    const metrics = Array.isArray(event.metrics)
      ? event.metrics.map(recordValue).filter((metric) => typeof metric.id === 'string')
      : [];
    const primaryMetric = metrics[0] ?? {};
    const metricDiagnostics = Object.fromEntries(metrics.slice(1).map((metric) => [metric.id, nativeMetricValue(metric.value)]));
    const observation = recordValue(event.observation);
    const implementation = recordValue(event.implementation);
    const subject = recordValue(observation.subject);
    const evidenceCase = recordValue(observation.case);
    const target = typeof evidenceCase.targetRepo === 'string'
      ? evidenceCase.targetRepo
      : typeof subject.repository === 'string' ? subject.repository : '';
    const [targetOwner, targetRepository] = target.split('/');
    return [definedFields({
      organization: targetRepository ? targetOwner : grader.organization,
      repository: targetRepository || grader.repository,
      'repository-name': targetRepository || grader.repository,
      workflow: grader.workflow,
      run: grader.run,
      'run-attempt': grader['run-attempt'],
      'observation-id': event.id,
      experiment: observation.experiment,
      'operational-case': observation.opportunityKey,
      'evaluator-digest': implementation.digest,
      'rollout-mode': grader['rollout-mode'],
      'operational-value': metrics.length > 0 ? nativeMetricValue(primaryMetric.value) : grader.value,
      'operational-value-definition': primaryMetric.id ?? grader.workflow ?? 'operational-value',
      'operational-value-unit': grader.unit,
      'operational-value-direction': grader.direction,
      'requested-evidence-at': subject.createdAt,
      'evidence-cutoff': observation.evidenceCutoff,
      'maturity-at': observation.maturesAt,
      'maturity-status': observation.mature === true ? 'matured'
        : observation.mature === false ? 'interim' : undefined,
      'accepted-evidence-provenance': observation.provenance,
      diagnostics: metrics.length > 1 ? metricDiagnostics : event.diagnostics,
      'diagnostic-definitions': metrics.slice(1).map((metric) => ({ id: metric.id, name: metric.id })),
      'observed-at': observation.evidenceAt ?? event.timestamp,
      'evidence-link': grader['evidence-link'],
      'run-link': grader['run-link']
    })];
  });
  return {
    source: 'operational-values',
    rows,
    metadata: canonicalProjectionMetadata(sources, 'audits', 'operational-values', rows.length)
  };
}

/** @param {unknown} value */
function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** @param {unknown} value */
function nativeMetricValue(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** @param {unknown} value */
function tokenSummary(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : {};
}

/** @param {Record<string, unknown>} summary @param {string[]} fields */
function firstFinite(summary, fields) {
  for (const field of fields) {
    const value = finiteNumber(summary[field]);
    if (value !== null) return value;
  }
  return null;
}

/** @param {Record<string, unknown>[]} runs @param {Record<string, unknown>} sources */
function usageSource(runs, sources) {
  const rows = runs.flatMap((run) => {
    const summary = tokenSummary(run.tokenUsage);
    const aic = finiteNumber(run.aicTotal ?? run.aic ?? summary.total_aic);
    if (aic === null && Object.keys(summary).length === 0) return [];
    return [definedFields({
      organization: run.owner,
      repository: run.repository,
      workflow: run.workflowPath,
      run: String(run.githubRunId ?? ''),
      invocation: run.id,
      engine: run.engine ?? 'unknown',
      'engine-version': run.engineVersion ?? 'unknown',
      'requested-model': run.requestedModel ?? run.modelId ?? 'unknown',
      'resolved-model': run.resolvedModel ?? run.modelId ?? 'unknown',
      'rollout-mode': run.rolloutMode ?? 'unknown',
      'input-tokens': firstFinite(summary, ['inputTokens', 'input_tokens', 'total_input_tokens']),
      'output-tokens': firstFinite(summary, ['outputTokens', 'output_tokens', 'total_output_tokens']),
      'cache-read-tokens': firstFinite(summary, ['cacheReadTokens', 'cache_read_tokens', 'total_cache_read_tokens']),
      'cache-write-tokens': firstFinite(summary, ['cacheWriteTokens', 'cache_write_tokens', 'total_cache_write_tokens']),
      'reasoning-tokens': firstFinite(summary, ['reasoningTokens', 'reasoning_tokens', 'total_reasoning_tokens']),
      aic,
      'estimated-usd': aic === null ? null : aic * 0.01,
      'observed-at': run.observedAt ?? run.completedAt ?? run.startedAt,
      'run-link': run.runLink
    })];
  });
  return {
    source: 'usage',
    rows,
    metadata: canonicalProjectionMetadata(sources, 'runs', 'usage', rows.length)
  };
}

/** @param {unknown} value */
function githubOutputCategory(value) {
  const normalized = String(value ?? '').toLowerCase().replaceAll('-', '_');
  if (normalized.includes('pull_request')) return 'pull-request';
  if (normalized.includes('issue')) return 'issue';
  if (normalized.includes('discussion')) return 'discussion';
  return normalized || 'unknown';
}

/** @param {unknown} value */
function httpsLink(value) {
  return typeof value === 'string' && value.startsWith('https://') ? value : undefined;
}

/** @param {unknown} value */
function linkNumber(value) {
  const match = String(value ?? '').match(/\/(?:issues|pull)\/(\d+)(?:\/|$)/);
  return match ? Number(match[1]) : null;
}

/**
 * @param {Record<string, unknown>[]} events
 * @param {Map<unknown, Record<string, unknown>>} runsById
 * @param {Map<unknown, Record<string, unknown>>} workflowsById
 * @param {Record<string, unknown>} sources
 */
function outcomesSource(events, runsById, workflowsById, sources) {
  const rows = events.flatMap((event) => {
    if (event.type !== 'safe_output.created') return [];
    const run = runsById.get(event.runId) ?? {};
    const workflow = workflowsById.get(run.workflowId) ?? {};
    const externalLink = httpsLink(event.correlationId) ?? httpsLink(run.runLink);
    const category = githubOutputCategory(event.githubEntityType ?? event.safeOutputType);
    const target = typeof run.targetRepository === 'string' && run.targetRepository.includes('/')
      ? run.targetRepository.split('/')
      : [run.owner, run.repository];
    return [definedFields({
      organization: target[0] ?? run.owner,
      repository: target[1] ?? run.repository,
      campaign: workflow.campaign,
      'runtime-repository': [run.owner, run.repository].filter(Boolean).join('/'),
      workflow: run.workflowPath ?? workflow.path,
      'workflow-name': workflow.name ?? run.workflowPath,
      run: String(run.githubRunId ?? ''),
      'run-conclusion': run.conclusion,
      'safe-output': event.id,
      'safe-output-kind': event.safeOutputType ?? category,
      'outcome-number': linkNumber(externalLink),
      'outcome-title': event.summary || `${category} output`,
      'outcome-summary': event.summary || '',
      'outcome-body-html': '',
      'outcome-category': category,
      'outcome-status': event.status ?? 'created',
      'outcome-state': 'pending',
      'outcome-warning': 'None',
      'evidence-strength': externalLink ? 'durable' : 'proposal',
      'rollout-mode': run.rolloutMode ?? workflow.rolloutMode,
      engine: run.engine,
      'engine-version': run.engineVersion,
      'requested-model': run.requestedModel ?? run.modelId,
      'resolved-model': run.resolvedModel ?? run.modelId,
      'published-at': event.timestamp,
      'observed-at': event.observedAt ?? event.timestamp,
      'issue-link': category === 'issue' ? externalLink : undefined,
      'pull-request-link': category === 'pull-request' ? externalLink : undefined,
      'run-link': run.runLink,
      'external-link': externalLink ?? run.runLink
    })];
  });
  return {
    source: 'outcomes',
    rows,
    metadata: canonicalProjectionMetadata(sources, 'issues', 'outcomes', rows.length)
  };
}

/**
 * @param {Record<string, unknown>[]} events
 * @param {Map<unknown, Record<string, unknown>>} runsById
 * @param {Record<string, unknown>} sources
 */
function findingsSource(events, runsById, sources) {
  const rows = events.flatMap((event) => {
    if (event.type !== 'audit.finding') return [];
    const run = runsById.get(event.runId) ?? {};
    return [definedFields({
      organization: run.owner,
      repository: run.repository,
      workflow: run.workflowPath,
      run: String(run.githubRunId ?? ''),
      'safe-output': event.id,
      finding: event.id,
      'finding-kind': 'audit-finding',
      'finding-severity': event.status ?? 'unknown',
      'finding-status': 'observed',
      'finding-summary': event.summary,
      'observed-at': event.observedAt ?? event.timestamp,
      engine: run.engine,
      'engine-version': run.engineVersion,
      'requested-model': run.requestedModel ?? run.modelId,
      'resolved-model': run.resolvedModel ?? run.modelId,
      'run-link': run.runLink,
      'external-link': run.runLink
    })];
  });
  return {
    source: 'findings',
    rows,
    metadata: canonicalProjectionMetadata(sources, 'audits', 'findings', rows.length)
  };
}

/** @param {Record<string, unknown>[]} findings @param {Record<string, unknown>} sources */
function securityFindingsSource(findings, sources) {
  const rows = findings
    .filter((finding) => (
      ['critical', 'high'].includes(String(finding['finding-severity']).toLowerCase())
      && /prompt|injection|secret|malicious|threat/i.test(String(finding['finding-summary'] ?? ''))
    ))
    .map((finding) => ({
      ...finding,
      'smell-observation-id': finding.finding,
      'smell-id': `audit-${String(finding.finding)}`,
      'smell-name': finding['finding-summary'] ?? 'Security finding',
      'smell-category': 'trust-and-security',
      'smell-severity': finding['finding-severity'],
      'smell-summary': finding['finding-summary'],
      'smell-evidence': finding['finding-summary']
    }));
  return {
    source: 'security-findings',
    rows,
    metadata: canonicalProjectionMetadata(sources, 'audits', 'security-findings', rows.length)
  };
}

/** @param {Record<string, unknown>[]} securityFindings @param {Record<string, unknown>} sources */
function detectionObservationsSource(securityFindings, sources) {
  const rows = securityFindings.map((finding) => ({
    organization: finding.organization,
    repository: finding.repository,
    workflow: finding.workflow,
    run: finding.run,
    'observed-at': finding['observed-at'],
    'run-link': finding['run-link'],
    'detection-expected': 'yes',
    'detection-applicable': 'yes',
    'detection-executed': 'yes',
    'verdict-available': 'yes',
    'detection-state': 'threat',
    'detection-state-label': 'Threat detected',
    'detection-count': 1,
    'detection-signal': finding['smell-summary'],
    'attention-priority': 'high'
  }));
  return {
    source: 'detection-observations',
    rows,
    metadata: canonicalProjectionMetadata(sources, 'audits', 'detection-observations', rows.length)
  };
}

/** @param {Record<string, unknown>[]} outcomes @param {Record<string, unknown>} sources */
function safeOutputPerformanceSource(outcomes, sources) {
  const rows = outcomes.map((outcome) => ({
    organization: outcome.organization,
    repository: outcome.repository,
    workflow: outcome.workflow,
    run: outcome.run,
    'run-conclusion': outcome['run-conclusion'],
    'rollout-mode': outcome['rollout-mode'],
    'safe-output-kind': outcome['safe-output-kind'],
    'safe-output-label': outcome['outcome-title'],
    'safe-output-status': outcome['outcome-status'],
    'safe-output-count': 1,
    'observed-at': outcome['observed-at'],
    'run-link': outcome['run-link']
  }));
  return {
    source: 'safe-output-performance',
    rows,
    metadata: canonicalProjectionMetadata(sources, 'issues', 'safe-output-performance', rows.length)
  };
}

/** @param {unknown} value */
function workItemKey(value) {
  return String(value ?? '').toLowerCase();
}

/**
 * @param {Record<string, unknown>[]} workflows
 * @param {Record<string, unknown>[]} runs
 * @param {Record<string, unknown>[]} outcomes
 * @param {Record<string, unknown>} sources
 */
function workItemsSource(workflows, runs, outcomes, sources) {
  const latestRuns = new Map();
  for (const run of runs) {
    const key = workItemKey(`${run.organization}/${run.repository}:${run.workflow}`);
    const current = latestRuns.get(key);
    if (!current || String(run['started-at'] ?? '').localeCompare(String(current['started-at'] ?? '')) > 0) {
      latestRuns.set(key, run);
    }
  }
  const latestOutcomes = new Map();
  for (const outcome of outcomes) {
    const runtimeRepository = outcome['runtime-repository'] || `${outcome.organization}/${outcome.repository}`;
    const key = workItemKey(`${runtimeRepository}:${outcome.workflow}`);
    const current = latestOutcomes.get(key);
    if (!current || String(outcome['observed-at'] ?? '').localeCompare(String(current['observed-at'] ?? '')) > 0) {
      latestOutcomes.set(key, outcome);
    }
  }
  const rows = workflows.map((workflow) => {
    const key = workItemKey(`${workflow.organization}/${workflow.repository}:${workflow.workflow}`);
    const run = latestRuns.get(key);
    const outcome = latestOutcomes.get(key);
    const lifecycle = ['failure', 'timed-out', 'startup-failure', 'action-required'].includes(run?.['run-conclusion'])
      ? 'blocked'
      : run?.['run-status'] === 'queued' ? 'waiting'
        : run?.['run-status'] === 'in-progress' ? 'active'
          : outcome ? 'review'
            : run ? 'completed' : 'unknown';
    return definedFields({
      'work-item-id': key,
      name: run ? `${workflow['workflow-name'] ?? workflow.workflow} · ${run['run-title'] ?? run.run}` : workflow['workflow-name'] ?? workflow.workflow,
      objective: workflow['workflow-name'] ?? workflow.workflow,
      organization: workflow.organization,
      repository: workflow.repository,
      workflow: workflow.workflow,
      run: run?.run ?? '',
      'workflow-name': workflow['workflow-name'] ?? workflow.workflow,
      'workflow-icon': workflow['campaign-icon'] ?? 'workflow',
      campaign: workflow.campaign ?? 'standalone',
      scope: `${workflow.organization}/${workflow.repository}`,
      domain: workflow['campaign-name'] ?? workflow.campaign ?? 'standalone',
      'work-type': workflow['workflow-role'] ?? 'unknown',
      'lifecycle-state': lifecycle,
      phase: run?.['run-status'] ?? 'unknown',
      reason: run?.['failure-detail'] ?? (lifecycle === 'review' ? 'Produced outcome awaits review or user consent' : 'No blocking condition observed'),
      'next-action': lifecycle === 'blocked' ? 'Resolve the run failure blocking this work'
        : lifecycle === 'waiting' ? 'Await the next scheduled run'
          : lifecycle === 'active' ? 'Monitor the in-progress run'
            : lifecycle === 'review' ? 'Review the produced outcome' : 'Review the latest run evidence',
      'next-actor': lifecycle === 'active' ? 'agent' : lifecycle === 'waiting' ? 'scheduler' : 'maintainer',
      'safe-output-kind': outcome?.['safe-output-kind'] ?? 'workflow-output',
      'waiting-on': lifecycle === 'review' ? 'reviewer decision' : '',
      'waiting-since': run?.['started-at'] ?? outcome?.['observed-at'] ?? '',
      owner: workflow['campaign-name'] ?? workflow.organization,
      'consequence-tier': workflow['workflow-role'] === 'orchestrator' ? 'high'
        : workflow['workflow-role'] === 'worker' ? 'medium' : 'low',
      'verification-state': outcome ? 'pending' : 'unverified',
      'outcome-state': outcome?.['outcome-state'] ?? 'pending',
      'started-at': run?.['started-at'] ?? '',
      'ended-at': run?.['ended-at'] ?? '',
      'observed-at': run?.['started-at'] ?? workflow['observed-at'],
      'evidence-link': outcome?.['external-link'] ?? run?.['run-link'],
      'run-link': run?.['run-link']
    });
  });
  return {
    source: 'work-items',
    rows,
    metadata: canonicalProjectionMetadata(sources, 'workflows', 'work-items', rows.length)
  };
}

/** @param {Record<string, unknown>[]} graders @param {Record<string, unknown>} sources */
function gradersSource(graders, sources) {
  const rows = [...new Map(graders.map((grader) => [String(grader.grader), definedFields({
    grader: grader.grader,
    'grader-name': grader['grader-name'] ?? grader.grader,
    role: grader.role,
    direction: grader.direction,
    unit: grader.unit,
    'observed-at': grader['observed-at']
  })])).values()];
  return {
    source: 'graders',
    rows,
    metadata: canonicalProjectionMetadata(sources, 'audits', 'graders', rows.length)
  };
}

/** @param {Record<string, unknown>[]} graders @param {Record<string, unknown>} sources */
function experimentsSource(graders, sources) {
  const rows = [...new Map(graders.flatMap((grader) => {
    if (!grader.experiment) return [];
    return [[String(grader.experiment), definedFields({
      organization: grader.organization,
      repository: grader.repository,
      workflow: grader.workflow,
      experiment: grader.experiment,
      'experiment-name': grader.experiment,
      state: 'observed',
      readiness: 'observed',
      decision: 'pending',
      'last-observation': grader.value,
      'observed-at': grader['observed-at']
    })]];
  })).values()];
  return {
    source: 'experiments',
    rows,
    metadata: canonicalProjectionMetadata(sources, 'audits', 'experiments', rows.length)
  };
}

/** @param {Record<string, unknown>[]} graders @param {Record<string, unknown>} sources */
function evalSources(graders, sources) {
  const observations = graders.filter((grader) => (
    String(grader['grader-source'] ?? '').toLowerCase() === 'eval'
    || String(grader.grader ?? '').toLowerCase().startsWith('eval')
  )).map((grader) => definedFields({
    organization: grader.organization,
    repository: grader.repository,
    workflow: grader.workflow,
    run: grader.run,
    experiment: grader.experiment,
    eval: grader.grader,
    'eval-result': grader.value,
    status: grader.status,
    included: grader.included,
    'exclusion-reason': grader['exclusion-reason'],
    role: 'eval',
    direction: grader.direction,
    'requested-model': grader['requested-model'],
    'resolved-model': grader['resolved-model'],
    'rollout-mode': grader['rollout-mode'],
    'observed-at': grader['observed-at'],
    'evidence-link': grader['evidence-link']
  }));
  const definitions = [...new Map(observations.map((observation) => [String(observation.eval), definedFields({
    eval: observation.eval,
    'eval-name': observation.eval,
    'eval-question': observation.eval,
    role: 'eval',
    direction: observation.direction,
    'observed-at': observation['observed-at']
  })])).values()];
  return {
    evals: {
      source: 'evals',
      rows: definitions,
      metadata: canonicalProjectionMetadata(sources, 'audits', 'evals', definitions.length)
    },
    observations: {
      source: 'eval-observations',
      rows: observations,
      metadata: canonicalProjectionMetadata(sources, 'audits', 'eval-observations', observations.length)
    }
  };
}

/**
 * @param {Record<string, unknown>[]} events
 * @param {Map<unknown, Record<string, unknown>>} runsById
 * @param {Record<string, unknown>} sources
 */
function firewallObservationsSource(events, runsById, sources) {
  const published = sourceRows(sources['firewall-observations']);
  if (published.length > 0) {
    return {
      source: 'firewall-observations',
      rows: published,
      metadata: projectionMetadata(sources, 'firewall-observations', 'firewall-observations', true)
    };
  }
  const rows = events.flatMap((event) => {
    if (event.source !== 'firewall'
        || !['net_allowed', 'net_blocked'].includes(String(event.type))
        || typeof event.domain !== 'string'
        || !event.domain) return [];
    const run = runsById.get(event.runId) ?? {};
    return [{
      organization: run.owner,
      repository: run.repository,
      workflow: run.workflowPath,
      run: String(run.githubRunId ?? ''),
      'run-attempt': run.attempt,
      'agent-id': run.agentId,
      'agent-version': run.agentVersion,
      engine: run.engine ?? run.agentId,
      'engine-version': run.engineVersion ?? run.agentVersion,
      'requested-model': run.requestedModel ?? run.modelId,
      'resolved-model': run.resolvedModel ?? run.modelId ?? run.requestedModel,
      'agent-runtime': run.agentRuntime,
      'firewall-observation': event.id,
      'observed-at': event.timestamp,
      domain: event.domain,
      decision: event.decision ?? (event.type === 'net_blocked' ? 'denied' : 'allowed'),
      'request-count': event.requestCount ?? 1
    }];
  });
  return {
    source: 'firewall-observations',
    rows,
    metadata: canonicalProjectionMetadata(sources, 'domains', 'firewall-observations', rows.length)
  };
}

/** @param {unknown} source */
function sourceRows(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return [];
  const rows = /** @type {{ rows?: unknown }} */ (source).rows;
  return Array.isArray(rows)
    ? rows.filter((row) => row && typeof row === 'object' && !Array.isArray(row))
      .map((row) => /** @type {Record<string, unknown>} */ (row))
    : [];
}

/** @param {Record<string, unknown>} sources */
function namedLogicalSources(sources) {
  return Object.fromEntries(Object.entries(sources).map(([sourceName, value]) => [
    sourceName,
    value && typeof value === 'object' && !Array.isArray(value)
      ? { source: sourceName, ...value }
      : value
  ]));
}

/** @param {Record<string, unknown>} sources */
function sourceMetadataSource(sources) {
  const rows = Object.entries(sources)
    .filter(([, value]) => value && typeof value === 'object' && !Array.isArray(value))
    .map(([sourceName, value]) => {
      const source = /** @type {{ rows?: unknown[], metadata?: Record<string, unknown> }} */ (value);
      const metadata = source.metadata ?? {};
      return {
        source: sourceName,
        'row-count': Array.isArray(source.rows) ? source.rows.length : 0,
        'source-id': metadata['source-id'] ?? sourceName,
        'source-kind': metadata['source-kind'] ?? 'unknown',
        'as-of': metadata['as-of'] ?? '',
        'retrieved-at': metadata['retrieved-at'] ?? '',
        availability: metadata.availability ?? 'unknown',
        completeness: metadata.completeness ?? 'unknown',
        freshness: metadata.freshness ?? 'unknown',
        'collection-operation': metadata['collection-operation'] ?? sourceName,
        'collection-state': metadata['collection-state'] ?? '',
        'collection-progress': metadata['collection-progress'] ?? '',
        'collection-reason': metadata['collection-reason'] ?? '',
        'failure-class': metadata['failure-class'] ?? '',
        'collector-completed-at': metadata['collector-completed-at'] ?? '',
        'coverage-start': metadata['coverage-start'] ?? '',
        'coverage-end': metadata['coverage-end'] ?? '',
        'requested-coverage-start': metadata['requested-coverage-start'] ?? '',
        'requested-coverage-end': metadata['requested-coverage-end'] ?? '',
        'coverage-expected': metadata['coverage-expected'] ?? null,
        'coverage-observed': metadata['coverage-observed'] ?? null,
        'snapshot-age-seconds': metadata['snapshot-age-seconds'] ?? null,
        'fallback-used': metadata['fallback-used'] === true
      };
    })
    .sort((left, right) => left.source.localeCompare(right.source));
  const latestRetrievedAt = rows
    .map((row) => String(row['retrieved-at']))
    .filter(Boolean)
    .sort()
    .at(-1) ?? '';
  return {
    source: 'source-metadata',
    rows,
    metadata: /** @type {import('../../presenter.js').SourceMetadata} */ ({
      'source-id': 'source-metadata',
      'source-kind': 'canonical-projection',
      'as-of': latestRetrievedAt,
      'retrieved-at': latestRetrievedAt,
      availability: rows.length > 0 ? 'available' : 'empty',
      completeness: 'complete',
      freshness: rows.some((row) => row.freshness === 'stale') ? 'stale' : 'fresh'
    })
  };
}

/**
 * @param {IDBFactory} indexedDB
 * @param {Record<string, unknown>} sources
 * @param {{ ingest?: boolean, storage?: StorageManager }} [options]
 */
export async function loadCanonicalViewSources(indexedDB, sources, options = {}) {
  if (options.ingest) {
    await ingestDashboardSources(indexedDB, sources, { storage: options.storage });
  }
  return projectCanonicalViewSources(indexedDB, sources);
}

/**
 * Projects freshly downloaded logical sources through one active canonical
 * database. Source-shaped rows remain transient and are never cached in IndexedDB.
 *
 * @param {IDBFactory} indexedDB
 * @param {Record<string, unknown>} logicalSources
 */
export async function projectCanonicalViewSources(indexedDB, logicalSources) {
  return {
    ...namedLogicalSources(logicalSources),
    ...await queryCanonicalViewSources(indexedDB, logicalSources, [
      'repositories',
      'campaigns',
      'workflows',
      'runs',
      'job-performance',
      'failed-runs',
      'domains',
      'tools',
      'audits',
      'issues',
      'transactions',
      'firewall-observations'
    ])
  };
}

/**
 * Executes only the canonical queries required by the requested view sources.
 *
 * @param {IDBFactory} indexedDB
 * @param {Record<string, unknown>} logicalSources
 * @param {string[]} sourceNames
 * @param {{ onMetrics?: (metrics: { databaseMs: number, projectionMs: number, totalMs: number, recordsRead: number, stores: string[] }) => void }} [options]
 */
export async function queryCanonicalViewSources(indexedDB, logicalSources, sourceNames, options = {}) {
  const startedAt = monotonicNow();
  if (!Array.isArray(sourceNames) || sourceNames.some((name) => typeof name !== 'string')) {
    throw new TypeError('Canonical view source names must be an array of strings.');
  }
  const requested = new Set(sourceNames);
  const projectedNames = new Set(requested);
  const healthRequested = requested.has('data-health-collections') || requested.has('data-health-coverage');
  if (healthRequested) {
    for (const sourceName of [
      'repositories',
      'workflows',
      'runs',
      'usage',
      'detection-observations',
      'firewall-observations',
      'safe-output-performance',
      'outcomes'
    ]) projectedNames.add(sourceName);
  }
  const needed = new Set(projectedNames);
  if (needed.has('work-items')) {
    needed.add('workflows');
    needed.add('runs');
    needed.add('outcomes');
  }
  if (needed.has('safe-output-performance')) needed.add('outcomes');
  if (needed.has('security-findings') || needed.has('detection-observations')) needed.add('findings');
  const queries = createCanonicalQueries(indexedDB);
  const needsFirewall = needed.has('firewall-observations')
    && sourceRows(logicalSources['firewall-observations']).length === 0;
  const needsGraders = [
    'grader-observations',
    'operational-values',
    'graders',
    'experiments',
    'evals',
    'eval-observations'
  ].some((name) => needed.has(name));
  const needsMcpCalls = needed.has('mcp-calls') && !sourceRows(logicalSources['mcp-calls']).length;
  const needsDerivedFindings = needed.has('findings')
    || (['security-findings', 'detection-observations'].some((name) => needed.has(name))
      && sourceRows(logicalSources['security-findings']).length === 0);
  const needsFindingRecords = needsDerivedFindings && sourceRows(logicalSources.findings).length === 0;
  const needsOutcomeRecords = needed.has('outcomes') && sourceRows(logicalSources.outcomes).length === 0;
  const needsDomains = needed.has('domains') || needsFirewall;
  const needsTools = needed.has('tools') || needsMcpCalls;
  const needsAudits = needed.has('audits') || needsGraders || needsFindingRecords || needsOutcomeRecords;
  const needsIssues = needed.has('issues') || needsOutcomeRecords;
  const needsRunLinkedRecords = needsDomains || needsTools || needsAudits || needsIssues;
  const needsRuns = needed.has('runs') || needed.has('usage') || needsRunLinkedRecords;
  const needsWorkflows = needed.has('workflows') || needsRuns || needed.has('outcomes') || needed.has('work-items');
  const needsRepositories = needed.has('repositories') || needsWorkflows;
  const stores = /** @type {const} */ ([
    ['campaigns', needed.has('campaigns')],
    ['repositories', needsRepositories],
    ['workflows', needsWorkflows],
    ['runs', needsRuns],
    ['domains', needsDomains],
    ['tools', needsTools],
    ['audits', needsAudits],
    ['issues', needsIssues]
  ]);
  const selectedStores = stores.filter(([, selected]) => selected).map(([storeName]) => storeName);
  const databaseStartedAt = monotonicNow();
  const [collections, failedRuns, transactions] = await Promise.all([
    readCollections(indexedDB, selectedStores),
    needed.has('failed-runs') ? queries.runs.recentFailures() : [],
    needed.has('transactions') ? queries.transactions.list() : []
  ]);
  const databaseMs = monotonicNow() - databaseStartedAt;
  const campaigns = collections.campaigns ?? [];
  const repositories = collections.repositories ?? [];
  const workflows = collections.workflows ?? [];
  const runs = collections.runs ?? [];
  const domains = collections.domains ?? [];
  const tools = collections.tools ?? [];
  const audits = collections.audits ?? [];
  const issues = collections.issues ?? [];
  const repositoriesById = new Map(repositories.map((repository) => [repository.id, repository]));
  const workflowsById = new Map(workflows.map((workflow) => [workflow.id, workflow]));
  const runsById = new Map(runs.map((run) => [run.id, run]));
  const graders = needsGraders ? graderRows(audits, runsById) : [];
  const sources = namedLogicalSources(logicalSources);
  const projectedWorkflows = workflowsSource(workflows, repositoriesById, sources).rows;
  const projectedRuns = runsSource(runs, workflowsById, sources).rows;
  const publishedOutcomes = sourceRows(sources.outcomes);
  const outcomes = needed.has('outcomes')
    ? publishedOutcomes.length > 0
      ? /** @type {import('../../presenter.js').LogicalSourceInput} */ (sources.outcomes)
      : outcomesSource(
          [...issues, ...audits.filter((record) => record.type === 'safe_output.created')],
          runsById,
          workflowsById,
          sources
        )
    : null;
  const publishedFindings = sourceRows(sources.findings);
  const findings = needed.has('findings')
    ? publishedFindings.length > 0
      ? /** @type {import('../../presenter.js').LogicalSourceInput} */ (sources.findings)
      : findingsSource(audits, runsById, sources)
    : null;
  const publishedSecurityFindings = sourceRows(sources['security-findings']);
  const securityFindings = needed.has('security-findings') || needed.has('detection-observations')
    ? publishedSecurityFindings.length > 0
      ? /** @type {import('../../presenter.js').LogicalSourceInput} */ (sources['security-findings'])
      : securityFindingsSource(sourceRows(findings), sources)
    : null;
  const evalTelemetry = needed.has('evals') || needed.has('eval-observations')
    ? evalSources(graders, sources)
    : null;
  /** @type {Record<string, import('../../presenter.js').LogicalSourceInput>} */
  const projected = {};
  for (const sourceName of projectedNames) {
    const source = /** @type {import('../../presenter.js').LogicalSourceInput | undefined} */ (sources[sourceName]);
    if (source) projected[sourceName] = source;
  }
  if (projectedNames.has('source-metadata')) projected['source-metadata'] = sourceMetadataSource(logicalSources);
  if (projectedNames.has('campaigns')) projected.campaigns = campaignsSource(campaigns, sources);
  if (projectedNames.has('repositories')) projected.repositories = repositoriesSource(repositories, sources);
  if (projectedNames.has('workflows')) {
    projected.workflows = {
      source: 'workflows',
      rows: projectedWorkflows,
      metadata: canonicalProjectionMetadata(sources, 'workflows', 'workflows', projectedWorkflows.length)
    };
  }
  if (projectedNames.has('runs')) {
    projected.runs = {
      source: 'runs',
      rows: projectedRuns,
      metadata: canonicalProjectionMetadata(sources, 'runs', 'runs', projectedRuns.length)
    };
  }
  if (projectedNames.has('failed-runs')) projected['failed-runs'] = failedRunsSource(failedRuns, sources);
  for (const [sourceName, records] of Object.entries({ domains, tools, audits, issues })) {
    if (projectedNames.has(sourceName)) {
      projected[sourceName] = recordsSource(sourceName, records, runsById, sources);
    }
  }
  if (needsMcpCalls) projected['mcp-calls'] = mcpCallsSource(tools, runsById, sources);
  if (projectedNames.has('usage') && sourceRows(sources.usage).length === 0) {
    projected.usage = usageSource(runs, sources);
  }
  if (projectedNames.has('outcomes') && outcomes) projected.outcomes = outcomes;
  if (projectedNames.has('findings') && findings) projected.findings = findings;
  if (projectedNames.has('security-findings') && securityFindings) {
    projected['security-findings'] = securityFindings;
  }
  if (projectedNames.has('detection-observations')
      && sourceRows(sources['detection-observations']).length === 0
      && securityFindings) {
    projected['detection-observations'] = detectionObservationsSource(
      sourceRows(securityFindings),
      sources
    );
  }
  if (projectedNames.has('safe-output-performance')
      && sourceRows(sources['safe-output-performance']).length === 0
      && outcomes) {
    projected['safe-output-performance'] = safeOutputPerformanceSource(sourceRows(outcomes), sources);
  }
  if (projectedNames.has('work-items')
      && sourceRows(sources['work-items']).length === 0
      && outcomes) {
    projected['work-items'] = workItemsSource(projectedWorkflows, projectedRuns, sourceRows(outcomes), sources);
  }
  if (projectedNames.has('admissions') && sourceRows(sources.admissions).length === 0) {
    projected.admissions = emptyCanonicalSource(
      'admissions',
      sources,
      'Structured admission artifacts are not present in the canonical activity snapshot.'
    );
  }
  if (projectedNames.has('grader-observations')) {
    projected['grader-observations'] = graderObservationsSource(
      graders.map(({ __event, ...grader }) => grader),
      sources
    );
  }
  if (projectedNames.has('operational-values')) projected['operational-values'] = operationalValuesSource(graders, sources);
  if (projectedNames.has('graders') && sourceRows(sources.graders).length === 0) {
    projected.graders = gradersSource(graders, sources);
  }
  if (projectedNames.has('experiments') && sourceRows(sources.experiments).length === 0) {
    projected.experiments = experimentsSource(graders, sources);
  }
  if (projectedNames.has('evals') && sourceRows(sources.evals).length === 0 && evalTelemetry) {
    projected.evals = evalTelemetry.evals;
  }
  if (projectedNames.has('eval-observations')
      && sourceRows(sources['eval-observations']).length === 0
      && evalTelemetry) {
    projected['eval-observations'] = evalTelemetry.observations;
  }
  if (projectedNames.has('transactions')) {
    projected.transactions = {
      source: 'transactions',
      rows: transactions,
      metadata: projectionMetadata(sources, 'transactions', 'transactions', true)
    };
  }
  if (needsFirewall) {
    projected['firewall-observations'] = firewallObservationsSource(domains, runsById, sources);
  }
  const totalMs = monotonicNow() - startedAt;
  options.onMetrics?.({
    databaseMs,
    projectionMs: Math.max(0, totalMs - databaseMs),
    totalMs,
    recordsRead: Object.values(collections).reduce((total, records) => total + records.length, 0)
      + failedRuns.length
      + transactions.length,
    stores: selectedStores
  });
  return projected;
}