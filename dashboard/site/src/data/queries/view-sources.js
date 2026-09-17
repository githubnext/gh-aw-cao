import { ingestDashboardSources } from '../ingest/coordinator.js';
import { workflowSourcePath } from '../model/ids.js';
import { createCanonicalQueries } from './index.js';

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

/** @param {Record<string, unknown>[]} packages @param {Record<string, unknown>} sources */
function packagesSource(packages, sources) {
  return {
    source: 'packages',
    rows: packages.map((packageRecord) => ({
      package: packageRecord.slug,
      'package-name': packageRecord.name,
      'package-description': packageRecord.description,
      'package-icon': packageRecord.icon,
      'package-mode': packageRecord.mode,
      'package-enabled': packageRecord.enabled,
      'package-registration': packageRecord.enabled ? 'true' : 'false',
      'package-max-repositories': packageRecord.maxRepositories,
      'package-rollout-percent': packageRecord.rolloutPercent,
      'package-monthly-ai-credit-budget': packageRecord.monthlyAiCreditBudget,
      'package-aic-allowance': packageRecord.aiCreditAllowance,
      'package-worker-count': packageRecord.workerCount,
      'package-inventory-warnings': packageRecord.inventoryWarnings,
      'package-workers': packageRecord.workers,
      'package-targets': packageRecord.targets,
      'package-min-version': packageRecord.minVersion,
      'package-version': packageRecord.version,
      'package-current-version': packageRecord.currentVersion,
      'package-update-state': packageRecord.updateState,
      'package-experimental': packageRecord.experimental,
      'package-readme-path': packageRecord.readmePath,
      'package-readme': packageRecord.readme,
      'observed-at': packageRecord.observedAt,
      ...(packageRecord.packageLink ? { 'package-link': packageRecord.packageLink } : {})
    })),
    metadata: projectionMetadata(sources, 'packages', 'packages', true)
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
        package: workflow.package,
        'package-name': workflow.packageName,
        'package-icon': workflow.packageIcon,
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

/**
 * @param {Record<string, unknown>[]} jobs
 * @param {Map<unknown, Record<string, unknown>>} runsById
 * @param {Record<string, unknown>} sources
 */
function jobsSource(jobs, runsById, sources) {
  const publishedJobs = new Map(sourceRows(sources['job-performance']).map((job) => [
    [job.organization, job.repository, job.run, job['run-attempt'] ?? 1, job['job-id']].map(normalizedKey).join(':'),
    job
  ]));
  return {
    source: 'job-performance',
    rows: jobs.map((job) => {
      const run = runsById.get(job.runId) ?? {};
      return {
        ...(publishedJobs.get([
          run.owner,
          run.repository,
          run.githubRunId,
          run.attempt ?? 1,
          job.githubJobId
        ].map(normalizedKey).join(':')) ?? {}),
        organization: run.owner,
        repository: run.repository,
        workflow: run.workflowPath,
        run: String(run.githubRunId ?? ''),
        'run-attempt': run.attempt,
        'run-conclusion': job.runConclusion,
        'rollout-mode': job.rolloutMode,
        'job-id': job.githubJobId,
        job: job.name,
        'job-status': job.status,
        'job-conclusion': job.conclusion,
        'job-duration-seconds': job.durationSeconds,
        'started-at': job.startedAt,
        runner: job.runner,
        'runner-name': job.runnerName,
        'runner-group': job.runnerGroup,
        'sandbox-runtime': job.sandboxRuntime,
        engine: job.engine,
        model: job.model,
        'run-link': job.runLink
      };
    }),
    metadata: projectionMetadata(sources, 'job-performance', 'job-performance', true)
  };
}

/** @param {Record<string, unknown>} record */
function definedFields(record) {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

/**
 * Projects retained canonical events with their session, run, and repository
 * context so event-backed views survive partial collections.
 *
 * @param {Record<string, unknown>[]} events
 * @param {Map<unknown, Record<string, unknown>>} sessionsById
 * @param {Map<unknown, Record<string, unknown>>} runsById
 * @param {Record<string, unknown>} sources
 */
function eventsSource(events, sessionsById, runsById, sources) {
  const publishedEvents = new Map(sourceRows(sources.events).map((event) => [
    normalizedKey(event.event),
    event
  ]));
  const ordered = [...events].sort((left, right) =>
    String(left.sessionId).localeCompare(String(right.sessionId))
    || Number(left.sequence) - Number(right.sequence));
  return {
    source: 'events',
    rows: ordered.map((event) => {
      const session = sessionsById.get(event.sessionId) ?? {};
      const run = runsById.get(session.runId) ?? {};
      return {
        ...(publishedEvents.get(normalizedKey(event.id)) ?? {}),
        ...definedFields({
          organization: run.owner,
          repository: run.repository,
          workflow: run.workflowPath,
          run: run.githubRunId === undefined ? undefined : String(run.githubRunId),
          'run-attempt': run.attempt,
          session: event.sessionId,
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
    metadata: projectionMetadata(sources, 'events', 'events', true)
  };
}

/**
 * Projects retained canonical MCP call events when no published MCP source is available.
 *
 * @param {Record<string, unknown>[]} events
 * @param {Map<unknown, Record<string, unknown>>} sessionsById
 * @param {Map<unknown, Record<string, unknown>>} runsById
 * @param {Record<string, unknown>} sources
 */
function mcpCallsSource(events, sessionsById, runsById, sources) {
  return {
    source: 'mcp-calls',
    rows: events.flatMap((event) => {
      if (event.source !== 'mcp' || event.type !== 'tool.call') return [];
      const session = sessionsById.get(event.sessionId) ?? {};
      const run = runsById.get(session.runId) ?? {};
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
    }),
    metadata: projectionMetadata(sources, 'mcp-calls', 'events', true)
  };
}

/**
 * Projects canonical sessions with their run and repository context so
 * ingestion-rate queries (imported runs per workflow/repository) can group
 * sessions by organization, repository, workflow, and run.
 *
 * @param {Record<string, unknown>[]} sessions
 * @param {Map<unknown, Record<string, unknown>>} runsById
 * @param {Record<string, unknown>} sources
 */
function sessionsSource(sessions, runsById, sources) {
  const rows = sessions.map((session) => {
    const run = runsById.get(session.runId) ?? {};
    return definedFields({
      organization: run.owner,
      repository: run.repository,
      workflow: run.workflowPath,
      run: run.githubRunId === undefined ? undefined : String(run.githubRunId),
      'run-attempt': run.attempt,
      session: session.id,
      'job-id': session.jobId,
      'session-kind': session.kind,
      'session-status': session.status,
      'started-at': session.startedAt,
      'ended-at': session.completedAt,
      'observed-at': session.startedAt
    });
  });
  return {
    source: 'sessions',
    rows,
    metadata: projectionMetadata(sources, 'sessions', 'sessions', rows.length > 0)
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
 * @param {Map<unknown, Record<string, unknown>>} sessionsById
 * @param {Map<unknown, Record<string, unknown>>} runsById
 */
function graderRows(events, sessionsById, runsById) {
  return events.filter((event) => event.type === 'workflow_run_grader').map((event) => {
    const session = sessionsById.get(event.sessionId) ?? {};
    const run = runsById.get(session.runId) ?? {};
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
      value: event.value,
      status: event.status ?? 'unavailable',
      included: Number.isFinite(event.value),
      'exclusion-reason': Number.isFinite(event.value) ? undefined : event.error ?? event.message,
      role: event.grader === 'operational-value' ? 'operational-value' : 'grader',
      direction: event.direction,
      unit: event.unit,
      'rollout-mode': run.rolloutMode,
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
    metadata: projectionMetadata(sources, 'events', 'grader-observations', graders.length > 0)
  };
}

/** @param {Record<string, unknown>[]} graders @param {Record<string, unknown>} sources */
function operationalValuesSource(graders, sources) {
  const rows = graders.flatMap((grader) => {
    if (grader.grader !== 'operational-value') return [];
    const event = recordValue(grader.__event);
    const observation = recordValue(event.observation);
    if (!Number.isFinite(grader.value) && Object.keys(observation).length === 0) return [];
    const implementation = recordValue(event.implementation);
    const subject = recordValue(observation.subject);
    const evidenceCase = recordValue(observation.case);
    const target = typeof evidenceCase.targetRepo === 'string'
      ? evidenceCase.targetRepo
      : typeof subject.repository === 'string' ? subject.repository : '';
    const [targetOwner, targetRepository] = target.split('/');
    return [{
      organization: targetRepository ? targetOwner : grader.organization,
      repository: targetRepository || grader.repository,
      'repository-name': targetRepository || grader.repository,
      workflow: grader.workflow,
      run: grader.run,
      'run-attempt': grader['run-attempt'],
      'observation-id': event.id,
      experiment: observation.experiment ?? '',
      'operational-case': observation.opportunityKey ?? `run:${String(grader.run)}`,
      'evaluator-digest': implementation.digest ?? '',
      'rollout-mode': grader['rollout-mode'],
      'operational-value': grader.value,
      'operational-value-definition': grader.workflow ?? 'operational-value',
      'requested-evidence-at': subject.createdAt ?? observation.evidenceAt ?? event.timestamp,
      'evidence-cutoff': observation.evidenceCutoff ?? observation.evidenceAt ?? event.timestamp,
      'maturity-at': observation.maturesAt ?? observation.evidenceAt ?? event.timestamp,
      'maturity-status': Object.keys(observation).length === 0
        ? 'observed'
        : observation.mature === true ? 'matured' : 'interim',
      'baseline-value': grader['baseline-value'],
      'delta-from-baseline': grader['delta-from-baseline'],
      'accepted-evidence-provenance': observation.provenance ?? [],
      diagnostics: event.diagnostics ?? {},
      'observed-at': observation.evidenceAt ?? event.timestamp,
      'evidence-link': grader['evidence-link'],
      'run-link': grader['run-link']
    }];
  });
  return {
    source: 'operational-values',
    rows,
    metadata: projectionMetadata(sources, 'events', 'operational-values', graders.length > 0)
  };
}

/**
 * @param {Record<string, unknown>[]} events
 * @param {Map<unknown, Record<string, unknown>>} sessionsById
 * @param {Map<unknown, Record<string, unknown>>} runsById
 * @param {Record<string, unknown>} sources
 */
function firewallObservationsSource(events, sessionsById, runsById, sources) {
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
    const session = sessionsById.get(event.sessionId) ?? {};
    const run = runsById.get(session.runId) ?? {};
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
    metadata: projectionMetadata(sources, 'firewall-observations', 'firewall-observations', rows.length > 0)
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
      'packages',
      'workflows',
      'runs',
      'job-performance',
      'failed-runs',
      'events',
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
 */
export async function queryCanonicalViewSources(indexedDB, logicalSources, sourceNames) {
  if (!Array.isArray(sourceNames) || sourceNames.some((name) => typeof name !== 'string')) {
    throw new TypeError('Canonical view source names must be an array of strings.');
  }
  const requested = new Set(sourceNames);
  const queries = createCanonicalQueries(indexedDB);
  const needsFirewall = requested.has('firewall-observations');
  const needsGraders = requested.has('grader-observations') || requested.has('operational-values');
  const needsMcpCalls = requested.has('mcp-calls') && !sourceRows(logicalSources['mcp-calls']).length;
  const needsSessions = requested.has('sessions') || needsFirewall || needsGraders || needsMcpCalls;
  const needsEvents = requested.has('events') || needsFirewall || needsGraders || needsMcpCalls;
  const [packages, repositories, workflows, runs, jobs, failedRuns, sessions, events, transactions] = await Promise.all([
    requested.has('packages') ? queries.packages.list() : [],
    requested.has('repositories') || requested.has('workflows') ? queries.repositories.list() : [],
    requested.has('workflows') || requested.has('runs') ? queries.workflows.list() : [],
    requested.has('runs') || requested.has('job-performance') || needsSessions || needsEvents
      ? queries.runs.list() : [],
    requested.has('job-performance') ? queries.jobs.list() : [],
    requested.has('failed-runs') ? queries.runs.recentFailures() : [],
    needsSessions || needsEvents ? queries.sessions.list() : [],
    needsEvents ? queries.events.list() : [],
    requested.has('transactions') ? queries.transactions.list() : []
  ]);
  const repositoriesById = new Map(repositories.map((repository) => [repository.id, repository]));
  const workflowsById = new Map(workflows.map((workflow) => [workflow.id, workflow]));
  const runsById = new Map(runs.map((run) => [run.id, run]));
  const sessionsById = new Map(sessions.map((session) => [session.id, session]));
  const graders = needsGraders ? graderRows(events, sessionsById, runsById) : [];
  const sources = namedLogicalSources(logicalSources);
  /** @type {Record<string, import('../../presenter.js').LogicalSourceInput>} */
  const projected = {};
  for (const sourceName of requested) {
    const source = /** @type {import('../../presenter.js').LogicalSourceInput | undefined} */ (sources[sourceName]);
    if (source) projected[sourceName] = source;
  }
  if (requested.has('source-metadata')) projected['source-metadata'] = sourceMetadataSource(logicalSources);
  if (requested.has('packages')) projected.packages = packagesSource(packages, sources);
  if (requested.has('repositories')) projected.repositories = repositoriesSource(repositories, sources);
  if (requested.has('workflows')) projected.workflows = workflowsSource(workflows, repositoriesById, sources);
  if (requested.has('job-performance')) projected['job-performance'] = jobsSource(jobs, runsById, sources);
  if (requested.has('runs')) projected.runs = runsSource(runs, workflowsById, sources);
  if (requested.has('failed-runs')) projected['failed-runs'] = failedRunsSource(failedRuns, sources);
  if (requested.has('sessions')) projected.sessions = sessionsSource(sessions, runsById, sources);
  if (requested.has('events')) projected.events = eventsSource(events, sessionsById, runsById, sources);
  if (needsMcpCalls) projected['mcp-calls'] = mcpCallsSource(events, sessionsById, runsById, sources);
  if (requested.has('grader-observations')) {
    projected['grader-observations'] = graderObservationsSource(
      graders.map(({ __event, ...grader }) => grader),
      sources
    );
  }
  if (requested.has('operational-values')) projected['operational-values'] = operationalValuesSource(graders, sources);
  if (requested.has('transactions')) {
    projected.transactions = {
      source: 'transactions',
      rows: transactions,
      metadata: projectionMetadata(sources, 'transactions', 'transactions', true)
    };
  }
  if (needsFirewall) {
    projected['firewall-observations'] = firewallObservationsSource(events, sessionsById, runsById, sources);
  }
  return projected;
}