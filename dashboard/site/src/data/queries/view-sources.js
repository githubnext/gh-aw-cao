import { ingestDashboardSources } from '../ingest/coordinator.js';
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
    'agent-id': run.agentId,
    'agent-version': run.agentVersion,
    'model-id': run.modelId,
    'gh-aw-version': run.ghAwVersion,
    'aic-total': run.aicTotal,
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
          'event-type': event.type,
          'event-summary': event.summary,
          'event-status': event.status,
          'correlation-id': event.correlationId,
          'payload-ref': event.payloadRef,
          'source-sequence': event.sourceSequence,
          'observed-at': event.observedAt
        })
      };
    }),
    metadata: projectionMetadata(sources, 'events', 'events', true)
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
      'events'
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
  const [packages, repositories, workflows, runs, jobs, failedRuns, sessions, events] = await Promise.all([
    requested.has('packages') ? queries.packages.list() : [],
    requested.has('repositories') || requested.has('workflows') ? queries.repositories.list() : [],
    requested.has('workflows') ? queries.workflows.list() : [],
    requested.has('runs') || requested.has('job-performance') || requested.has('events')
      ? queries.runs.list() : [],
    requested.has('job-performance') ? queries.jobs.list() : [],
    requested.has('failed-runs') ? queries.runs.recentFailures() : [],
    requested.has('events') ? queries.sessions.list() : [],
    requested.has('events') ? queries.events.list() : []
  ]);
  const repositoriesById = new Map(repositories.map((repository) => [repository.id, repository]));
  const runsById = new Map(runs.map((run) => [run.id, run]));
  const sessionsById = new Map(sessions.map((session) => [session.id, session]));
  const sources = namedLogicalSources(logicalSources);
  /** @type {Record<string, import('../../presenter.js').LogicalSourceInput>} */
  const projected = {};
  if (requested.has('packages')) projected.packages = packagesSource(packages, sources);
  if (requested.has('repositories')) projected.repositories = repositoriesSource(repositories, sources);
  if (requested.has('workflows')) projected.workflows = workflowsSource(workflows, repositoriesById, sources);
  if (requested.has('job-performance')) projected['job-performance'] = jobsSource(jobs, runsById, sources);
  if (requested.has('runs')) projected.runs = runsSource(runs, sources);
  if (requested.has('failed-runs')) projected['failed-runs'] = failedRunsSource(failedRuns, sources);
  if (requested.has('events')) projected.events = eventsSource(events, sessionsById, runsById, sources);
  return projected;
}