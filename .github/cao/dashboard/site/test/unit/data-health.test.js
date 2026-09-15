import { describe, expect, it } from 'vitest';
import { deriveDataHealthSources } from '../../src/data-health.js';

const metadata = /** @type {import('../../src/presenter.js').SourceMetadata} */ ({
  'source-id': 'fixture',
  'source-kind': 'fixture',
  'as-of': '2026-09-03T12:00:00Z',
  'retrieved-at': '2026-09-03T12:01:00Z',
  completeness: 'complete',
  freshness: 'fresh',
  availability: 'available'
});

/** @param {string} name @param {Array<Record<string, any>>} rows @param {Record<string, any>} [overrides] @returns {any} */
function source(name, rows, overrides = {}) {
  return { source: name, rows, metadata: { ...metadata, ...overrides } };
}

/** @returns {Record<string, any>} */
function completeSources() {
  const entity = { organization: 'acme', repository: 'app' };
  const run = { ...entity, workflow: '.github/workflows/agent.md', run: '42' };
  return {
    organizations: source('organizations', [{ organization: 'acme' }]),
    repositories: source('repositories', [entity], { 'coverage-expected': 1, 'coverage-observed': 1 }),
    workflows: source('workflows', [{
      ...entity,
      workflow: run.workflow,
      'gh-aw-version': '0.90.0',
      'gh-aw-current-version': '0.90.0',
      'gh-aw-metadata': {}
    }], { 'coverage-expected': 1, 'coverage-observed': 1 }),
    runs: source('runs', [run], { 'coverage-expected': 1, 'coverage-observed': 1 }),
    usage: source('usage', [run]),
    'run-performance': source('run-performance', [run]),
    'job-performance': source('job-performance', [run]),
    'mcp-calls': source('mcp-calls', []),
    'mcp-servers': source('mcp-servers', []),
    'security-observations': source('security-observations', [run]),
    'detection-observations': source('detection-observations', [run]),
    'firewall-observations': source('firewall-observations', [run]),
    'firewall-policy-rules': source('firewall-policy-rules', [run]),
    'safe-output-performance': source('safe-output-performance', [run]),
    outcomes: source('outcomes', [run]),
    findings: source('findings', []),
    'operational-values': source('operational-values', []),
    'configuration-policy': source('configuration-policy', [{ path: '.github/workflows/cao.json' }]),
    'configuration-summary': source('configuration-summary', []),
    'configuration-actions': source('configuration-actions', [])
  };
}

describe('coverage and collection provenance', () => {
  it('calculates authoritative expected-versus-observed coverage', () => {
    const sources = completeSources();
    sources.workflows.metadata['coverage-expected'] = 100;
    sources.workflows.metadata['coverage-observed'] = 99;
    const row = deriveDataHealthSources(sources)['data-health-coverage'].rows.find((item) => item.area === 'Workflows');
    expect(row).toMatchObject({ expected: 100, observed: 99, missing: 1, 'coverage-percent': '99%', state: 'partial' });
  });

  it('never presents an unknown denominator as complete or 100%', () => {
    const sources = completeSources();
    delete sources.repositories.metadata['coverage-expected'];
    const row = deriveDataHealthSources(sources)['data-health-coverage'].rows.find((item) => item.area === 'Repositories');
    expect(row).toMatchObject({ expected: 'Unknown', missing: 'Unknown', 'coverage-percent': 'Unknown', state: 'unknown' });
  });

  it('distinguishes complete zero activity from missing collection', () => {
    const sources = completeSources();
    sources.runs.rows = [];
    sources.runs.metadata['run-records-expected'] = 0;
    sources.runs.metadata['run-records-observed'] = 0;
    let row = /** @type {any} */ (deriveDataHealthSources(sources)['data-health-coverage'].rows.find((item) => item.area === 'Runs'));
    expect(row).toMatchObject({ expected: 0, observed: 0, 'coverage-percent': '100%', state: 'complete' });

    sources.runs.metadata.availability = 'unavailable';
    delete sources.runs.metadata['coverage-observed'];
    row = /** @type {any} */ (deriveDataHealthSources(sources)['data-health-collections'].rows.find((item) => item.source === 'runs'));
    expect(row.state).toBe('failed');
  });

  it('does not confuse a fresh collector with an incomplete evidence horizon', () => {
    const sources = completeSources();
    Object.assign(sources.usage.metadata, {
      'requested-coverage-start': '2026-08-04T12:00:00Z',
      'requested-coverage-end': '2026-09-03T12:00:00Z',
      'coverage-start': '2026-09-01T12:00:00Z',
      'coverage-end': '2026-09-03T12:00:00Z',
      'collector-completed-at': '2026-09-03T12:01:00Z'
    });
    const row = /** @type {any} */ (deriveDataHealthSources(sources)['data-health-coverage'].rows.find((item) => item.area === 'Usage telemetry'));
    expect(row.state).toBe('unknown');
    expect(row.reason).toContain('horizon');
  });

  it('discloses rate limits, interrupted pagination, artifact failure, and stale fallback', () => {
    const sources = completeSources();
    Object.assign(sources.runs.metadata, {
      completeness: 'partial',
      'collection-state': 'partial',
      'failure-class': 'rate-limit',
      'collection-progress': '10 of 12 pages',
      'fallback-used': true,
      'snapshot-age-seconds': 7200
    });
    const row = deriveDataHealthSources(sources)['data-health-collections'].rows.find((item) => item.source === 'runs');
    expect(row).toMatchObject({
      state: 'partial',
      'failure-class': 'rate-limit',
      progress: '10 of 12 pages',
      fallback: 'stale snapshot',
      'snapshot-age': '7200 seconds'
    });
  });
});

describe('data shape preview', () => {
  it('infers a recursive schema merged across sampled rows, marking optional and mixed-type fields', () => {
    const sources = completeSources();
    sources.runs.rows = [
      { organization: 'acme', repository: 'app', run: '42', attempts: 1, labels: ['flaky'], meta: { retries: 1 } },
      { organization: 'acme', repository: 'app', run: '43', attempts: '2', labels: [], extra: true }
    ];
    const schema = /** @type {any} */ (deriveDataHealthSources(sources)['data-health-schema'].rows.find((item) => item.source === 'runs'));
    expect(schema.source).toBe('runs');
    expect(schema.schema).toContain('attempts: number | string');
    expect(schema.schema).toContain('labels: string[]');
    expect(schema.schema).toContain('extra?: boolean');
    expect(schema.schema).toContain('meta?: { retries: number }');
  });

  it('detects and breaks reference cycles instead of recursing without bound', () => {
    const sources = completeSources();
    const cyclicRow = /** @type {Record<string, any>} */ ({ organization: 'acme', repository: 'app' });
    cyclicRow.self = cyclicRow;
    sources.runs.rows = [cyclicRow];
    const schema = /** @type {any} */ (deriveDataHealthSources(sources)['data-health-schema'].rows.find((item) => item.source === 'runs'));
    expect(schema.schema).toContain('self: (circular)');
  });

  it('reports an empty-object shape when a source has no cached rows', () => {
    const sources = completeSources();
    sources.runs.rows = [];
    const schema = /** @type {any} */ (deriveDataHealthSources(sources)['data-health-schema'].rows.find((item) => item.source === 'runs'));
    expect(schema.schema).toBe('{}');
  });
});
