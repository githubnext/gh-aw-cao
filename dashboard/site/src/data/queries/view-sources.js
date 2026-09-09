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
  if (!await activeGenerationIsUsable(indexedDB, generation)) {
    throw new Error(`Canonical generation ${generation} is not active and usable`);
  }
  const queries = createCanonicalQueries(indexedDB);
  const [repositories, workflows, runs, jobs, failedRuns] = await Promise.all([
    queries.repositories.list(),
    queries.workflows.list(),
    queries.runs.list(),
    queries.jobs.list(),
    queries.runs.recentFailures()
  ]);
  const repositoriesById = new Map(repositories.map((repository) => [repository.id, repository]));
  const runsById = new Map(runs.map((run) => [run.id, run]));
  const sources = namedLogicalSources(logicalSources);
  return {
    ...sources,
    repositories: repositoriesSource(repositories, sources),
    workflows: workflowsSource(workflows, repositoriesById, sources),
    'job-performance': jobsSource(jobs, runsById, sources),
    runs: runsSource(runs, sources),
    'failed-runs': failedRunsSource(failedRuns, sources)
  };
}