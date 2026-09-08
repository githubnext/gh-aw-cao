// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderDashboard } from '../../src/presenter.js';

describe('linked text refactor behavior preservation', () => {
  it('preserves derived links in declarative workflow inventory tables', () => {
    const document = {
      languageVersion: '0.1.0',
      dashboard: {
        id: 'workflow-topology-links-dashboard',
        title: 'Workflow Topology Links',
        pages: [
          { id: 'workflows', kind: /** @type {'built-in'} */ ('built-in'), page: 'workflows', title: 'Workflows' },
          {
            id: 'repository-detail',
            kind: /** @type {'custom'} */ ('custom'),
            title: 'Repository',
            route: { 'hash-query-parameter': 'repository' },
            views: []
          },
          {
            id: 'workflow-runtime',
            kind: /** @type {'custom'} */ ('custom'),
            title: 'Workflow runtime',
            route: { 'hash-query-parameter': 'workflow' },
            views: []
          }
        ]
      }
    };

    const rendered = renderDashboard({
      document,
      sources: {
        workflows: {
          source: 'workflows',
          rows: [
            { organization: 'githubnext', repository: 'gh-aw-cao', package: 'dependabot', 'package-name': 'Dependabot', workflow: '.github/workflows/dependabot.yml', 'workflow-name': 'Dependabot', 'workflow-role': 'orchestrator', 'workflow-active': 'true', 'rollout-mode': 'live' },
            { organization: 'github', repository: 'target-service', workflow: '.github/workflows/ci.yml', 'workflow-name': 'CI', 'workflow-role': 'standalone', 'workflow-active': 'true', 'rollout-mode': 'unknown' }
          ],
          metadata: {
            'source-id': 'workflow-topology-links-fixture',
            'source-kind': 'fixture',
            'as-of': '2026-08-30T08:00:00Z',
            'retrieved-at': '2026-08-30T08:01:00Z',
            completeness: 'complete',
            freshness: 'fresh',
            availability: 'available'
          }
        }
      }
    });

    expect(rendered.outerHTML).toContain('id="workflows-workflows-heading"');
    expect(rendered.querySelectorAll('[data-page-name="workflows"] tbody tr')).toHaveLength(2);
    const packageLink = rendered.querySelector('a[href="#page-package-insights?package=dependabot"]');
    expect(packageLink?.textContent).toBe('Dependabot');
    expect(packageLink?.getAttribute('aria-label')).toBe('View Dependabot package dashboard');
    expect(rendered.outerHTML).toContain('href="#page-repository-detail?repository=github%2Ftarget-service"');
    expect(rendered.outerHTML).toContain('href="#page-workflow-runtime?workflow=github%2Ftarget-service%3A.github%2Fworkflows%2Fci.yml"');
  });
});
