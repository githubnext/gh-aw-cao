import { describe, expect, it } from 'vitest';
import { deriveDataHealthSources } from '../../src/data-health.js';

const sourceMetadata = {
  'source-id': 'fixture',
  'source-kind': 'fixture',
  'as-of': '2026-09-03T12:00:00Z',
  'retrieved-at': '2026-09-03T12:01:00Z',
  completeness: 'complete',
  freshness: 'fresh',
  availability: 'available'
};

describe('offline data shape preview', () => {
  it('infers a recursive schema merged across sampled rows', () => {
    const rows = [
      { attempts: 1, labels: ['flaky'], meta: { retries: 1 } },
      { attempts: '2', labels: [], extra: true }
    ];
    const result = deriveDataHealthSources({
      runs: { rows, metadata: sourceMetadata }
    });
    const schema = result['data-health-schema'].rows[0];

    expect(schema.source).toBe('runs');
    expect(schema.schema).toContain('attempts: number | string');
    expect(schema.schema).toContain('labels: string[]');
    expect(schema.schema).toContain('extra?: boolean');
    expect(schema.schema).toContain('meta?: { retries: number }');
    expect(result).not.toHaveProperty('data-health-collections');
    expect(result).not.toHaveProperty('data-health-coverage');
  });

  it('detects and breaks reference cycles instead of recursing without bound', () => {
    const row = /** @type {Record<string, unknown>} */ ({});
    row.self = row;
    const result = deriveDataHealthSources({
      runs: { rows: [row], metadata: sourceMetadata }
    });

    expect(result['data-health-schema'].rows[0].schema).toContain('self: (circular)');
  });

  it('reports an empty-object shape when a source has no cached rows', () => {
    const result = deriveDataHealthSources({
      runs: { rows: [], metadata: sourceMetadata }
    });

    expect(result['data-health-schema'].rows[0].schema).toBe('{}');
  });
});
