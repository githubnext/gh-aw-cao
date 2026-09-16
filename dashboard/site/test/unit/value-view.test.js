// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { processDataRequest } from '../../src/data-worker.js';
import { renderDashboard } from '../../src/presenter.js';

const document = JSON.parse(readFileSync(`${process.cwd()}/dashboard.json`, 'utf8'));
const metadata = {
  'source-id': 'value-fixture',
  'source-kind': 'fixture',
  'as-of': '2026-09-16T00:00:00Z',
  'retrieved-at': '2026-09-16T00:01:00Z',
  completeness: /** @type {'complete'} */ ('complete'),
  freshness: /** @type {'fresh'} */ ('fresh'),
  availability: /** @type {'available'} */ ('available')
};

describe('Value dashboard view', () => {
  it('attributes workflow operational value to packages', () => {
    const result = /** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */ (processDataRequest({
      operation: 'execute-dashboard-queries',
      queries: document.dashboard.queries,
      sourceNames: ['workflow-operational-values', 'package-operational-value-totals'],
      sources: {
        workflows: {
          source: 'workflows',
          rows: [
            { organization: 'githubnext', repository: 'alpha', package: 'doctor', 'package-name': 'Doctor', workflow: 'doctor.md', 'workflow-name': 'Doctor worker', 'workflow-role': 'worker' },
            { organization: 'githubnext', repository: 'beta', package: 'maintenance', 'package-name': 'Maintenance', workflow: 'maintenance.md', 'workflow-name': 'Maintenance worker', 'workflow-role': 'worker' }
          ],
          metadata
        },
        'operational-values': {
          source: 'operational-values',
          rows: [
            { organization: 'githubnext', repository: 'alpha', workflow: 'doctor.md', 'operational-value': 0.8 },
            { organization: 'githubnext', repository: 'alpha', workflow: 'doctor.md', 'operational-value': 0.7 },
            { organization: 'githubnext', repository: 'beta', workflow: 'maintenance.md', 'operational-value': 0.5 }
          ],
          metadata
        }
      }
    }));

    expect(result['workflow-operational-values'].rows).toEqual([
      expect.objectContaining({ package: 'doctor', repository: 'githubnext/alpha', 'workflow-name': 'Doctor worker', 'value-created': 1.5 }),
      expect.objectContaining({ package: 'maintenance', repository: 'githubnext/beta', 'workflow-name': 'Maintenance worker', 'value-created': 0.5 })
    ]);
    expect(result['package-operational-value-totals'].rows).toEqual([
      { package: 'doctor', 'package-name': 'Doctor', 'value-created': 1.5 },
      { package: 'maintenance', 'package-name': 'Maintenance', 'value-created': 0.5 }
    ]);
  });

  it('renders a package pie chart and workflow value table', async () => {
    const workflowRows = [
      { package: 'doctor', 'package-name': 'Doctor', repository: 'githubnext/alpha', workflow: 'worker.md', 'workflow-name': 'Doctor worker', 'workflow-role': 'worker', 'value-created': 1.5 }
    ];
    const rendered = renderDashboard({
      document,
      sources: {
        'package-operational-value-totals': {
          source: 'package-operational-value-totals',
          rows: [{ package: 'doctor', 'package-name': 'Doctor', 'value-created': 1.5 }],
          metadata
        },
        'workflow-operational-values': {
          source: 'workflow-operational-values',
          rows: workflowRows,
          metadata
        }
      }
    });
    const link = /** @type {HTMLAnchorElement | null} */ (rendered.querySelector('[data-nav-page-id="operational-value"]'));
    link?.click();
    await vi.waitFor(() => {
      expect(rendered.querySelector('[data-page-id="operational-value"]')?.hasAttribute('data-page-pending')).toBe(false);
    });
    const page = rendered.querySelector('[data-page-id="operational-value"]');
    const configuredPage = document.dashboard.pages.find(
      (/** @type {{ id: string }} */ candidate) => candidate.id === 'operational-value'
    );

    expect(configuredPage.views).toEqual([
      expect.objectContaining({ id: 'operational-value-by-package', mark: 'chart', chart: 'pie', data: { source: 'package-operational-value-totals' } }),
      expect.objectContaining({ id: 'operational-value-by-workflow', mark: 'table', data: { source: 'workflow-operational-values' } })
    ]);
    expect(page?.querySelector('[data-view-id="operational-value-by-package"] [data-chart-widget="pie"]')).not.toBeNull();
    expect(page?.querySelector('[data-view-id="operational-value-by-workflow"] tbody')?.textContent).toContain('Doctor worker');
    expect(page?.querySelector('[data-field="value-created"]')?.textContent).toContain('1.50');
    rendered.remove();
  });
});
