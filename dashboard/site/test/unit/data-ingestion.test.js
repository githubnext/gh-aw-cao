import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { ingestDashboardSources, ingestGhAwLogsGeneration, ingestSqlExportGeneration } from '../../src/data/ingest/coordinator.js';
import { createCanonicalQueries } from '../../src/data/queries/index.js';
import { activeGenerationMetadata, DATABASE_NAME, openCanonicalDatabase } from '../../src/data/storage/indexeddb.js';

const metadata = { 'as-of': '2026-09-09T05:00:00Z', 'artifact-generation': 'generation-a' };
const sqlExport = JSON.parse(readFileSync(resolve('test/fixtures/sql-export-v1.json'), 'utf8'));
const sources = {
  repositories: {
    rows: [{ organization: 'githubnext', repository: 'gh-aw-cao', 'observed-at': metadata['as-of'] }],
    metadata
  },
  workflows: {
    rows: [{
      organization: 'githubnext',
      repository: 'gh-aw-cao',
      workflow: '.github/workflows/dashboard.md',
      'workflow-active': 'true',
      'observed-at': metadata['as-of']
    }],
    metadata
  },
  runs: {
    rows: [{
      organization: 'githubnext',
      repository: 'gh-aw-cao',
      workflow: '.github/workflows/dashboard.md',
      run: '12345',
      'run-attempt': 2,
      'run-status': 'completed',
      'run-conclusion': 'failure',
      'started-at': '2026-09-09T04:00:00Z',
      'ended-at': metadata['as-of']
    }],
    metadata
  },
  'job-performance': {
    rows: [{
      organization: 'githubnext',
      repository: 'gh-aw-cao',
      workflow: '.github/workflows/dashboard.md',
      run: '12345',
      'run-attempt': 2,
      'job-id': '67890',
      job: 'build',
      'job-status': 'completed',
      'job-conclusion': 'success',
      'started-at': '2026-09-09T04:30:00Z'
    }],
    metadata
  }
};

beforeEach(async () => {
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE_NAME);
    request.onsuccess = () => resolve(undefined);
    request.onerror = () => reject(request.error);
  });
});

describe('canonical source ingestion and queries', () => {
  it('ingests current sources and exposes only the active canonical generation', async () => {
    await expect(ingestDashboardSources(indexedDB, sources)).resolves.toEqual({
      generation: 'generation-a',
      activated: true
    });
    const queries = createCanonicalQueries(indexedDB);
    const repositories = await queries.repositories.list();
    const workflows = await queries.workflows.forRepository(String(repositories[0].id));
    const runs = await queries.runs.forWorkflow(String(workflows[0].id));
    const jobs = await queries.jobs.forRun(String(runs[0].id));

    expect(repositories).toHaveLength(1);
    expect(workflows).toHaveLength(1);
    expect(runs).toEqual([expect.objectContaining({ id: 'github:run:12345:attempt:2' })]);
    expect(jobs).toEqual([expect.objectContaining({ id: 'github:job:67890' })]);
    expect(await queries.runs.recentFailures()).toHaveLength(1);
  });

  it('skips rebuilding an already active generation', async () => {
    await ingestDashboardSources(indexedDB, sources);

    await expect(ingestDashboardSources(indexedDB, sources)).resolves.toEqual({
      generation: 'generation-a',
      activated: false
    });
  });

  it('fully replaces the active generation with a complete SQL export', async () => {
    await ingestDashboardSources(indexedDB, sources);

    await expect(ingestSqlExportGeneration(indexedDB, sqlExport)).resolves.toEqual({
      generation: 'warehouse-2026-09-09-05',
      activated: true
    });

    const queries = createCanonicalQueries(indexedDB);
    expect(await queries.counts()).toEqual({ workflows: 1, runs: 1, events: 2 });
    expect(await queries.runs.list()).toEqual([
      expect.objectContaining({ id: 'github:run:303:attempt:1' })
    ]);
    expect(await queries.sessions.forRun('github:run:303:attempt:1')).toEqual([
      expect.objectContaining({ id: 'session:sql%3Aenterprise-warehouse:session-505' })
    ]);
    expect(await queries.events.forSession('session:sql%3Aenterprise-warehouse:session-505'))
      .toHaveLength(2);
    await expect(activeGenerationMetadata(indexedDB)).resolves.toEqual({
      generation: 'warehouse-2026-09-09-05',
      canonicalSchemaVersion: 5
    });
  });

  it('fully replaces the active generation with complete gh-aw transaction logs', async () => {
    await ingestDashboardSources(indexedDB, sources);
    const input = {
      generation: 'gh-aw-generation-b',
      observedAt: '2026-09-09T05:00:00Z',
      repository: { githubId: '101', owner: 'githubnext', name: 'gh-aw-cao' },
      workflow: { githubId: '202', name: 'Dashboard', path: '.github/workflows/dashboard.md' },
      run: { githubRunId: '303', attempt: 1, status: 'completed', conclusion: 'success' },
      job: { githubJobId: '404', name: 'agent', status: 'completed', conclusion: 'success' },
      files: [{
        path: 'sandbox/agent/logs/copilot-session-state/session-505/events.jsonl',
        content: '{"type":"user.message","timestamp":"2026-09-09T04:00:01Z","data":{}}\n'
      }]
    };

    await expect(ingestGhAwLogsGeneration(indexedDB, input)).resolves.toEqual({
      generation: 'gh-aw-generation-b',
      activated: true
    });
    const queries = createCanonicalQueries(indexedDB);
    const activeRuns = await queries.runs.list();
    const activeSessions = await queries.sessions.forRun('github:run:303:attempt:1');
    expect(activeRuns).toEqual([expect.objectContaining({ id: 'github:run:303:attempt:1' })]);
    expect(await queries.events.forSession(String(activeSessions[0].id))).toEqual([
      expect.objectContaining({ source: 'agent', type: 'agent_turn', sequence: 0 })
    ]);
  });

  it('performs non-fatal browser storage preflight before ingestion', async () => {
    /** @type {string[]} */
    const calls = [];
    const storage = /** @type {StorageManager} */ ({
      estimate: async () => {
        calls.push('estimate');
        return { usage: 10, quota: 100 };
      },
      persist: async () => {
        calls.push('persist');
        return false;
      }
    });

    await expect(ingestDashboardSources(indexedDB, sources, { storage })).resolves.toMatchObject({
      generation: 'generation-a',
      activated: true
    });
    expect(calls.sort()).toEqual(['estimate', 'persist']);
  });

  it('rebuilds the same source generation when canonical schema metadata is missing', async () => {
    await ingestDashboardSources(indexedDB, sources);
    const database = await openCanonicalDatabase(indexedDB);
    const transaction = database.transaction('meta', 'readwrite');
    transaction.objectStore('meta').put({ key: 'activeGeneration', value: 'generation-a' });
    await new Promise((resolve) => { transaction.oncomplete = resolve; });
    database.close();

    await expect(ingestDashboardSources(indexedDB, sources)).resolves.toEqual({
      generation: 'generation-a',
      activated: true
    });
    await expect(activeGenerationMetadata(indexedDB)).resolves.toEqual({
      generation: 'generation-a',
      canonicalSchemaVersion: 5
    });
  });
});