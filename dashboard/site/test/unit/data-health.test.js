import { describe, expect, it } from 'vitest';
import { deriveDataHealthSources, evidenceConfidence } from '../../src/data-health.js';

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

describe('data health confidence', () => {
  it.each([
    [{ availability: 'available', completeness: 'complete', freshness: 'fresh' }, 'trusted'],
    [{ availability: 'available', completeness: 'partial', freshness: 'fresh' }, 'degraded'],
    [{ availability: 'available', completeness: 'complete', freshness: 'stale' }, 'degraded'],
    [{ availability: 'unavailable', completeness: 'complete', freshness: 'fresh' }, 'insufficient'],
    [{ availability: 'available', completeness: 'unknown', freshness: 'fresh' }, 'unknown']
  ])('keeps availability, completeness, and freshness independent: %j', (state, expected) => {
    expect(evidenceConfidence(state)).toBe(expected);
  });

  it('trusts complete, fresh, compatible, reconciled critical evidence', () => {
    const derived = deriveDataHealthSources(completeSources());
    expect(derived['data-health-summary'].rows[0]).toMatchObject({
      confidence: 'trusted',
      availability: 'available',
      completeness: 'complete',
      freshness: 'fresh'
    });
    expect(derived['data-health-domains'].rows.every((row) => row.confidence === 'trusted')).toBe(true);
  });

  it('reports critical collection failure as insufficient and stale partial evidence as degraded', () => {
    const failed = completeSources();
    failed.runs.metadata.availability = 'unavailable';
    failed.runs.metadata['failure-class'] = 'rate-limit';
    expect(deriveDataHealthSources(failed)['data-health-summary'].rows[0].confidence).toBe('insufficient');

    const stale = completeSources();
    stale.usage.metadata.freshness = 'stale';
    stale.usage.metadata.completeness = 'partial';
    expect(deriveDataHealthSources(stale)['data-health-summary'].rows[0].confidence).toBe('degraded');
  });

  it('keeps missing critical scope and state unknown', () => {
    const sources = completeSources();
    sources.repositories.metadata.completeness = 'unknown';
    expect(deriveDataHealthSources(sources)['data-health-summary'].rows[0].confidence).toBe('unknown');
  });
});

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

describe('producer compatibility and reconciliation', () => {
  it('classifies current, legacy, unsupported, and unknown producers without penalizing legacy optional fields', () => {
    const sources = completeSources();
    const base = { organization: 'acme', repository: 'app', 'gh-aw-current-version': '0.90.0' };
    sources.workflows.rows = [
      { ...base, workflow: 'current', 'gh-aw-version': '0.90.0', 'gh-aw-metadata': {} },
      { ...base, workflow: 'legacy', 'gh-aw-version': '0.80.0' },
      { ...base, workflow: 'unsupported', 'gh-aw-version': '1.0.0' },
      { ...base, workflow: 'unknown' }
    ];
    const rows = /** @type {Array<Record<string, any>>} */ (deriveDataHealthSources(sources)['data-health-compatibility'].rows);
    expect(rows.map((row) => [row.workflow.split(':').at(-1), row.compatibility, row['missing-field-class']])).toEqual([
      ['current', 'compatible', 'none'],
      ['legacy', 'limited', 'expected'],
      ['unsupported', 'unsupported', 'none'],
      ['unknown', 'unknown', 'none']
    ]);
  });

  it('marks required fields missing from a current producer as unexpected', () => {
    const sources = completeSources();
    delete sources.workflows.rows[0]['gh-aw-metadata'];
    expect(deriveDataHealthSources(sources)['data-health-compatibility'].rows[0]).toMatchObject({
      compatibility: 'limited',
      'missing-fields': 'gh-aw-metadata',
      'missing-field-class': 'unexpected'
    });
  });

  it('detects silent stable-identifier gaps and preserves unknown denominators', () => {
    const sources = completeSources();
    sources.usage.rows = [];
    let row = deriveDataHealthSources(sources)['data-health-reconciliation'].rows.find((item) => item.relationship === 'Runs → usage');
    expect(row).toMatchObject({ expected: 1, observed: 0, missing: 1, coverage: '0%', state: 'partial' });

    sources.runs.metadata.completeness = 'unknown';
    row = deriveDataHealthSources(sources)['data-health-reconciliation'].rows.find((item) => item.relationship === 'Runs → usage');
    expect(row).toMatchObject({ expected: 'Unknown', coverage: 'Unknown', state: 'unknown' });
  });
});
