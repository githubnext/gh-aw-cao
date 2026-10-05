import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { executeDashboardQueries } from '../../src/data/queries/declarative.js';

/** @type {{ rows: Array<Record<string, unknown>>, cases: Array<{ name: string, window: import('../../src/data-operations.js').WindowField[], fields: string[], expected: Array<Array<number|null>> }> }} */
const fixture = JSON.parse(readFileSync(resolve(process.cwd(), '../../server/internal/query/testdata/window-parity.json'), 'utf8'));

describe('shared browser and Go observation-window parity fixtures', () => {
  for (const testCase of fixture.cases) {
    it(testCase.name, () => {
      const query = { name: 'window-parity', from: 'usage', window: testCase.window };
      /** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */
      const sources = {
        usage: {
          source: 'usage',
          rows: fixture.rows,
          metadata: {
            'source-id': 'usage',
            'source-kind': 'published',
            'as-of': '2026-01-01T00:00:06Z',
            'retrieved-at': '2026-01-01T00:00:06Z',
            completeness: 'complete',
            freshness: 'fresh',
            availability: 'available'
          }
        }
      };
      const output = executeDashboardQueries([query], sources)[query.name].rows;
      expect(output.map((row) => row.id)).toEqual(fixture.rows.map((row) => row.id));
      expect(output.map((row) => testCase.fields.map((field) => row[field]))).toEqual(testCase.expected);
    });
  }
});
