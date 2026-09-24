// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { findMissingStaticDashboardReferences } from '../../scripts/dashboard-static-references.mjs';
import { validateDashboardDocument } from '../../src/validator.js';

const document = {
  'language-version': '0.1.0',
  dashboard: {
    id: 'static-references',
    title: 'Static references',
    queries: [{ name: 'summary', from: 'runs' }],
    views: [{
      id: 'summary-view',
      data: { source: 'summary' },
      mark: 'element',
      element: 'outcomes-overview'
    }],
    pages: [{
      id: 'overview',
      kind: 'custom',
      title: 'Overview',
      views: ['summary-view']
    }],
    navigation: [{ label: 'Overview', pages: ['overview'] }]
  }
};

describe('dashboard static references', () => {
  it('accepts declared source links and registered elements', () => {
    expect(findMissingStaticDashboardReferences(document, {
      linkedPageIds: ['overview'],
      registeredElementIds: ['outcomes-overview']
    })).toEqual([]);
  });

  it('reports source links to pruned pages and pruned element renderers', () => {
    expect(findMissingStaticDashboardReferences(document, {
      linkedPageIds: ['overview', 'campaign-insights'],
      registeredElementIds: []
    })).toEqual([
      'dashboard references unregistered element "outcomes-overview"',
      'source link references missing page "campaign-insights"'
    ]);
  });

  it('relies on language validation for pruned reusable views and queries', () => {
    const missingView = structuredClone(document);
    missingView.dashboard.views = [];
    expect(validateDashboardDocument(JSON.stringify(missingView)).ok).toBe(false);

    const missingQuery = structuredClone(document);
    missingQuery.dashboard.queries = [];
    expect(validateDashboardDocument(JSON.stringify(missingQuery)).ok).toBe(false);
  });
});
