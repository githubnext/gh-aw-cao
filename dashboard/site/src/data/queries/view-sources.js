import { dashboardSourceGeneration } from '../adapters/dashboard-sources.js';
import { ingestDashboardSources } from '../ingest/coordinator.js';
import { activeGenerationIsUsable } from '../storage/indexeddb.js';
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

/** @param {Record<string, unknown>} run @param {Map<string, Record<string, unknown>>} publishedRuns */
function projectedRun(run, publishedRuns) {
  return {
    ...(publishedRuns.get(runKey(run)) ?? {}),
    organization: run.owner,
    repository: run.repository,
    workflow: run.workflowPath,
    run: String(run.githubRunId ?? ''),
    'run-attempt': run.attempt,
    'run-title': run.title,
    event: run.event,
    'started-at': run.startedAt,
    'ended-at': run.completedAt,
    'run-status': run.status,
    'run-conclusion': run.conclusion,
    'failure-detail': run.failureDetail,
    'run-link': run.runLink,
    'rollout-mode': run.rolloutMode,
    engine: run.engine,
    'engine-version': run.engineVersion,
    'requested-model': run.requestedModel,
    'resolved-model': run.resolvedModel
  };
}

/** @param {Record<string, unknown>[]} runs @param {Record<string, unknown>} sources */
function runsSource(runs, sources) {
  const publishedRuns = new Map(sourceRows(sources.runs).map((run) => [runKey(run), run]));
  return {
    source: 'runs',
    rows: runs.map((run) => projectedRun(run, publishedRuns)),
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
      visibility: repository.visibility,
      'observed-at': repository.observedAt,
      'organization-link': repository.organizationLink,
      'repository-link': repository.repositoryLink
    })),
    metadata: projectionMetadata(sources, 'repositories', 'repositories', true)
  };
}

/**
 * @param {Record<string, unknown>[]} workflows
 * @param {Map<unknown, Record<string, unknown>>} repositoriesById
 * @param {Record<string, unknown>} sources
 */
function workflowsSource(workflows, repositoriesById, sources) {
  const publishedWorkflows = new Map(sourceRows(sources.workflows).map((workflow) => [
    [workflow.organization, workflow.repository, workflow.workflow].map(normalizedKey).join(':'),
    workflow
  ]));
  return {
    source: 'workflows',
    rows: workflows.map((workflow) => {
      const repository = repositoriesById.get(workflow.repositoryId) ?? {};
      return {
        ...(publishedWorkflows.get([
          repository.owner,
          repository.name,
          workflow.path
        ].map(normalizedKey).join(':')) ?? {}),
        organization: repository.owner,
        repository: repository.name,
        workflow: workflow.path,
        'workflow-name': workflow.name,
        'workflow-active': workflow.state === 'active' ? 'true'
          : workflow.state === 'disabled' ? 'false' : 'unknown',
        'observed-at': workflow.observedAt,
        'gh-aw-version': workflow.ghAwVersion,
        'gh-aw-current-version': workflow.ghAwCurrentVersion,
        'gh-aw-update-state': workflow.ghAwUpdateState,
        'workflow-link': workflow.workflowLink
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

/** @param {Record<string, unknown>[]} workItems @param {Record<string, unknown>} sources */
function workItemsSource(workItems, sources) {
  return {
    source: 'work-items',
    rows: workItems.map((item) => ({
      'work-item-id': item.workItemId,
      name: item.name,
      objective: item.objective,
      organization: item.organization,
      repository: item.repository,
      workflow: item.workflowPath,
      run: item.githubRunId,
      'workflow-name': item.workflowName,
      'workflow-icon': item.workflowIcon,
      package: item.packageName,
      scope: item.scope,
      domain: item.domain,
      'work-type': item.workType,
      'lifecycle-state': item.lifecycleState,
      phase: item.phase,
      reason: item.reason,
      'reason-evidence-class': item.reasonEvidenceClass,
      'next-action': item.nextAction,
      'next-actor': item.nextActor,
      'safe-output-kind': item.safeOutputKind,
      'waiting-on': item.waitingOn,
      'waiting-since': item.waitingSince,
      owner: item.owner,
      'consequence-tier': item.consequenceTier,
      'verification-state': item.verificationState,
      'outcome-state': item.outcomeState,
      'started-at': item.startedAt,
      'ended-at': item.completedAt,
      'observed-at': item.observedAt,
      'evidence-link': item.evidenceLink,
      'repository-link': item.repositoryLink,
      'run-link': item.runLink
    })),
    metadata: projectionMetadata(sources, 'work-items', 'work-items', true)
  };
}

/** @param {Record<string, unknown>[]} findings @param {Record<string, unknown>} sources */
function securityFindingsSource(findings, sources) {
  return {
    source: 'security-findings',
    rows: findings.map((finding) => ({
      organization: finding.organization,
      repository: finding.repository,
      workflow: finding.workflowPath,
      run: finding.githubRunId,
      'smell-observation-id': finding.observationId,
      'smell-id': finding.findingId,
      'smell-name': finding.name,
      'smell-category': finding.category,
      'smell-severity': finding.severity,
      'smell-summary': finding.summary,
      'smell-evidence': finding.evidence,
      'smell-recommendation': finding.recommendation,
      'observed-at': finding.observedAt,
      'evidence-link': finding.evidenceLink,
      'repository-link': finding.repositoryLink,
      'workflow-link': finding.workflowLink,
      'run-link': finding.runLink
    })),
    metadata: projectionMetadata(sources, 'security-findings', 'security-findings', true)
  };
}

/**
 * @param {Record<string, unknown>[]} events
 * @param {Map<string, Record<string, unknown>>} sessionsById
 * @param {Map<string, Record<string, unknown>>} runsById
 * @param {Record<string, unknown>} sources
 */
function firewallEventsSource(events, sessionsById, runsById, sources) {
  return {
    source: 'firewall-events',
    rows: events.map((event) => {
      const session = sessionsById.get(String(event.sessionId)) ?? {};
      const run = runsById.get(String(session.runId)) ?? {};
      const domain = String(event.summary ?? '').trim().split(/\s+/, 1)[0];
      return {
        domain,
        run: String(run.githubRunId ?? ''),
        event: event.id,
        'event-source': event.source,
        'event-type': event.type,
        'event-timestamp': event.timestamp,
        'observed-at': event.observedAt
      };
    }).filter((event) => event.domain),
    metadata: projectionMetadata(sources, 'events', 'firewall-events', true)
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

/**
 * @param {IDBFactory} indexedDB
 * @param {Record<string, unknown>} sources
 * @param {{ ingest?: boolean, storage?: StorageManager }} [options]
 */
export async function loadCanonicalViewSources(indexedDB, sources, options = {}) {
  const generation = dashboardSourceGeneration(sources);
  if (options.ingest) {
    await ingestDashboardSources(indexedDB, sources, { storage: options.storage });
  }
  return projectCanonicalViewSources(indexedDB, sources, generation);
}

/**
 * Projects freshly downloaded logical sources through one active canonical
 * generation. Source-shaped rows remain transient and are never cached in
 * IndexedDB.
 *
 * @param {IDBFactory} indexedDB
 * @param {Record<string, unknown>} logicalSources
 * @param {string} generation
 */
export async function projectCanonicalViewSources(indexedDB, logicalSources, generation) {
  return {
    ...namedLogicalSources(logicalSources),
    ...await queryCanonicalViewSources(indexedDB, logicalSources, generation, [
      'repositories',
      'workflows',
      'runs',
      'job-performance',
      'failed-runs',
      'work-items',
      'security-findings',
      'firewall-events'
    ])
  };
}

/**
 * Executes only the canonical queries required by the requested view sources.
 *
 * @param {IDBFactory} indexedDB
 * @param {Record<string, unknown>} logicalSources
 * @param {string} generation
 * @param {string[]} sourceNames
 */
export async function queryCanonicalViewSources(indexedDB, logicalSources, generation, sourceNames) {
  if (!await activeGenerationIsUsable(indexedDB, generation)) {
    throw new Error(`Canonical generation ${generation} is not active and usable`);
  }
  if (!Array.isArray(sourceNames) || sourceNames.some((name) => typeof name !== 'string')) {
    throw new TypeError('Canonical view source names must be an array of strings.');
  }
  const requested = new Set(sourceNames);
  const queries = createCanonicalQueries(indexedDB);
  const [repositories, workflows, runs, jobs, failedRuns, workItems, findings, firewallEvents] = await Promise.all([
    requested.has('repositories') || requested.has('workflows') ? queries.repositories.list() : [],
    requested.has('workflows') ? queries.workflows.list() : [],
    requested.has('runs') || requested.has('job-performance') ? queries.runs.list() : [],
    requested.has('job-performance') ? queries.jobs.list() : [],
    requested.has('failed-runs') ? queries.runs.recentFailures() : [],
    requested.has('work-items') ? queries.workItems.list() : [],
    requested.has('security-findings') ? queries.findings.list() : [],
    requested.has('firewall-events')
      ? queries.events.forSourceByTypes('firewall', ['net_allowed', 'net_blocked'])
      : []
  ]);
  const firewallSessionIds = [...new Set(firewallEvents.map((event) => String(event.sessionId)))];
  const firewallSessions = await Promise.all(firewallSessionIds.map((id) => queries.sessions.get(id)));
  const sessionsById = new Map(firewallSessions.filter(Boolean).map((session) => [String(session.id), session]));
  const firewallRunIds = [...new Set(firewallSessions.filter(Boolean).map((session) => String(session.runId)))];
  const firewallRuns = await Promise.all(firewallRunIds.map((id) => queries.runs.get(id)));
  const firewallRunsById = new Map(firewallRuns.filter(Boolean).map((run) => [String(run.id), run]));
  const repositoriesById = new Map(repositories.map((repository) => [repository.id, repository]));
  const runsById = new Map(runs.map((run) => [run.id, run]));
  const sources = namedLogicalSources(logicalSources);
  /** @type {Record<string, import('../../presenter.js').LogicalSourceInput>} */
  const projected = {};
  if (requested.has('repositories')) projected.repositories = repositoriesSource(repositories, sources);
  if (requested.has('workflows')) projected.workflows = workflowsSource(workflows, repositoriesById, sources);
  if (requested.has('job-performance')) projected['job-performance'] = jobsSource(jobs, runsById, sources);
  if (requested.has('runs')) projected.runs = runsSource(runs, sources);
  if (requested.has('failed-runs')) projected['failed-runs'] = failedRunsSource(failedRuns, sources);
  if (requested.has('work-items')) projected['work-items'] = workItemsSource(workItems, sources);
  if (requested.has('security-findings')) projected['security-findings'] = securityFindingsSource(findings, sources);
  if (requested.has('firewall-events')) {
    projected['firewall-events'] = firewallEventsSource(
      firewallEvents,
      sessionsById,
      firewallRunsById,
      sources
    );
  }
  return projected;
}
