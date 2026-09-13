const OBSERVED_AT = '2026-09-13T00:00:00.000Z';

/** @param {number[]} values @param {number} percentile */
function percentile(values, percentile) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.max(0, Math.ceil(ordered.length * percentile) - 1)] ?? 0;
}

/** @param {number[]} durations */
function summarize(durations) {
  return {
    samples: durations.length,
    medianMs: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    maxMs: Math.max(...durations)
  };
}

/**
 * @param {number} warmups
 * @param {number} iterations
 * @param {() => Promise<unknown>} operation
 */
async function measure(warmups, iterations, operation) {
  for (let index = 0; index < warmups; index += 1) await operation();
  const durations = [];
  for (let index = 0; index < iterations; index += 1) {
    const startedAt = performance.now();
    await operation();
    durations.push(performance.now() - startedAt);
  }
  return summarize(durations);
}

/** @param {{ repositories: number, workflows: number, runs: number, jobs: number, sessions: number, events: number }} size */
function createCorpus(size) {
  const repositories = Array.from({ length: size.repositories }, (_, index) => ({
    id: `repository:${index}`,
    githubId: index + 1,
    owner: 'acme',
    name: `repository-${index}`,
    fullName: `acme/repository-${index}`,
    observedAt: OBSERVED_AT
  }));
  const workflows = Array.from({ length: size.workflows }, (_, index) => {
    const repositoryIndex = index % size.repositories;
    return {
      id: `workflow:${index}`,
      repositoryId: `repository:${repositoryIndex}`,
      path: `.github/workflows/workflow-${index}.md`,
      name: `Workflow ${index}`,
      state: 'active',
      observedAt: OBSERVED_AT
    };
  });
  const runs = Array.from({ length: size.runs }, (_, index) => {
    const workflowIndex = index % size.workflows;
    const repositoryIndex = workflowIndex % size.repositories;
    return {
      id: `run:${index}`,
      repositoryId: `repository:${repositoryIndex}`,
      workflowId: `workflow:${workflowIndex}`,
      githubRunId: index + 1,
      attempt: 1,
      owner: 'acme',
      repository: `repository-${repositoryIndex}`,
      workflowPath: `.github/workflows/workflow-${workflowIndex}.md`,
      status: 'completed',
      conclusion: index % 20 === 0 ? 'failure' : 'success',
      startedAt: OBSERVED_AT,
      completedAt: OBSERVED_AT,
      observedAt: OBSERVED_AT
    };
  });
  const jobs = Array.from({ length: size.jobs }, (_, index) => ({
    id: `job:${index}`,
    runId: `run:${index % size.runs}`,
    name: 'build',
    status: 'completed',
    conclusion: 'success',
    startedAt: OBSERVED_AT,
    completedAt: OBSERVED_AT,
    observedAt: OBSERVED_AT
  }));
  const sessions = Array.from({ length: size.sessions }, (_, index) => {
    const jobIndex = index % size.jobs;
    return {
      id: `session:${index}`,
      runId: `run:${jobIndex % size.runs}`,
      jobId: `job:${jobIndex}`,
      startedAt: OBSERVED_AT,
      observedAt: OBSERVED_AT
    };
  });
  const events = Array.from({ length: size.events }, (_, index) => ({
    id: `event:${index}`,
    sessionId: `session:${index % size.sessions}`,
    sequence: index,
    timestamp: OBSERVED_AT,
    type: index % 10 === 0 ? 'firewall' : 'tool',
    source: 'storage-performance-contract',
    observedAt: OBSERVED_AT
  }));
  return { packages: [], repositories, workflows, runs, jobs, sessions, events };
}

/** @param {{ warmups: number, iterations: number, pageSize: number, corpus: Parameters<typeof createCorpus>[0] }} config */
async function runContract(config) {
  const [queryModule, declarativeModule, viewSourceModule, storageModule] = await Promise.all([
    import('../../src/data/queries/index.js'),
    import('../../src/data/queries/declarative.js'),
    import('../../src/data/queries/view-sources.js'),
    import('../../src/data/storage/indexeddb.js')
  ]);
  const { createCanonicalQueries } = queryModule;
  const { paginateDashboardSources } = declarativeModule;
  const { queryCanonicalViewSources } = viewSourceModule;
  const { deleteCanonicalDatabase, openCanonicalDatabase, replaceCanonicalBatch } = storageModule;
  const corpus = createCorpus(config.corpus);
  self.postMessage({ progress: { phase: 'corpus-ready' } });
  await deleteCanonicalDatabase(indexedDB);

  const ingestStartedAt = performance.now();
  await replaceCanonicalBatch(indexedDB, corpus);
  const coldReplaceMs = performance.now() - ingestStartedAt;
  self.postMessage({ progress: { phase: 'canonical-replacement-complete', milliseconds: coldReplaceMs } });
  const queries = createCanonicalQueries(indexedDB);

  const warmOpen = await measure(config.warmups, config.iterations, async () => {
    const database = await openCanonicalDatabase(indexedDB);
    database.close();
  });
  self.postMessage({ progress: { phase: 'warm-open-complete', milliseconds: warmOpen.p95Ms } });
  const indexedQuery = await measure(config.warmups, config.iterations, async () => {
    await queries.repositories.get('repository:0');
    await queries.workflows.forRepository('repository:0');
    await queries.runs.forWorkflow('workflow:0');
    await queries.jobs.forRun('run:0');
  });
  self.postMessage({ progress: { phase: 'indexed-query-complete', milliseconds: indexedQuery.p95Ms } });

  let pageRows = 0;
  let totalRows = 0;
  const routeProjection = await measure(config.warmups, config.iterations, async () => {
    const projected = await queryCanonicalViewSources(indexedDB, {}, ['failed-runs']);
    const paginated = paginateDashboardSources(
      projected,
      { 'failed-runs': { limit: config.pageSize } },
      'storage-performance-contract-v1'
    );
    pageRows = paginated['failed-runs'].rows.length;
    totalRows = Number(paginated['failed-runs'].metadata['total-row-count'] ?? pageRows);
  });
  self.postMessage({ progress: { phase: 'route-projection-complete', milliseconds: routeProjection.p95Ms } });

  await deleteCanonicalDatabase(indexedDB);
  return {
    coldReplaceMs,
    warmOpen,
    indexedQuery,
    routeProjection,
    pageRows,
    totalRows
  };
}

self.onmessage = (event) => {
  void runContract(event.data).then(
    (result) => self.postMessage({ result }),
    (error) => self.postMessage({
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    })
  );
};