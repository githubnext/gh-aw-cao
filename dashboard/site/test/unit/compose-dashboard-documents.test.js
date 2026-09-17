import { describe, expect, it } from 'vitest';

import { composeDashboardDocuments } from '../../../report/compose-dashboard-documents.mjs';
import { splitDashboardDocument } from '../../src/dashboard-chunks.js';

/** @param {string} id @param {string} queryName @param {string} source */
function document(id, queryName, source) {
  return {
    'language-version': '0.1.0',
    dashboard: {
      id,
      title: id,
      queries: [{ name: queryName, from: source }],
      pages: [{
        id,
        kind: 'custom',
        title: id,
        views: [{
          id: `${id}-view`,
          data: { source: queryName },
          mark: 'table',
          encoding: { columns: [{ field: 'id', type: 'nominal' }] }
        }]
      }],
      navigation: [{ label: 'Data', pages: [id] }]
    }
  };
}

describe('composeDashboardDocuments', () => {
  it('retains package queries in the page chunk', () => {
    const composed = composeDashboardDocuments(
      document('primary', 'primary-query', 'runs'),
      [document('package-page', 'package-query', 'outcomes')]
    );

    expect(composed.dashboard.queries.map((query) => query.name)).toEqual([
      'primary-query',
      'package-query'
    ]);

    const split = splitDashboardDocument(composed);
    expect(split.pageChunks.get('package-page')?.queries).toEqual([
      { name: 'package-query', from: 'outcomes' }
    ]);
  });

  it('rejects duplicate query names', () => {
    expect(() => composeDashboardDocuments(
      document('primary', 'shared-query', 'runs'),
      [document('package-page', 'shared-query', 'outcomes')]
    )).toThrow('duplicate dashboard query name: shared-query');
  });
});
