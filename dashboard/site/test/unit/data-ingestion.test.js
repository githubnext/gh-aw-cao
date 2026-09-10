import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { ingestCachedGhAwJsonl, ingestDashboardSources, ingestGhAwLogs, ingestSqlExport } from '../../src/data/ingest/coordinator.js';
import { createCanonicalQueries } from '../../src/data/queries/index.js';
import { DATABASE_NAME, readTransactions } from '../../src/data/storage/indexeddb.js';

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
  it('upserts current sources for immediate canonical queries', async () => {
    await expect(ingestDashboardSources(indexedDB, sources)).resolves.toMatchObject({
      updated: true
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

  it('idempotently upserts the same fresh data', async () => {
    await ingestDashboardSources(indexedDB, sources);

    await expect(ingestDashboardSources(indexedDB, sources)).resolves.toMatchObject({
      updated: true
    });
    const queries = createCanonicalQueries(indexedDB);
    await expect(queries.repositories.list()).resolves.toHaveLength(1);
  });

  it('upserts a complete SQL export onto retained canonical records', async () => {
    await ingestDashboardSources(indexedDB, sources);

    await expect(ingestSqlExport(indexedDB, sqlExport)).resolves.toMatchObject({
      updated: true
    });

    const queries = createCanonicalQueries(indexedDB);
    expect((await queries.runs.list()).map((run) => run.id)).toEqual([
      'github:run:12345:attempt:2',
      'github:run:303:attempt:1'
    ]);
    expect(await queries.sessions.forRun('github:run:303:attempt:1')).toEqual([
      expect.objectContaining({ id: 'session:sql%3Aenterprise-warehouse:session-505' })
    ]);
    expect(await queries.events.forSession('session:sql%3Aenterprise-warehouse:session-505'))
      .toHaveLength(2);
  });

  it('upserts complete gh-aw transaction logs onto retained canonical records', async () => {
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

    await expect(ingestGhAwLogs(indexedDB, input)).resolves.toMatchObject({
      updated: true
    });

    const queries = createCanonicalQueries(indexedDB);
    const activeRuns = await queries.runs.list();
    const activeSessions = await queries.sessions.forRun('github:run:303:attempt:1');
    expect(activeRuns.map((run) => run.id)).toEqual([
      'github:run:12345:attempt:2',
      'github:run:303:attempt:1'
    ]);
    expect(await queries.events.forSession(String(activeSessions[0].id))).toEqual([
      expect.objectContaining({ source: 'agent', type: 'agent_turn', sequence: 0 })
    ]);
  });

  it('ingests schema-v2 cached JSONL, audits it, and expires stale records', async () => {
    const content = `${JSON.stringify({ schema_version: 2, kind: 'run', run: {
      run_id: 303, run_attempt: '1', organization: 'githubnext', repository: 'gh-aw-cao',
      workflow_name: 'Dashboard', workflow_path: '.github/workflows/dashboard.md',
      status: 'completed', classification: 'success', created_at: '2026-01-01T00:00:00Z',
      url: 'https://github.com/githubnext/gh-aw-cao/actions/runs/303', logs_path: 'logs', event: 'push', branch: 'main'
    } })}\n${JSON.stringify({ schema_version: 2, kind: 'github_api_rate_limit', rate_limit: {} })}\n`;
    await expect(ingestCachedGhAwJsonl(indexedDB, content, { now: Date.parse('2026-01-01T00:00:00Z') }))
      .resolves.toMatchObject({ updated: true, records: 1 });
    await expect(createCanonicalQueries(indexedDB).runs.list()).resolves.toEqual([
      expect.objectContaining({ id: 'github:run:303:attempt:1', repositoryFullName: 'githubnext/gh-aw-cao' })
    ]);
    await expect(readTransactions(indexedDB)).resolves.toEqual([
      expect.objectContaining({ kind: 'ingest-jsonl', records: 1 })
    ]);
    await ingestCachedGhAwJsonl(indexedDB, '', { now: Date.parse('2026-02-01T00:00:00Z') });
    await expect(createCanonicalQueries(indexedDB).runs.list()).resolves.toEqual([]);
  });

  it('upserts multiple JSONL runs and retains earlier fresh records', async () => {
    /** @param {number} run_id @param {string} created_at */
    const record = (run_id, created_at) => JSON.stringify({ schema_version: 2, kind: 'run', run: {
      run_id, run_attempt: '1', organization: 'githubnext', repository: 'gh-aw-cao',
      workflow_name: 'Dashboard', workflow_path: '.github/workflows/dashboard.md',
      status: 'completed', classification: 'success', created_at,
      url: `https://github.com/githubnext/gh-aw-cao/actions/runs/${run_id}`, logs_path: 'logs', event: 'push', branch: 'main'
    } });
    await ingestCachedGhAwJsonl(indexedDB, `${record(1, '2026-02-01T00:00:00Z')}\n`, {
      now: Date.parse('2026-02-01T00:00:00Z')
    });
    await ingestCachedGhAwJsonl(indexedDB, `${record(2, '2026-02-02T00:00:00Z')}\n`, {
      now: Date.parse('2026-02-02T00:00:00Z')
    });
    expect((await createCanonicalQueries(indexedDB).runs.list()).map((run) => run.id).sort()).toEqual([
      'github:run:1:attempt:1', 'github:run:2:attempt:1'
    ]);
  });

  it('records failed JSONL ingestion without storing partial entities', async () => {
    await expect(ingestCachedGhAwJsonl(indexedDB, '{"schema_version":2,"kind":"run","run":')).rejects.toThrow();
    await expect(createCanonicalQueries(indexedDB).runs.list()).resolves.toEqual([]);
    await expect(readTransactions(indexedDB)).resolves.toEqual([
      expect.objectContaining({ kind: 'ingest-jsonl-failed', error: 'TypeError' })
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

    await expect(ingestDashboardSources(indexedDB, sources, { storage })).resolves.toMatchObject({ updated: true });
    expect(calls.sort()).toEqual(['estimate', 'persist']);
  });

  it('overwrites matching records with fresh source data', async () => {
    await ingestDashboardSources(indexedDB, sources);
    const refreshed = structuredClone(sources);
    Object.assign(refreshed.repositories.rows[0], { visibility: 'private' });

    await expect(ingestDashboardSources(indexedDB, refreshed)).resolves.toMatchObject({ updated: true });
    const queries = createCanonicalQueries(indexedDB);
    await expect(queries.repositories.list()).resolves.toEqual([
      expect.objectContaining({ visibility: 'private' })
    ]);
  });
});