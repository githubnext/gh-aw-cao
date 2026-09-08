// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { parseWorkflowRoute, workflowRouteValue } from '../../src/components/workflow-route.js';
import { selectConfigBody } from '../../src/components/route-body-composition.js';
import { createRouteBodyConfig } from '../../src/components/route-body-config.js';
import { WORKFLOW_ROUTE_BODY_VALUES, WORKFLOW_ROUTE_PAGE_BODY_VALUES } from '../../src/components/route-body-specification.js';
import { workflowRoutePageConfigForBody } from '../../src/components/workflow-route-page-config.js';

describe('workflow-route helpers', () => {
  it('formats and parses valid workflow routes', () => {
    const value = workflowRouteValue('githubnext/gh-aw-cao', '.github/workflows/ambient-context.md');

    expect(value).toBe('githubnext/gh-aw-cao:.github/workflows/ambient-context.md');
    expect(parseWorkflowRoute(value)).toEqual({
      repository: 'githubnext/gh-aw-cao',
      workflow: '.github/workflows/ambient-context.md'
    });
  });

  it('rejects invalid, missing, and unavailable workflow route inputs', () => {
    expect(parseWorkflowRoute(null)).toBeNull();
    expect(parseWorkflowRoute('')).toBeNull();
    expect(parseWorkflowRoute('githubnext/gh-aw-cao')).toBeNull();
    expect(parseWorkflowRoute('<invalid>')).toBeNull();
    expect(parseWorkflowRoute('githubnext/gh-aw-cao:.github/workflows/../ambient-context.md')).toBeNull();
    expect(parseWorkflowRoute('githubnext/gh-aw-cao:.github/workflows/ambient-context.yml')).toBeNull();
    expect(parseWorkflowRoute(`githubnext/gh-aw-cao:.github/workflows/ambient-context.md${String.fromCharCode(10)}`)).toBeNull();
  });

  it('normalizes declarative workflow route bodies with a shared fallback contract', () => {
    const config = {
      values: WORKFLOW_ROUTE_BODY_VALUES,
      fallback: 'reports'
    };

    expect(selectConfigBody(config, 'runs')).toBe('runs');
    expect(selectConfigBody(config, 'invalid')).toBe('reports');
    expect(selectConfigBody(config, null)).toBe('reports');
  });

  it('keeps workflow-route-page body values aligned with workflow-route values', () => {
    expect(WORKFLOW_ROUTE_PAGE_BODY_VALUES).toEqual(WORKFLOW_ROUTE_BODY_VALUES);
  });

  it('derives workflow-route-page navigation from canonical body values', () => {
    expect(workflowRoutePageConfigForBody('insights')).toEqual({
      body: 'insights',
      pageId: 'workflow-runtime'
    });
    expect(workflowRoutePageConfigForBody('reports')).toEqual({
      body: 'reports',
      pageId: 'workflow-detail'
    });
    expect(workflowRoutePageConfigForBody('runs')).toEqual({
      body: 'runs',
      pageId: 'workflow-runs'
    });
    expect(workflowRoutePageConfigForBody('invalid')).toEqual({
      body: 'reports',
      pageId: 'workflow-detail'
    });
  });

  it('reuses canonical route body selection helpers across declarative route elements', () => {
    const config = createRouteBodyConfig(/** @type {const} */ (['reports', 'runs']), 'reports');

    expect(config.body('runs')).toBe('runs');
    expect(config.body('invalid')).toBe('reports');
    expect(config.composition({ reports: 'report-view', runs: 'runs-view' }, 'runs')).toBe('runs-view');
    expect(config.composition({ reports: 'report-view', runs: 'runs-view' }, null)).toBe('report-view');
  });
});
