import { test, expect } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const siteRoot = fileURLToPath(new URL('../..', import.meta.url));
const databaseName = 'gh-aw-cao-dashboard-data';

function ghAwLogInput() {
  const fixtureRoot = join(siteRoot, 'test', 'fixtures', 'gh-aw-logs');
  const context = JSON.parse(readFileSync(join(fixtureRoot, 'context.json'), 'utf8'));
  const paths = [
    'run-303/mcp-logs/gateway.jsonl',
    'run-303/sandbox/firewall/audit/audit.jsonl',
    'run-303/sandbox/agent/logs/copilot-session-state/session-505/events.jsonl'
  ];
  return {
    ...context,
    files: paths.map((path) => ({ path, content: readFileSync(join(fixtureRoot, path), 'utf8') }))
  };
}

function canonicalSources(generation = 'browser-generation', run = '12345') {
  return {
    repositories: {
      rows: [{ organization: 'githubnext', repository: 'gh-aw-cao', 'observed-at': '2026-09-09T05:00:00Z' }],
      metadata: { 'as-of': '2026-09-09T05:00:00Z', 'artifact-generation': generation }
    },
    workflows: {
      rows: [{
        organization: 'githubnext',
        repository: 'gh-aw-cao',
        workflow: '.github/workflows/dashboard.md',
        'observed-at': '2026-09-09T05:00:00Z'
      }],
      metadata: { 'as-of': '2026-09-09T05:00:00Z', 'artifact-generation': generation }
    },
    runs: {
      rows: [{
        organization: 'githubnext',
        repository: 'gh-aw-cao',
        workflow: '.github/workflows/dashboard.md',
        run,
        'run-attempt': 2,
        'run-status': 'completed',
        'run-conclusion': 'failure',
        'started-at': '2026-09-09T04:00:00Z'
      }],
      metadata: { 'as-of': '2026-09-09T05:00:00Z', 'artifact-generation': generation }
    },
    'job-performance': {
      rows: [{
        organization: 'githubnext',
        repository: 'gh-aw-cao',
        workflow: '.github/workflows/dashboard.md',
        run,
        'run-attempt': 2,
        'job-id': `${run}9`,
        job: 'build',
        'started-at': '2026-09-09T04:01:00Z'
      }],
      metadata: { 'as-of': '2026-09-09T05:00:00Z', 'artifact-generation': generation }
    }
  };
}

test.beforeEach(async ({ context, page }) => {
  await context.route('http://dashboard.test/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/' || pathname === '/index.html') {
      await route.fulfill({ contentType: 'text/html', body: '<main>Canonical data test</main>' });
      return;
    }
    const filePath = join(siteRoot, pathname);
    if (existsSync(filePath)) {
      await route.fulfill({ contentType: 'application/javascript', body: readFileSync(filePath) });
    } else {
      await route.fulfill({ contentType: 'text/html', body: '<main>Canonical data test</main>' });
    }
  });
  await page.goto('http://dashboard.test/');
  await page.evaluate((name) => new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve(undefined);
    request.onerror = () => reject(request.error);
  }), databaseName);
});

test('native IndexedDB activates and retains a canonical generation across reload', async ({ page }) => {
  const sources = canonicalSources();

  const first = await page.evaluate(async (sourceDocument) => {
    const coordinatorUrl = `${location.origin}/src/data/ingest/coordinator.js`;
    const queriesUrl = `${location.origin}/src/data/queries/index.js`;
    const [{ ingestDashboardSources }, { createCanonicalQueries }] = await Promise.all([
      import(coordinatorUrl),
      import(queriesUrl)
    ]);
    const result = await ingestDashboardSources(indexedDB, sourceDocument);
    const queries = createCanonicalQueries(indexedDB);
    const repositories = await queries.repositories.list();
    const workflows = await queries.workflows.forRepository(String(repositories[0].id));
    const runs = await queries.runs.forWorkflow(String(workflows[0].id));
    const jobs = await queries.jobs.forRun(String(runs[0].id));
    return { result, repositories, workflows, runs, jobs };
  }, sources);

  expect(first.result).toEqual({ generation: 'browser-generation', activated: true });
  expect(first.repositories).toHaveLength(1);
  expect(first.workflows).toHaveLength(1);
  expect(first.runs[0].id).toBe('github:run:12345:attempt:2');
  expect(first.jobs[0].id).toBe('github:job:123459');

  await page.reload();
  const retained = await page.evaluate(async () => {
    const queriesUrl = `${location.origin}/src/data/queries/index.js`;
    const { createCanonicalQueries } = await import(queriesUrl);
    const queries = createCanonicalQueries(indexedDB);
    return queries.runs.recentFailures();
  });
  expect(retained).toEqual([expect.objectContaining({ id: 'github:run:12345:attempt:2' })]);

  const viewSources = await page.evaluate(async (sourceDocument) => {
    const viewSourcesUrl = `${location.origin}/src/data/queries/view-sources.js`;
    const { loadCanonicalViewSources } = await import(viewSourcesUrl);
    return loadCanonicalViewSources(indexedDB, sourceDocument);
  }, sources);
  expect(viewSources['failed-runs']).toMatchObject({
    source: 'failed-runs',
    rows: [{
      organization: 'githubnext',
      repository: 'gh-aw-cao',
      run: '12345',
      'run-attempt': 2,
      'run-conclusion': 'failure'
    }],
    metadata: {
      'source-kind': 'canonical-query',
      availability: 'available'
    }
  });
  expect(viewSources.runs).toMatchObject({
    source: 'runs',
    rows: [{
      organization: 'githubnext',
      repository: 'gh-aw-cao',
      run: '12345',
      'run-attempt': 2,
      'run-conclusion': 'failure'
    }],
    metadata: {
      'source-kind': 'canonical-query',
      availability: 'available'
    }
  });
  expect(viewSources.repositories.rows).toMatchObject([{
    organization: 'githubnext', repository: 'gh-aw-cao'
  }]);
  expect(viewSources.workflows.rows).toMatchObject([{
    organization: 'githubnext', repository: 'gh-aw-cao',
    workflow: '.github/workflows/dashboard.md'
  }]);
  expect(viewSources['job-performance'].rows).toMatchObject([{
    organization: 'githubnext', repository: 'gh-aw-cao', run: '12345',
    'run-attempt': 2, 'job-id': '123459', job: 'build'
  }]);
});

test('Chromium ingests gh-aw artifacts as Run, Session, and ordered Events', async ({ page }) => {
  const result = await page.evaluate(async (input) => {
    const coordinatorUrl = `${location.origin}/src/data/ingest/coordinator.js`;
    const queriesUrl = `${location.origin}/src/data/queries/index.js`;
    const [{ ingestGhAwLogsGeneration }, { createCanonicalQueries }] = await Promise.all([
      import(coordinatorUrl),
      import(queriesUrl)
    ]);
    const ingestion = await ingestGhAwLogsGeneration(indexedDB, input);
    const queries = createCanonicalQueries(indexedDB);
    const runs = await queries.runs.list();
    const sessions = await queries.sessions.forRun(String(runs[0].id));
    const events = await queries.events.forSession(String(sessions[0].id));
    return { ingestion, runs, sessions, events };
  }, ghAwLogInput());

  expect(result.ingestion).toEqual({
    generation: 'gh-aw-logs-2026-09-09-05',
    activated: true
  });
  expect(result.runs[0].id).toBe('github:run:303:attempt:1');
  expect(result.sessions[0].kind).toBe('unified-operational-log');
  expect(result.events.map((/** @type {Record<string, unknown>} */ event) => [event.sequence, event.source, event.type])).toEqual([
    [0, 'agent', 'agent_turn'],
    [1, 'gateway', 'tool_call'],
    [2, 'agent', 'agent_tool_start'],
    [3, 'agent', 'agent_tool_done'],
    [4, 'firewall', 'net_allowed'],
    [5, 'agent', 'assistant_message']
  ]);
});

test('deletion rebuilds derived state and replacement retires the previous generation', async ({ page }) => {
  const result = await page.evaluate(async ({ firstSources, replacementSources, name }) => {
    const coordinatorUrl = `${location.origin}/src/data/ingest/coordinator.js`;
    const storageUrl = `${location.origin}/src/data/storage/indexeddb.js`;
    const [{ ingestDashboardSources }, storage] = await Promise.all([
      import(coordinatorUrl),
      import(storageUrl)
    ]);
    await ingestDashboardSources(indexedDB, firstSources);
    await new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve(undefined);
      request.onerror = () => reject(request.error);
    });
    const rebuilt = await ingestDashboardSources(indexedDB, firstSources);
    const replaced = await ingestDashboardSources(indexedDB, replacementSources);
    return {
      rebuilt,
      replaced,
      active: await storage.activeGeneration(indexedDB),
      previousState: await storage.generationState(indexedDB, 'generation-a')
    };
  }, {
    firstSources: canonicalSources('generation-a', '101'),
    replacementSources: canonicalSources('generation-b', '202'),
    name: databaseName
  });

  expect(result).toEqual({
    rebuilt: { generation: 'generation-a', activated: true },
    replaced: { generation: 'generation-b', activated: true },
    active: 'generation-b',
    previousState: 'retired'
  });
});

test('corrupt and interrupted staging never replace active data', async ({ page }) => {
  const activeSources = canonicalSources('generation-a', '101');
  const interruptedSources = canonicalSources('generation-c', '303');
  const beforeReload = await page.evaluate(async ({ active, interrupted }) => {
    const coordinatorUrl = `${location.origin}/src/data/ingest/coordinator.js`;
    const adapterUrl = `${location.origin}/src/data/adapters/dashboard-sources.js`;
    const normalizeUrl = `${location.origin}/src/data/normalize/index.js`;
    const storageUrl = `${location.origin}/src/data/storage/indexeddb.js`;
    const [{ ingestDashboardSources }, { adaptDashboardSources }, { normalize }, storage] = await Promise.all([
      import(coordinatorUrl), import(adapterUrl), import(normalizeUrl), import(storageUrl)
    ]);
    await ingestDashboardSources(indexedDB, active);

    const invalid = normalize([], { generation: 'generation-b' });
    invalid.workflows.push({
      id: 'workflow:missing-parent',
      repositoryId: 'repository:missing',
      generation: 'generation-b'
    });
    await storage.stageCanonicalBatch(indexedDB, invalid, 'generation-b');
    await storage.activateGeneration(indexedDB, 'generation-b').catch(() => undefined);

    const adapted = adaptDashboardSources(interrupted);
    const batch = normalize(adapted.observations, { generation: adapted.generation });
    await storage.stageCanonicalBatch(indexedDB, batch, adapted.generation, {
      batchSize: 1,
      onBatchCommitted: (/** @type {{ committedBatches: number }} */ progress) => {
        if (progress.committedBatches === 1) throw new Error('terminate before activation');
      }
    }).catch(() => undefined);
    return {
      active: await storage.activeGeneration(indexedDB),
      corruptState: await storage.generationState(indexedDB, 'generation-b'),
      interruptedState: await storage.generationState(indexedDB, 'generation-c')
    };
  }, { active: activeSources, interrupted: interruptedSources });

  expect(beforeReload).toEqual({
    active: 'generation-a',
    corruptState: 'failed',
    interruptedState: 'staging'
  });

  await page.reload();
  const afterReload = await page.evaluate(async (sources) => {
    const coordinatorUrl = `${location.origin}/src/data/ingest/coordinator.js`;
    const storageUrl = `${location.origin}/src/data/storage/indexeddb.js`;
    const [{ ingestDashboardSources }, storage] = await Promise.all([
      import(coordinatorUrl), import(storageUrl)
    ]);
    const resumed = await ingestDashboardSources(indexedDB, sources);
    return { resumed, active: await storage.activeGeneration(indexedDB) };
  }, interruptedSources);

  expect(afterReload).toEqual({
    resumed: { generation: 'generation-c', activated: true },
    active: 'generation-c'
  });
});