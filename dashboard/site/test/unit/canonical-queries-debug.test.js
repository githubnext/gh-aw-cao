import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ingestCachedGhAwJsonl, ingestDashboardSources } from '../../src/data/ingest/coordinator.js';
import { DATABASE_NAME } from '../../src/data/storage/indexeddb.js';

const CAMPAIGN_METADATA = { 'as-of': '2026-09-09T05:00:00Z' };

const JSONL_CONTENT = `${JSON.stringify({ schema_version: 2, kind: 'run', run: {
  run_id: 303, run_attempt: '1', organization: 'githubnext', repository: 'githubnext/gh-aw-cao',
  workflow_name: 'Dashboard', workflow_path: '.github/workflows/dashboard.md',
  status: 'completed', conclusion: 'failure', created_at: '2026-01-01T00:00:00Z',
  started_at: '2026-01-01T00:00:01Z', updated_at: '2026-01-01T00:01:00Z',
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
} })}\n`;

const CONTEXT = {
  observedAt: '2026-01-01T00:01:00Z',
  repository: { githubId: '101', owner: 'githubnext', name: 'gh-aw-cao' },
  workflow: { githubId: '202', name: 'Dashboard', path: '.github/workflows/dashboard.md' },
  run: { githubRunId: '303', attempt: 1, status: 'completed' }
};

beforeEach(async () => {
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE_NAME);
    request.onsuccess = () => resolve(undefined);
    request.onerror = () => reject(request.error);
  });
  await ingestDashboardSources(indexedDB, {
    campaigns: {
      rows: [{
        campaign: 'durable-campaign',
        'campaign-name': 'Durable campaign',
        'observed-at': CAMPAIGN_METADATA['as-of']
      }],
      metadata: CAMPAIGN_METADATA
    }
  }, { now: Date.parse(CAMPAIGN_METADATA['as-of']) });
  await ingestCachedGhAwJsonl(indexedDB, JSONL_CONTENT, {
    now: Date.parse('2026-01-01T00:00:00Z'),
    context: CONTEXT
  });
});

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

describe('canonical queries debug logging', () => {
  it('is disabled by default (no debug output) when the debug query is absent', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) => actual.createDebug(category, { search: () => '', output })
      };
    });
    vi.resetModules();
    const { createCanonicalQueries } = await import('../../src/data/queries/index.js');
    const queries = createCanonicalQueries(indexedDB);

    await queries.campaigns.getBySlug('durable-campaign');
    await queries.runs.recentFailures();
    await queries.tools.forRun('github:run:githubnext/gh-aw-cao:303');

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs campaign lookup, recent-failures, and run-linked query outcomes under its predictable category when enabled', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=data:queries', output })
      };
    });
    vi.resetModules();
    const { createCanonicalQueries } = await import('../../src/data/queries/index.js');
    const queries = createCanonicalQueries(indexedDB);

    await queries.campaigns.getBySlug('durable-campaign');
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:data:queries]',
      { event: 'campaign-by-slug', found: true }
    );

    output.debug.mockClear();
    await queries.campaigns.getBySlug('missing-campaign');
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:data:queries]',
      { event: 'campaign-by-slug', found: false }
    );

    output.debug.mockClear();
    const failures = await queries.runs.recentFailures();
    expect(failures.length).toBeGreaterThan(0);
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:data:queries]',
      { event: 'recent-failures', count: failures.length }
    );

    output.debug.mockClear();
    const toolRows = await queries.tools.forRun('github:run:githubnext/gh-aw-cao:303');
    expect(toolRows.length).toBeGreaterThan(0);
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:data:queries]',
      { event: 'for-run', collection: 'tools', count: toolRows.length }
    );
  });

  it('never logs sensitive payload content, only scalar metadata', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=data:queries', output })
      };
    });
    vi.resetModules();
    const { createCanonicalQueries } = await import('../../src/data/queries/index.js');
    const queries = createCanonicalQueries(indexedDB);

    await queries.campaigns.getBySlug('durable-campaign');
    await queries.runs.recentFailures();
    await queries.tools.forRun('github:run:githubnext/gh-aw-cao:303');

    expect(output.debug.mock.calls.length).toBeGreaterThan(0);
    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean').toBe(true);
      }
      expect(JSON.stringify(payload)).not.toContain('durable-campaign');
      expect(JSON.stringify(payload)).not.toContain('githubnext/gh-aw-cao');
      expect(JSON.stringify(payload)).not.toContain('call-7');
    }
  });
});
