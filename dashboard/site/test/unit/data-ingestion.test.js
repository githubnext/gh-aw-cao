import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  finalizeNormalizedJsonlIngestion,
  ingestCachedGhAwJsonl,
  ingestDashboardSources,
  ingestGhAwLogs,
  ingestNormalizedJsonl,
  ingestSqlExport
} from '../../src/data/ingest/coordinator.js';
import { createCanonicalQueries } from '../../src/data/queries/index.js';
import { CANONICAL_SCHEMA_VERSION } from '../../src/data/model/schema.js';
import {
  DATABASE_NAME,
  readCanonicalBatch,
  readDailyOverviewAggregates,
  readTransactions,
  recordTransaction,
  replaceCanonicalBatch
} from '../../src/data/storage/indexeddb.js';
import { estimateCanonicalBatchBytes } from '../../src/data/storage/retention.js';

const metadata = { 'as-of': '2026-09-09T05:00:00Z', 'artifact-generation': 'generation-a' };
const sqlExport = JSON.parse(readFileSync(resolve('test/fixtures/sql-export-v3.json'), 'utf8'));
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

describe('database table ingestion and queries', () => {
  it('streams normalized JSONL across chunk boundaries and skips published repeats', async () => {
    await ingestDashboardSources(indexedDB, sources);
    const inventoryRepository = (await readCanonicalBatch(indexedDB)).repositories[0];
    const lines = [
      {
        kind: 'metadata',
        schemaVersion: CANONICAL_SCHEMA_VERSION,
        ingestionVersion: 3,
        sourceRecords: 1,
        phase: 'runs',
        records: 1
      },
      {
        kind: 'record',
        collection: 'repositories',
        record: {
          ...inventoryRepository,
          owner: 'overwritten-by-activity',
          provenance: {
            source: 'test',
            sourceId: 'normalized-jsonl',
            observedAt: '2026-09-09T05:00:00Z'
          }
        }
      }
    ].map((line) => JSON.stringify(line)).join('\n') + '\n';
    async function* chunks() {
      yield lines.slice(0, 17);
      yield new TextEncoder().encode(lines.slice(17, 89));
      yield lines.slice(89);
    }
    const options = {
      payloadIdentity: 'f'.repeat(64),
      payloadScope: 'https://example.test/gh-aw-logs-runs/shard.jsonl',
      expectedPhase: /** @type {const} */ ('runs')
    };

    await expect(ingestNormalizedJsonl(indexedDB, chunks(), options)).resolves.toMatchObject({
      updated: true,
      committedRecords: 1
    });

    const incompleteReceipt = (await readTransactions(indexedDB))
      .find(({ kind }) => kind === 'ingest-normalized-jsonl');
    expect(incompleteReceipt).toBeDefined();
    delete incompleteReceipt.rawRuns;
    await recordTransaction(indexedDB, incompleteReceipt);
    await expect(ingestNormalizedJsonl(indexedDB, chunks(), options)).resolves.toMatchObject({
      updated: true,
      committedRecords: 1
    });
    await expect(ingestNormalizedJsonl(indexedDB, chunks(), options)).resolves.toMatchObject({
      updated: false,
      skipped: true
    });
    expect((await readCanonicalBatch(indexedDB)).repositories).toEqual([
      expect.objectContaining({
        id: inventoryRepository.id,
        owner: inventoryRepository.owner
      })
    ]);
    expect(await readTransactions(indexedDB)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: `ingest-normalized-jsonl:sha256:${options.payloadIdentity}:v3`,
        kind: 'ingest-normalized-jsonl',
        payloadHash: options.payloadIdentity
      })
    ]));
  });

  it('does not treat an unsupported normalized JSON receipt as a current JSONL shard', async () => {
    const payloadIdentity = 'e'.repeat(64);
    await recordTransaction(indexedDB, {
      id: `ingest-normalized-json:sha256:${payloadIdentity}:v3`,
      kind: 'ingest-normalized-json',
      createdAt: '2026-09-09T05:00:00Z',
      payloadHash: payloadIdentity,
      ingestionVersion: 3
    });
    async function* chunks() {
      yield JSON.stringify({
        kind: 'metadata',
        schemaVersion: CANONICAL_SCHEMA_VERSION,
        ingestionVersion: 3,
        phase: 'runs',
        records: 0
      });
    }
    await expect(ingestNormalizedJsonl(indexedDB, chunks(), {
      payloadIdentity,
      payloadScope: 'https://example.test/gh-aw-logs-runs/shard.jsonl',
      expectedPhase: 'runs'
    })).resolves.toMatchObject({ updated: true });
    expect(await readTransactions(indexedDB)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: `ingest-normalized-jsonl:sha256:${payloadIdentity}:v3`,
        kind: 'ingest-normalized-jsonl'
      })
    ]));
  });

  it('rejects obsolete normalized JSONL schemas', async () => {
    async function* chunks() {
      yield JSON.stringify({
        kind: 'metadata',
        schemaVersion: 12,
        ingestionVersion: 3,
        phase: 'runs',
        records: 0
      });
    }
    await expect(ingestNormalizedJsonl(indexedDB, chunks(), {
      payloadIdentity: 'a'.repeat(64),
      payloadScope: 'https://example.test/gh-aw-logs-runs/obsolete.jsonl'
    })).rejects.toThrow('Unsupported normalized activity schema: 12');
  });

  it('defers canonical maintenance for batched shard imports until it is finalized', async () => {
    const shard = (/** @type {{ id: string, observedAt: string }[]} */ runs) => {
      const lines = [
        {
          kind: 'metadata',
          schemaVersion: CANONICAL_SCHEMA_VERSION,
          ingestionVersion: 3,
          sourceRecords: runs.length,
          phase: 'runs',
          records: runs.length
        },
        ...runs.map((record) => ({ kind: 'record', collection: 'runs', record }))
      ].map((line) => JSON.stringify(line)).join('\n') + '\n';
      return async function* () { yield lines; };
    };
    const maintenance = {
      now: Date.parse('2026-09-10T00:00:00Z'),
      retentionWindowMs: 30 * 24 * 60 * 60 * 1000,
      maxDatabaseBytes: Number.MAX_SAFE_INTEGER
    };
    const shards = [
      { identity: '1'.repeat(64), runs: [{ id: 'run:expired', observedAt: '2026-01-01T00:00:00Z' }] },
      { identity: '2'.repeat(64), runs: [{ id: 'run:current', observedAt: '2026-09-09T00:00:00Z' }] }
    ];

    for (const { identity, runs } of shards) {
      await ingestNormalizedJsonl(indexedDB, shard(runs)(), {
        ...maintenance,
        deferMaintenance: true,
        payloadIdentity: identity,
        payloadScope: `https://example.test/gh-aw-logs-runs/${identity}.jsonl`,
        expectedPhase: /** @type {const} */ ('runs')
      });
    }

    // Retention must not run per shard: it rescans every canonical store, so
    // paying it once per shard makes a multi-shard import quadratic.
    expect((await readCanonicalBatch(indexedDB)).runs.map(({ id }) => id).sort())
      .toEqual(['run:current', 'run:expired']);
    expect(await readTransactions(indexedDB)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'ingest-normalized-jsonl',
        maintenanceDeferred: true,
        rawRuns: 1
      })
    ]));

    await finalizeNormalizedJsonlIngestion(indexedDB, maintenance);

    expect((await readCanonicalBatch(indexedDB)).runs.map(({ id }) => id)).toEqual(['run:current']);
  });

  it('streams normalized JSONL through multiple bounded writes', async () => {    const records = Array.from({ length: 251 }, (_, index) => ({
      kind: 'record',
      collection: 'repositories',
      record: {
        id: `repository:streamed-${index}`,
        observedAt: '2026-09-09T05:00:00Z',
        provenance: { source: 'test', sourceId: String(index), observedAt: '2026-09-09T05:00:00Z' }
      }
    }));
    const lines = [
      {
        kind: 'metadata',
        schemaVersion: CANONICAL_SCHEMA_VERSION,
        ingestionVersion: 3,
        sourceRecords: records.length,
        phase: 'all',
        records: records.length
      },
      ...records
    ].map((line) => JSON.stringify(line)).join('\n');
    /** @type {{ storedRecords: number, totalRecords: number }[]} */
    const progress = [];
    async function* chunks() { yield lines; }

    const result = await ingestNormalizedJsonl(indexedDB, chunks(), {
      payloadIdentity: 'e'.repeat(64),
      payloadScope: 'https://example.test/gh-aw-logs-normalized/multiple.jsonl',
      onWriteProgress: (value) => progress.push(value)
    });

    expect(result).toMatchObject({ committedBatches: 2, committedRecords: 251 });
    expect(progress).toEqual([
      { storedRecords: 250, totalRecords: 251 },
      { storedRecords: 251, totalRecords: 251 }
    ]);
    expect((await readCanonicalBatch(indexedDB)).repositories).toHaveLength(251);
  });

  it('retries a truncated normalized stream without recording a receipt', async () => {
    const metadata = {
      kind: 'metadata',
      schemaVersion: CANONICAL_SCHEMA_VERSION,
      ingestionVersion: 3,
      sourceRecords: 251,
      phase: 'all',
      records: 251
    };
    const records = Array.from({ length: 251 }, (_, index) => ({
      kind: 'record',
      collection: 'repositories',
      record: {
        id: `repository:retry-${index}`,
        observedAt: '2026-09-09T05:00:00Z',
        provenance: { source: 'test', sourceId: String(index), observedAt: '2026-09-09T05:00:00Z' }
      }
    }));
    const options = {
      payloadIdentity: 'd'.repeat(64),
      payloadScope: 'https://example.test/gh-aw-logs-normalized/retry.jsonl'
    };
    /** @param {Record<string, unknown>[]} values */
    const encode = (values) => values.map((value) => JSON.stringify(value)).join('\n');
    async function* truncated() { yield encode([metadata, ...records.slice(0, 250)]); }
    async function* complete() { yield encode([metadata, ...records]); }

    await expect(ingestNormalizedJsonl(indexedDB, truncated(), options))
      .rejects.toThrow('declared 251 records but contained 250');
    expect(await readTransactions(indexedDB)).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ payloadHash: options.payloadIdentity })
    ]));

    await expect(ingestNormalizedJsonl(indexedDB, complete(), options))
      .resolves.toMatchObject({ committedRecords: 251 });
    expect((await readCanonicalBatch(indexedDB)).repositories).toHaveLength(251);
  });

  it('upserts current sources for immediate canonical queries', async () => {
    await expect(ingestDashboardSources(indexedDB, sources)).resolves.toMatchObject({
      updated: true
    });
    const queries = createCanonicalQueries(indexedDB);
    const repositories = await queries.repositories.list();
    const workflows = await queries.workflows.forRepository(String(repositories[0].id));
    const runs = await queries.runs.forWorkflow(String(workflows[0].id));

    expect(repositories).toHaveLength(1);
    expect(workflows).toHaveLength(1);
    expect(runs).toEqual([expect.objectContaining({ id: 'github:run:githubnext/gh-aw-cao:12345' })]);
    expect(await queries.runs.recentFailures()).toHaveLength(1);
  });

  it('idempotently upserts the same fresh data', async () => {
    await ingestDashboardSources(indexedDB, sources);

    await expect(ingestDashboardSources(indexedDB, sources)).resolves.toMatchObject({
      updated: false,
      skipped: true
    });
    const queries = createCanonicalQueries(indexedDB);
    await expect(queries.repositories.list()).resolves.toHaveLength(1);
    await expect(readTransactions(indexedDB)).resolves.toEqual([
      expect.objectContaining({
        kind: 'ingest-dashboard-sources',
        ingestionVersion: 5,
        payloadHash: expect.stringMatching(/^[a-f0-9]{64}$/)
      })
    ]);
  });

  it('reimports inventory cached before campaign mapping preservation', async () => {
    const bundledSources = {
      ...sources,
      campaigns: {
        rows: [{ campaign: 'dashboard', 'observed-at': metadata['as-of'] }],
        metadata
      },
      workflows: {
        rows: [{ ...sources.workflows.rows[0], campaign: 'dashboard' }],
        metadata
      }
    };
    await ingestDashboardSources(indexedDB, bundledSources);
    const stored = await readCanonicalBatch(indexedDB);
    delete stored.workflows[0].campaignId;
    delete stored.workflows[0].campaign;
    await replaceCanonicalBatch(indexedDB, stored);
    const [transaction] = await readTransactions(indexedDB);
    delete transaction.ingestionVersion;
    await recordTransaction(indexedDB, transaction);

    await expect(ingestDashboardSources(indexedDB, bundledSources)).resolves.toMatchObject({
      updated: true
    });
    await expect(createCanonicalQueries(indexedDB).workflows.list()).resolves.toEqual([
      expect.objectContaining({
        campaignId: 'campaign:dashboard-sources:dashboard',
        campaign: 'dashboard'
      })
    ]);
  });

  it('evicts the oldest run subtree before exceeding the configured database cap', async () => {
    await ingestDashboardSources(indexedDB, sources);
    const stored = await readCanonicalBatch(indexedDB);

    await ingestDashboardSources(indexedDB, sources, {
      maxDatabaseBytes: estimateCanonicalBatchBytes(stored) - 1,
      payloadIdentity: 'cap-policy'
    });

    const capped = await readCanonicalBatch(indexedDB);
    expect(capped.runs).toEqual([]);
    expect(capped.repositories).toHaveLength(1);
    expect(capped.workflows).toHaveLength(1);
  });

  it('rechecks reported IndexedDB usage and evicts runs above 2 GB', async () => {
    const storedSize = estimateCanonicalBatchBytes((await ingestDashboardSources(indexedDB, sources)
      .then(() => readCanonicalBatch(indexedDB))));
    const maxDatabaseBytes = storedSize * 2;
    const estimate = vi.fn()
      .mockResolvedValueOnce({ usage: storedSize, quota: maxDatabaseBytes * 2 })
      .mockResolvedValueOnce({
        usage: maxDatabaseBytes + 1,
        quota: maxDatabaseBytes * 2,
        usageDetails: { indexedDB: maxDatabaseBytes + 1 }
      })
      .mockResolvedValueOnce({
        usage: storedSize,
        quota: maxDatabaseBytes * 2,
        usageDetails: { indexedDB: storedSize }
      });
    const storage = /** @type {StorageManager} */ (/** @type {unknown} */ ({
      estimate,
      persist: vi.fn().mockResolvedValue(true)
    }));

    await ingestDashboardSources(indexedDB, sources, {
      storage,
      maxDatabaseBytes,
      payloadIdentity: 'storage-policy'
    });

    expect((await readCanonicalBatch(indexedDB)).runs).toEqual([]);
    expect(estimate).toHaveBeenCalledTimes(3);
  });

  it('removes newly written records when post-write quota reconciliation shrinks the batch', async () => {
    const maxDatabaseBytes = 1_000_000_000;
    const estimate = vi.fn()
      .mockResolvedValueOnce({ usage: 0, quota: maxDatabaseBytes * 4 })
      .mockResolvedValueOnce({
        usage: maxDatabaseBytes * 3,
        quota: maxDatabaseBytes * 4,
        usageDetails: { indexedDB: maxDatabaseBytes * 3 }
      })
      .mockResolvedValueOnce({
        usage: 0,
        quota: maxDatabaseBytes * 4,
        usageDetails: { indexedDB: 0 }
      });
    const storage = /** @type {StorageManager} */ (/** @type {unknown} */ ({
      estimate,
      persist: vi.fn().mockResolvedValue(true)
    }));

    await ingestDashboardSources(indexedDB, sources, {
      storage,
      maxDatabaseBytes,
      payloadIdentity: 'new-data-storage-policy'
    });

    expect((await readCanonicalBatch(indexedDB)).runs).toEqual([]);
  });

  it('upserts a complete SQL export onto retained canonical records', async () => {
    await ingestDashboardSources(indexedDB, sources);

    await expect(ingestSqlExport(indexedDB, sqlExport)).resolves.toMatchObject({
      updated: true
    });

    const queries = createCanonicalQueries(indexedDB);
    expect((await queries.runs.list()).map((run) => run.id)).toEqual([
      'github:run:githubnext/gh-aw-cao:12345',
      'github:run:githubnext/gh-aw-cao:303'
    ]);
    expect(await queries.audits.forRun('github:run:githubnext/gh-aw-cao:303')).toHaveLength(1);
    expect(await queries.domains.forRun('github:run:githubnext/gh-aw-cao:303')).toHaveLength(1);
  });

  it('upserts complete gh-aw transaction logs onto retained canonical records', async () => {
    await ingestDashboardSources(indexedDB, {
      ...sources,
      campaigns: {
        rows: [{
          campaign: 'dashboard',
          'campaign-name': 'CAO Dashboard',
          'observed-at': metadata['as-of']
        }],
        metadata
      },
      workflows: {
        ...sources.workflows,
        rows: sources.workflows.rows.map((workflow) => ({
          ...workflow,
          campaign: 'dashboard',
          'campaign-name': 'CAO Dashboard',
          'campaign-icon': 'dashboard'
        }))
      }
    });
    const [bundledWorkflow] = await createCanonicalQueries(indexedDB).workflows.list();
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
    expect(await queries.workflows.list()).toEqual([
      expect.objectContaining({
        campaignId: bundledWorkflow.campaignId,
        campaign: 'dashboard',
        campaignName: 'CAO Dashboard',
        campaignIcon: 'dashboard'
      })
    ]);
    expect(activeRuns.map((run) => run.id)).toEqual([
      'github:run:githubnext/gh-aw-cao:12345',
      'github:run:githubnext/gh-aw-cao:303'
    ]);
    expect(await queries.audits.forRun('github:run:githubnext/gh-aw-cao:303')).toEqual([
      expect.objectContaining({ source: 'agent', type: 'agent_turn', sequence: 0 })
    ]);
  });

  it('preserves discovery repository records when ingesting complete gh-aw logs', async () => {
    const discoverySources = structuredClone(sources);
    Object.assign(discoverySources.repositories.rows[0], { visibility: 'private' });
    await ingestDashboardSources(indexedDB, discoverySources);
    const [repositoryBefore] = await createCanonicalQueries(indexedDB).repositories.list();
    const input = {
      generation: 'gh-aw-generation-c',
      observedAt: metadata['as-of'],
      repository: { githubId: '101', owner: 'githubnext', name: 'gh-aw-cao' },
      workflow: { githubId: '202', name: 'Dashboard', path: '.github/workflows/dashboard.md' },
      run: { githubRunId: '303', attempt: 1, status: 'completed', conclusion: 'success' },
      job: { githubJobId: '404', name: 'agent', status: 'completed', conclusion: 'success' },
      files: [{
        path: 'sandbox/agent/logs/copilot-session-state/session-505/events.jsonl',
        content: '{"type":"user.message","timestamp":"2026-09-09T04:00:01Z","data":{}}\n'
      }]
    };

    await ingestGhAwLogs(indexedDB, input);

    const queries = createCanonicalQueries(indexedDB);
    await expect(queries.repositories.list()).resolves.toEqual([repositoryBefore]);
    await expect(queries.runs.list()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'github:run:githubnext/gh-aw-cao:303' })
    ]));
  });

  it('ingests schema-v2 cached JSONL, audits it, and expires stale records', async () => {
    const content = `${JSON.stringify({ schema_version: 2, kind: 'workflow_runs', request: {
      host: 'github.com', repository: 'githubnext/gh-aw-cao', args: ['run', 'list']
    }, payload: [{
      databaseId: 303, attempt: 1, number: 7, workflowName: 'Dashboard',
      displayTitle: 'Build dashboard', event: 'push', status: 'completed', conclusion: 'success',
      headBranch: 'main', headSha: 'abc123', createdAt: '2026-01-01T00:00:00Z',
      startedAt: '2026-01-01T00:00:01Z', updatedAt: '2026-01-01T00:01:00Z',
      url: 'https://github.com/githubnext/gh-aw-cao/actions/runs/303'
    }] })}\n${JSON.stringify({ schema_version: 2, kind: 'run', run: {
      run_id: 303, run_attempt: '1', organization: 'githubnext', repository: 'githubnext/gh-aw-cao',
      workflow_name: 'Dashboard', workflow_path: '.github/workflows/dashboard.md',
      status: 'completed', classification: 'success', created_at: '2026-01-01T00:00:00Z',
      started_at: '2026-01-01T00:00:01Z', updated_at: '2026-01-01T00:01:00Z',
      agent: 'copilot', engine: 'GitHub Copilot CLI',
      aw_info: {
        agent_version: '1.2.3',
        version: '1.2.3',
        cli_version: '0.89.1'
      },
      job_details: [{
        id: 404,
        run_attempt: 1,
        name: 'agent',
        status: 'completed',
        conclusion: 'success',
        created_at: '2026-01-01T00:00:00Z',
        started_at: '2026-01-01T00:00:01Z',
        completed_at: '2026-01-01T00:00:51Z'
      }],
      token_usage_summary: {
        total_aic: 2.5,
        by_model: {
          'gpt-5.4-mini': { aic: 0.5 },
          'gpt-5.4': { aic: 2 }
        }
      },
      audit: {
        mcp_tool_usage: {
          tool_calls: [{
            tool_call_id: 'call-7',
            timestamp: '2026-01-01T00:00:30Z',
            server_name: 'github',
            tool_name: 'get_file',
            input_size: 42,
            output_size: 128,
            status: 'success'
          }]
        }
      },
      url: 'https://github.com/githubnext/gh-aw-cao/actions/runs/303', logs_path: 'logs', event: 'push', branch: 'main'
    } })}\n${JSON.stringify({ schema_version: 2, kind: 'github_api_rate_limit', rate_limit: {
      host: 'github.com',
      start: { limit: 15000, remaining: 15000, reset: 1, used: 0 },
      end: { limit: 15000, remaining: 14990, reset: 2, used: 10 }
    } })}\n`;
    const context = {
      observedAt: '2026-01-01T00:01:00Z',
      repository: { githubId: '101', owner: 'githubnext', name: 'gh-aw-cao' },
      workflow: { githubId: '202', name: 'Dashboard', path: '.github/workflows/dashboard.md' },
      run: { githubRunId: '303', attempt: 1, status: 'completed' }
    };
    await expect(ingestCachedGhAwJsonl(indexedDB, content, {
      now: Date.parse('2026-01-01T00:00:00Z'),
      context
    })).resolves.toMatchObject({
      updated: true,
      records: 3,
      rawRuns: 1,
      agenticRuns: 1,
      mappedRateLimits: 1
    });
    await expect(createCanonicalQueries(indexedDB).runs.list()).resolves.toEqual([
      expect.objectContaining({
        id: 'github:run:githubnext/gh-aw-cao:303',
        repositoryFullName: 'githubnext/gh-aw-cao',
        agentId: 'copilot',
        agentVersion: '1.2.3',
        modelId: 'gpt-5.4',
        resolvedModel: 'gpt-5.4',
        ghAwVersion: '0.89.1',
        aicTotal: 2.5
      })
    ]);
    await expect(createCanonicalQueries(indexedDB).tools.forRun('github:run:githubnext/gh-aw-cao:303')).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: 'mcp',
          type: 'tool.call',
          correlationId: 'call-7',
          summary: 'github/get_file',
          mcpServer: 'github',
          mcpTool: 'get_file'
        }),
        expect.objectContaining({
          source: 'mcp',
          type: 'tool.result',
          correlationId: 'call-7',
          status: 'success'
        })
      ])
    );
    await expect(readTransactions(indexedDB)).resolves.toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^ingest-jsonl:sha256:[a-f0-9]{64}:v4$/),
        kind: 'ingest-jsonl',
        ingestionVersion: 4,
        records: 3,
        payloadHash: expect.stringMatching(/^[a-f0-9]{64}$/)
      })
    ]);
    await expect(ingestCachedGhAwJsonl(indexedDB, content, {
      now: Date.parse('2026-01-02T00:00:00Z'),
      payloadEtag: '"generation-a"',
      context,
      payloadScope: 'renamed-shard.jsonl'
    })).resolves.toMatchObject({ updated: false, skipped: true });
    await expect(readTransactions(indexedDB)).resolves.toEqual([
      expect.objectContaining({ payloadEtag: '"generation-a"' })
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
      'github:run:githubnext/gh-aw-cao:1', 'github:run:githubnext/gh-aw-cao:2'
    ]);
  });

  it('ingests cached JSONL from binary file content', async () => {
    const content = new TextEncoder().encode(`${JSON.stringify({
      schema_version: 2,
      kind: 'run',
      run: {
        run_id: 303,
        run_attempt: 1,
        organization: 'githubnext',
        repository: 'gh-aw-cao',
        workflow_name: 'Dashboard',
        workflow_path: '.github/workflows/dashboard.md',
        status: 'completed',
        created_at: '2026-01-01T00:00:00Z'
      }
    })}\n`);

    await expect(ingestCachedGhAwJsonl(indexedDB, content)).resolves.toMatchObject({
      updated: true,
      records: 1,
      agenticRuns: 1
    });
  });

  it('ingests chunked JSONL across line and UTF-8 boundaries without buffering the response', async () => {
    const content = new TextEncoder().encode([
      '{"schema_version":2,"kind":"unknown","value":"ignored"}',
      JSON.stringify({
        schema_version: 2,
        kind: 'run',
        run: {
          run_id: 303,
          run_attempt: 1,
          organization: 'githubnext',
          repository: 'gh-aw-cao',
          workflow_name: 'Dashboard 📊',
          workflow_path: '.github/workflows/dashboard.md',
          status: 'completed',
          created_at: '2026-01-01T00:00:00Z'
        }
      })
    ].join('\r\n'));
    const chunks = async function* () {
      for (let offset = 0; offset < content.length; offset += 7) {
        yield content.subarray(offset, offset + 7);
      }
    };
    /** @type {{ bytesProcessed: number, linesProcessed: number, recordsIngested: number }[]} */
    const progress = [];

    await expect(ingestCachedGhAwJsonl(indexedDB, chunks(), {
      payloadIdentity: 'published-shard-identity',
      onProgress: (update) => progress.push(update)
    })).resolves.toMatchObject({
      updated: true,
      records: 1,
      agenticRuns: 1,
      timings: {
        parsingMs: expect.any(Number),
        normalizationMs: expect.any(Number),
        storageMs: expect.any(Number)
      }
    });
    expect(progress.at(-1)).toEqual({
      bytesProcessed: content.byteLength,
      linesProcessed: 2,
      recordsIngested: 1
    });
    const duplicate = async function* () {
      yield await Promise.reject(new Error('current streams must not be consumed'));
    };
    await expect(ingestCachedGhAwJsonl(indexedDB, duplicate(), {
      payloadIdentity: 'published-shard-identity'
    })).resolves.toMatchObject({
      updated: false,
      skipped: true
    });
  });

  it('preserves discovery repository records when ingesting cached JSONL runs', async () => {
    const discoverySources = structuredClone(sources);
    Object.assign(discoverySources.repositories.rows[0], { visibility: 'private' });
    await ingestDashboardSources(indexedDB, discoverySources);
    const [repositoryBefore] = await createCanonicalQueries(indexedDB).repositories.list();
    const content = `${JSON.stringify({ schema_version: 2, kind: 'run', run: {
      run_id: 303, run_attempt: '1', organization: 'githubnext', repository: 'gh-aw-cao',
      workflow_name: 'Dashboard', workflow_path: '.github/workflows/dashboard.md',
      status: 'completed', classification: 'success', created_at: metadata['as-of']
    } })}\n`;

    await ingestCachedGhAwJsonl(indexedDB, content, {
      now: Date.parse(metadata['as-of'])
    });

    const queries = createCanonicalQueries(indexedDB);
    await expect(queries.repositories.list()).resolves.toEqual([repositoryBefore]);
    await expect(queries.runs.list()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'github:run:githubnext/gh-aw-cao:303' })
    ]));
  });

  it('preserves campaign mappings when cached workflow runs are imported', async () => {
    await ingestDashboardSources(indexedDB, {
      campaigns: {
        rows: [{
          campaign: 'dashboard',
          'campaign-name': 'CAO Dashboard',
          'observed-at': metadata['as-of']
        }],
        metadata
      },
      repositories: sources.repositories,
      workflows: {
        rows: [{
          ...sources.workflows.rows[0],
          campaign: 'dashboard',
          'campaign-name': 'CAO Dashboard',
          'workflow-id': '501',
          'workflow-name': 'Current registry name',
          'workflow-active': 'unknown',
          'workflow-registry-state': 'unknown',
          'workflow-link': {
            relation: 'workflow',
            href: 'https://github.com/githubnext/gh-aw-cao/actions/workflows/501'
          },
          'created-at': '2026-09-01T00:00:00Z',
          'updated-at': '2026-09-08T00:00:00Z'
        }],
        metadata
      }
    });
    const content = `${JSON.stringify({ schema_version: 2, kind: 'run', run: {
      run_id: 303, run_attempt: '1', organization: 'githubnext', repository: 'gh-aw-cao',
      workflow_name: 'Stale run name', workflow_path: '.github/workflows/dashboard.md',
      status: 'completed', classification: 'success', created_at: '2026-09-09T05:00:00Z'
    } })}\n`;

    await ingestCachedGhAwJsonl(indexedDB, content, {
      now: Date.parse(metadata['as-of'])
    });

    await expect(createCanonicalQueries(indexedDB).workflows.list()).resolves.toEqual([
      expect.objectContaining({
        campaignId: 'campaign:dashboard-sources:dashboard',
        campaign: 'dashboard',
        campaignName: 'CAO Dashboard',
        githubId: '501',
        name: 'Current registry name',
        state: 'unknown',
        registryState: 'unknown',
        workflowLink: {
          relation: 'workflow',
          href: 'https://github.com/githubnext/gh-aw-cao/actions/workflows/501'
        },
        createdAt: '2026-09-01T00:00:00Z',
        updatedAt: '2026-09-08T00:00:00Z'
      })
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
    expect(calls.sort()).toEqual(['estimate', 'estimate', 'persist']);
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

  it('preserves campaign records across imports regardless of the TTL horizon', async () => {
    await ingestDashboardSources(indexedDB, {
      campaigns: {
        rows: [{
          campaign: 'durable-campaign',
          'campaign-name': 'Durable campaign',
          'observed-at': '2025-01-01T00:00:00Z'
        }],
        metadata: { 'as-of': '2025-01-01T00:00:00Z' }
      }
    }, {
      now: Date.parse('2025-01-01T00:00:00Z')
    });

    await ingestDashboardSources(indexedDB, sources, {
      now: Date.parse('2026-09-09T05:00:00Z')
    });

    await expect(createCanonicalQueries(indexedDB).campaigns.list()).resolves.toEqual([
      expect.objectContaining({ slug: 'durable-campaign', name: 'Durable campaign' })
    ]);
  });

  it('reapplies a previously seen payload after a newer payload', async () => {
    const refreshed = structuredClone(sources);
    Object.assign(refreshed.repositories.rows[0], { visibility: 'private' });
    await ingestDashboardSources(indexedDB, sources);
    await ingestDashboardSources(indexedDB, refreshed);

    await expect(ingestDashboardSources(indexedDB, sources)).resolves.toMatchObject({ updated: true });
    await expect(createCanonicalQueries(indexedDB).repositories.list()).resolves.toEqual([
      expect.objectContaining({ visibility: 'unknown' })
    ]);
  });

  it('publishes daily overview aggregates from the ingested canonical batch', async () => {
    await ingestDashboardSources(indexedDB, sources);

    const result = await readDailyOverviewAggregates(indexedDB, { startDay: '2026-09-01', endDay: '2026-09-30' });

    expect(result.available).toBe(true);
    expect(result.records).toEqual([
      expect.objectContaining({ day: '2026-09-09', runs: 1, successfulRuns: 0, failedRuns: 1 })
    ]);
  });

  it('republishes an updated daily overview aggregate generation on reingestion without leaving a stale one active', async () => {
    await ingestDashboardSources(indexedDB, sources);
    const refreshed = structuredClone(sources);
    refreshed.runs.rows.push({
      organization: 'githubnext',
      repository: 'gh-aw-cao',
      workflow: '.github/workflows/dashboard.md',
      run: '12346',
      'run-attempt': 1,
      'run-status': 'completed',
      'run-conclusion': 'success',
      'started-at': '2026-09-10T04:00:00Z',
      'ended-at': metadata['as-of']
    });

    await ingestDashboardSources(indexedDB, refreshed);

    const result = await readDailyOverviewAggregates(indexedDB, { startDay: '2026-09-01', endDay: '2026-09-30' });
    expect(result.available).toBe(true);
    expect(result.records).toEqual([
      expect.objectContaining({ day: '2026-09-09', runs: 1 }),
      expect.objectContaining({ day: '2026-09-10', runs: 1, successfulRuns: 1 })
    ]);
  });
});