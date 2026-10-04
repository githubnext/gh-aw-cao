import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const metadata = { 'as-of': '2026-09-09T05:00:00Z', 'artifact-generation': 'generation-a' };
const sources = {
  repositories: {
    rows: [{ organization: 'githubnext', repository: 'gh-aw-cao', 'observed-at': metadata['as-of'] }],
    metadata
  },
  campaigns: {
    rows: [{ campaign: 'self-care', 'campaign-name': 'SelfCare', 'observed-at': metadata['as-of'] }],
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
  }
};

beforeEach(() => {
  indexedDB.deleteDatabase('cao-dashboard-canonical');
});

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

describe('canonical queries index debug logging', () => {
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
    const { ingestDashboardSources: ingest } = await import('../../src/data/ingest/coordinator.js');
    const { createCanonicalQueries } = await import('../../src/data/queries/index.js');

    await ingest(indexedDB, sources);
    const queries = createCanonicalQueries(indexedDB);
    await queries.campaigns.getBySlug('self-care');
    await queries.runs.recentFailures();
    const [run] = await queries.runs.list();
    await queries.tools.forRun(String(run.id));

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs predictable, privacy-preserving metadata at each query boundary under its category', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=queries:index', output })
      };
    });
    vi.resetModules();
    const { ingestDashboardSources: ingest } = await import('../../src/data/ingest/coordinator.js');
    const { createCanonicalQueries } = await import('../../src/data/queries/index.js');

    await ingest(indexedDB, sources);
    const queries = createCanonicalQueries(indexedDB);

    const found = await queries.campaigns.getBySlug('self-care');
    expect(found).not.toBeNull();
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:queries:index]',
      { event: 'campaigns.get-by-slug', found: true }
    );

    output.debug.mockClear();
    const missing = await queries.campaigns.getBySlug('nonexistent-campaign');
    expect(missing).toBeNull();
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:queries:index]',
      { event: 'campaigns.get-by-slug', found: false }
    );

    output.debug.mockClear();
    const failures = await queries.runs.recentFailures();
    expect(failures).toHaveLength(1);
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:queries:index]',
      { event: 'runs.recent-failures', count: 1 }
    );

    output.debug.mockClear();
    const [run] = await queries.runs.list();
    const tools = await queries.tools.forRun(String(run.id));
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:queries:index]',
      { event: 'run-linked.for-run', collection: 'tools', count: tools.length }
    );

    // Never log sensitive identifiers (run IDs, slugs) or row contents.
    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      const serialized = JSON.stringify(payload);
      expect(serialized).not.toContain('self-care');
      expect(serialized).not.toContain(String(run.id));
      expect(serialized).not.toContain('gh-aw-cao');
    }
  });
});
