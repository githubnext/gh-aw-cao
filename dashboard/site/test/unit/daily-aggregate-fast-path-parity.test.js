import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { executeDashboardQueries } from '../../src/data/queries/declarative.js';
import { queryDailyOverviewAggregateSources } from '../../src/data/queries/daily-aggregate-fast-path.js';
import { buildDailyOverviewAggregates } from '../../src/data/analytics/daily-overview-aggregates.js';
import { ingestDashboardSources } from '../../src/data/ingest/coordinator.js';
import { DATABASE_NAME, publishDailyOverviewAggregates, readCanonicalBatch } from '../../src/data/storage/indexeddb.js';

const dashboardDocument = JSON.parse(readFileSync(`${process.cwd()}/dashboard.json`, 'utf8'));
const dashboardQueries = dashboardDocument.dashboard.queries;

/** @type {import('../../src/presenter.js').SourceMetadata} */
const runsMetadata = /** @type {import('../../src/presenter.js').SourceMetadata} */ ({
  'source-id': 'runs',
  'source-kind': 'published',
  'as-of': '2026-09-21T00:00:00Z',
  'retrieved-at': '2026-09-21T00:00:00Z',
  completeness: 'complete',
  freshness: 'fresh',
  availability: 'available'
});

/**
 * Canonical run records shaped as `buildDailyOverviewAggregates` (and
 * ingestion) consume them.
 * @param {Partial<Record<string, unknown>>} overrides
 */
function canonicalRun(overrides) {
  return {
    id: 'run-1',
    event: 'schedule',
    conclusion: 'success',
    startedAt: '2026-09-10T00:00:00Z',
    createdAt: '2026-09-10T00:00:00Z',
    ...overrides
  };
}

/**
 * Projects a canonical run into the kebab-case logical row shape the
 * canonical query path (`view-sources.js`'s `projectedRun`) produces, using
 * only the fields `overview-dispatch-summary` reads.
 * @param {ReturnType<typeof canonicalRun>} run
 */
function projectedRunRow(run) {
  return {
    run: run.id,
    event: run.event,
    'run-conclusion': run.conclusion,
    'started-at': run.startedAt,
    'created-at': run.createdAt
  };
}

describe('daily-aggregate fast path parity with canonical execution', () => {
  it('produces identical rows to canonical execution for overview-dispatch-summary', async () => {
    const runs = [
      canonicalRun({ id: 'r1', event: 'workflow_dispatch', conclusion: 'success', startedAt: '2026-09-10T01:00:00Z' }),
      canonicalRun({ id: 'r2', event: 'workflow_dispatch', conclusion: 'failure', startedAt: '2026-09-10T02:00:00Z' }),
      canonicalRun({ id: 'r3', event: 'workflow_dispatch', conclusion: 'timed-out', startedAt: '2026-09-11T00:00:00Z' }),
      canonicalRun({ id: 'r4', event: 'schedule', conclusion: 'success', startedAt: '2026-09-11T00:00:00Z' }),
      canonicalRun({ id: 'r5', event: 'workflow_dispatch', conclusion: 'success', startedAt: '2026-09-12T00:00:00Z' })
    ];

    // Canonical path: execute the real dashboard.json query definition
    // against logical rows shaped the way the canonical projection produces
    // them.
    const canonicalResult = executeDashboardQueries(
      dashboardQueries,
      { runs: { source: 'runs', rows: runs.map(projectedRunRow), metadata: runsMetadata } },
      ['overview-dispatch-summary']
    );

    // Fast path: materialize the same runs into the daily aggregate
    // projection and let the query planner sum it.
    const indexedDB = new IDBFactory();
    const dailyAggregates = buildDailyOverviewAggregates(runs);
    await publishDailyOverviewAggregates(indexedDB, {
      generation: 'generation-a',
      builtAt: '2026-09-21T00:00:00Z',
      dailyAggregates
    });
    const fastPathResult = await queryDailyOverviewAggregateSources(
      indexedDB,
      dashboardQueries,
      ['overview-dispatch-summary']
    );

    expect(fastPathResult['overview-dispatch-summary'].rows).toEqual(canonicalResult['overview-dispatch-summary'].rows);
  });

});

describe('daily-aggregate fast path parity end-to-end through real ingestion', () => {
  beforeEach(async () => {
    await new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(DATABASE_NAME);
      request.onsuccess = () => resolve(undefined);
      request.onerror = () => reject(request.error);
    });
  });

  it('serves overview-dispatch-summary from the fast path after a real ingestion, matching canonical execution', async () => {
    const metadata = { 'as-of': '2026-09-21T00:00:00Z', 'artifact-generation': 'generation-a' };
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
        rows: [
          {
            organization: 'githubnext', repository: 'gh-aw-cao', workflow: '.github/workflows/dashboard.md',
            run: '1', 'run-attempt': 1, event: 'workflow_dispatch', 'run-status': 'completed',
            'run-conclusion': 'success', 'started-at': '2026-09-10T01:00:00Z', 'ended-at': metadata['as-of']
          },
          {
            organization: 'githubnext', repository: 'gh-aw-cao', workflow: '.github/workflows/dashboard.md',
            run: '2', 'run-attempt': 1, event: 'workflow_dispatch', 'run-status': 'completed',
            'run-conclusion': 'failure', 'started-at': '2026-09-10T02:00:00Z', 'ended-at': metadata['as-of']
          },
          {
            organization: 'githubnext', repository: 'gh-aw-cao', workflow: '.github/workflows/dashboard.md',
            run: '3', 'run-attempt': 1, event: 'schedule', 'run-status': 'completed',
            'run-conclusion': 'stale', 'started-at': '2026-09-11T00:00:00Z', 'ended-at': metadata['as-of']
          },
          {
            organization: 'githubnext', repository: 'gh-aw-cao', workflow: '.github/workflows/dashboard.md',
            run: '4', 'run-attempt': 1, event: 'schedule', 'run-status': 'completed',
            'run-conclusion': 'success', 'started-at': '2026-09-11T00:00:00Z', 'ended-at': metadata['as-of']
          }
        ],
        metadata
      }
    };

    // Real ingestion: normalization, canonical persistence, and
    // ingestion-time daily overview aggregate publication (spec §72.5) all
    // run exactly as they do in production — no fixture is hand-published.
    await ingestDashboardSources(indexedDB, sources);

    // Canonical path: read the same canonical batch back and execute the
    // real dashboard.json query definitions against it.
    const batch = await readCanonicalBatch(indexedDB);
    const canonicalRows = batch.runs.map((run) => ({
      run: String(run.githubRunId ?? ''),
      event: run.event,
      'run-conclusion': run.conclusion,
      'started-at': run.startedAt,
      'created-at': run.createdAt
    }));
    const canonicalResult = executeDashboardQueries(
      dashboardQueries,
      { runs: { source: 'runs', rows: canonicalRows, metadata: runsMetadata } },
      ['overview-dispatch-summary']
    );

    // Fast path: query the aggregates ingestion already published, with no
    // additional publication step.
    const fastPathResult = await queryDailyOverviewAggregateSources(
      indexedDB,
      dashboardQueries,
      ['overview-dispatch-summary']
    );

    expect(Object.keys(fastPathResult)).toEqual(['overview-dispatch-summary']);
    expect(fastPathResult['overview-dispatch-summary'].rows).toEqual(canonicalResult['overview-dispatch-summary'].rows);
    expect(fastPathResult['overview-dispatch-summary'].rows).toEqual([{ dispatches: 2, 'failed-dispatches': 1 }]);
  });
});
