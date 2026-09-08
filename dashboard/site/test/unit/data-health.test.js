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
  it('summarizes available data and reports per-field shape statistics', () => {
    const sources = completeSources();
    sources.runs.rows = [
      { organization: 'acme', repository: 'app', workflow: 'agent', run: '42', attempts: 1 },
      { organization: 'acme', repository: 'app', workflow: 'agent', run: '43', attempts: '2', conclusion: null }
    ];
    const derived = deriveDataHealthSources(sources);
    const summary = derived['data-health-summary'].rows[0];
    const attempts = derived['data-health-fields'].rows.find((item) => item.source === 'runs' && item.field === 'attempts');
    const conclusion = derived['data-health-fields'].rows.find((item) => item.source === 'runs' && item.field === 'conclusion');
    const runsFile = derived['data-health-files'].rows.find((item) => item.source === 'runs');

    expect(summary).toMatchObject({
      sources: Object.keys(sources).length,
      'available-sources': Object.keys(sources).length
    });
    expect(summary.rows).toBeGreaterThan(0);
    expect(summary.fields).toBe(derived['data-health-fields'].rows.length);
    expect(attempts).toMatchObject({ types: 'number, string', rows: 2, populated: 2, empty: 0, coverage: '100%', shape: 'mixed' });
    expect(conclusion).toMatchObject({ types: 'Unknown', rows: 2, populated: 0, empty: 2, coverage: '0%', shape: 'unknown' });
    expect(runsFile).toMatchObject({ file: 'runs.json', rows: 2, status: 'available' });
    expect(runsFile?.size).toBeGreaterThan(0);
    expect(runsFile?.['display-size']).toMatch(/^\d+(?:\.\d)? (?:B|KB|MB|GB|TB)$/);
    const fileSizes = /** @type {number[]} */ (derived['data-health-files'].rows.map((row) => row.size));
    expect(fileSizes).toEqual(fileSizes.toSorted((left, right) => right - left));
    expect(summary['total-size']).toMatch(/^\d+(?:\.\d)? (?:B|KB|MB|GB|TB)$/);
  });

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

describe('data shape preview', () => {
  it('infers a recursive schema merged across sampled rows, marking optional and mixed-type fields', () => {
    const sources = completeSources();
    sources.runs.rows = [
      { organization: 'acme', repository: 'app', run: '42', attempts: 1, labels: ['flaky'], meta: { retries: 1 } },
      { organization: 'acme', repository: 'app', run: '43', attempts: '2', labels: [], extra: true }
    ];
    const rows = deriveDataHealthSources(sources)['data-health-schema'].rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].source).toBe('Dashboard data shapes');
    const schema = JSON.parse(String(rows[0].schema));
    expect(schema.runs[0]).toMatch(/^\/\/ 2 items \(schema sampled from first up to \d+\)$/);
    expect(schema.runs[1].attempts).toBe('number | string');
    expect(schema.runs[1].labels).toEqual(['// 0-1 items', 'string']);
    expect(schema.runs[1]['extra?']).toBe('boolean');
    expect(schema.runs[1]['meta?']).toEqual({ retries: 'number' });
  });

  it('detects and breaks reference cycles instead of recursing without bound', () => {
    const sources = completeSources();
    const cyclicRow = /** @type {Record<string, any>} */ ({ organization: 'acme', repository: 'app' });
    cyclicRow.self = cyclicRow;
    sources.runs.rows = [cyclicRow];
    const schema = JSON.parse(String(deriveDataHealthSources(sources)['data-health-schema'].rows[0].schema));
    expect(schema.runs).toEqual([
      expect.stringMatching(/^\/\/ 1 item \(schema sampled from first up to \d+\)$/),
      expect.objectContaining({ self: '(circular)' })
    ]);
  });

  it('does not treat shared non-cyclic objects as circular in file diagnostics', () => {
    const sources = completeSources();
    const shared = { retries: 1 };
    sources.runs.rows = [{ shared }, { shared }];
    const expectedSize = new TextEncoder().encode(JSON.stringify(sources.runs)).length;
    const file = deriveDataHealthSources(sources)['data-health-files'].rows.find((item) => item.source === 'runs');
    expect(file?.size).toBe(expectedSize);
  });

  it('reports an empty-object shape when a source has no cached rows', () => {
    const sources = completeSources();
    sources.runs.rows = [];
    const schema = JSON.parse(String(deriveDataHealthSources(sources)['data-health-schema'].rows[0].schema));
    expect(schema.runs).toEqual(['// 0 items']);
  });
});

describe('CAO Activity debugging link', () => {
  it('links the data health summary to the CAO Activity workflow when repository context is known', () => {
    const sources = completeSources();
    const summary = deriveDataHealthSources(sources, {
      githubUrlBase: 'https://github.com',
      dashboardRepository: 'acme/app'
    })['data-health-summary'].rows[0];
    expect(summary['external-link']).toEqual({
      href: 'https://github.com/acme/app/actions/workflows/activity.yml',
      label: 'CAO Activity'
    });
  });

  it('omits the activity link when repository context is unavailable', () => {
    const sources = completeSources();
    const summary = deriveDataHealthSources(sources)['data-health-summary'].rows[0];
    expect(summary['external-link']).toBeNull();
  });

  it('normalizes a trailing slash in the GitHub URL base', () => {
    const summary = deriveDataHealthSources(completeSources(), {
      githubUrlBase: 'https://github.com/',
      dashboardRepository: 'acme/app'
    })['data-health-summary'].rows[0];
    expect(summary['external-link']).toEqual({
      href: 'https://github.com/acme/app/actions/workflows/activity.yml',
      label: 'CAO Activity'
    });
  });
});
