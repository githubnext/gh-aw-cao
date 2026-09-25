import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  dashboardPages,
  deadElementRendererNames,
  deadDashboardPages,
  elementRendererNames,
  pageViewNames,
  referencedPageNames,
  referencedElementNames
} from '../../scripts/render-dead-views.mjs';

describe('dead element view analysis', () => {
  it('reads names from the element renderer registry', () => {
    const source = `
      const ELEMENT_RENDERERS = new Map([
        ['summary-grid', renderSummaryGrid],
        ["signal-list", renderSignalList]
      ]);
    `;

    expect(elementRendererNames(source)).toEqual(['summary-grid', 'signal-list']);
  });

  it('finds element views recursively', () => {
    const document = {
      dashboard: {
        pages: [
          { views: [{ mark: 'element', element: 'summary-grid' }] },
          { views: [{ mark: 'table', element: 'not-an-element-view' }] }
        ],
        reusable: {
          mark: 'element',
          element: 'signal-list'
        }
      }
    };

    expect([...referencedElementNames(document)]).toEqual(['summary-grid', 'signal-list']);
  });

  it('returns registered renderers that no dashboard references', () => {
    expect(deadElementRendererNames(
      ['summary-grid', 'signal-list', 'context-summary'],
      ['summary-grid', 'context-summary']
    )).toEqual(['signal-list']);
  });

  it('finds page references from navigation, tabs, and hash links', () => {
    const document = {
      dashboard: {
        navigation: [{ pages: ['overview'] }],
        callouts: [{ 'navigation-page': 'issues' }],
        pages: [{
          id: 'overview',
          route: {
            tabs: [{ page: 'overview' }, { page: 'repositories' }]
          },
          views: [{
            config: { 'view-all-page': 'runs' },
            'dashboard-href': '#page-workflows?workflow=ci'
          }]
        }]
      }
    };

    expect([...referencedPageNames(document)].sort()).toEqual([
      'issues',
      'overview',
      'repositories',
      'runs',
      'workflows'
    ]);
  });

  it('returns unreferenced non-routed dashboard pages and their views', () => {
    const document = {
      dashboard: {
        navigation: [{ pages: ['overview'] }],
        pages: [
          { id: 'overview', kind: 'custom', views: [] },
          { id: 'run-detail', kind: 'custom', route: { 'hash-query-parameter': 'run' }, views: [] },
          { id: 'attention-detail', kind: 'custom', route: { 'navigation-page': 'overview' }, views: [] },
          { id: 'unlinked-static-route', kind: 'custom', route: { tabs: [] }, views: [] },
          {
            id: 'usage',
            kind: 'built-in',
            definition: { views: [{ id: 'usage-by-model' }, { id: 'usage-usage-source' }] }
          },
          {
            id: 'findings',
            kind: 'built-in',
            definition: { views: [{ id: 'findings-by-severity' }, { id: 'findings-source' }] }
          }
        ]
      }
    };

    const deadPages = deadDashboardPages(dashboardPages(document), referencedPageNames(document));
    expect(deadPages.map((page) => page.id)).toEqual(['unlinked-static-route', 'usage', 'findings']);
    expect(pageViewNames(deadPages[1])).toEqual(['usage-by-model', 'usage-usage-source']);
    expect(pageViewNames(deadPages[2])).toEqual(['findings-by-severity', 'findings-source']);
  });

  it('keeps the production element registry reachable from the dashboard document', () => {
    const rendererSource = readFileSync(
      resolve(process.cwd(), 'src/components/ui-elements.js'),
      'utf8'
    );
    const dashboard = JSON.parse(readFileSync(
      resolve(process.cwd(), 'dashboard.json'),
      'utf8'
    ));

    expect(deadElementRendererNames(
      elementRendererNames(rendererSource),
      referencedElementNames(dashboard)
    )).toEqual([]);
  });

});
