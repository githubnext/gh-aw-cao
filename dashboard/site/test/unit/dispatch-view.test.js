// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderDashboard } from '../../src/presenter.js';

const dashboard = JSON.parse(readFileSync(`${process.cwd()}/dashboard.json`, 'utf8'));
const dispatchPage = dashboard.dashboard.pages.find((/** @type {{ id: string }} */ page) => page.id === 'dispatches');
const metadata = {
  'source-id': 'fixture',
  'source-kind': 'fixture',
  'as-of': '2026-08-30T08:00:00Z',
  'retrieved-at': '2026-08-30T08:01:00Z',
  completeness: /** @type {'complete'} */ ('complete'),
  freshness: /** @type {'fresh'} */ ('fresh'),
  availability: /** @type {'available'} */ ('available')
};

describe('declarative dispatch view', () => {
  it('renders dispatch JSON through the generic table and cell elements', () => {
    const rendered = renderDashboard({
      document: {
        languageVersion: '0.1.0',
        dashboard: {
          id: 'dispatch-test',
          title: 'Dispatch test',
          pages: [dispatchPage]
        }
      },
      sources: {
        workflows: {
          source: 'workflows',
          metadata,
          rows: [
            { organization: 'githubnext', repository: 'control', workflow: 'worker.yml', 'workflow-name': 'Dependency updater', 'workflow-role': 'worker', package: 'dependabot', 'package-name': 'Dependabot' }
          ]
        },
        runs: {
          source: 'runs',
          metadata,
          rows: [
            { organization: 'githubnext', repository: 'control', workflow: 'worker.yml', run: '3', event: 'workflow_dispatch', 'run-title': 'Update dependencies', 'started-at': '2026-08-30T07:00:00Z', 'run-conclusion': 'action-required', 'run-link': { relation: 'run', href: 'https://github.com/githubnext/control/actions/runs/3', label: 'Run 3' } }
          ]
        }
      }
    });

    const dispatchTable = dispatchPage.views.find((/** @type {{ id: string }} */ view) => view.id === 'package-worker-dispatches');
    expect(dispatchPage.views).toHaveLength(1);
    expect(dispatchPage.sections).toBeUndefined();
    expect(dispatchTable).toMatchObject({
      mark: 'table',
      controls: 'interactive',
      'lazy-list': true,
      layout: 'full-view',
      data: { source: 'dispatches' },
      encoding: {
        href: { field: 'run-link' }
      }
    });
    const pageFilter = /** @type {HTMLInputElement | null} */ (rendered.querySelector('.filter-bar input'));
    expect(pageFilter?.value).toBe('');
    const tables = rendered.querySelectorAll('table');
    expect(tables).toHaveLength(1);
    expect([...tables[0].querySelectorAll('thead tr:first-child th')].map((cell) => cell.textContent)).toEqual([
      'Started',
      'Type',
      'Package',
      'Workflow',
      'Run title',
      'Runtime repository',
      'Status',
      'Why'
    ]);
    expect(rendered.textContent).toContain('Package worker');
    expect(rendered.textContent).toContain('Update dependencies');
    expect(rendered.querySelector('table')?.className).toBe('custom-table');
    expect(rendered.querySelector('.status-attention')).not.toBeNull();
    expect(rendered.querySelector('.table-summary-temporal')?.textContent).toContain('StartAug 30, 2026, 7:00 AM');
    expect(rendered.querySelector('.table-summary-temporal')?.textContent).toContain('StopAug 30, 2026, 7:00 AM');
    expect(rendered.querySelector('.table-summary-temporal')?.textContent).toContain('Duration0s');
    expect(rendered.querySelector('.table-filter input[type="search"]')?.getAttribute('placeholder')).toBe('Filter rows');
    const started = rendered.querySelector('tbody td time');
    expect(started?.getAttribute('datetime')).toBe('2026-08-30T07:00:00Z');
    expect(started?.textContent).toBe('Aug 30, 2026, 7:00 AM');
    expect(rendered.querySelector('tbody td a[href="https://github.com/githubnext/control/actions/runs/3"]')).not.toBeNull();
    expect(rendered.querySelector('a[href="https://github.com/githubnext/control/blob/HEAD/worker.yml"]')?.textContent).toBe('Dependency updater');
    expect(rendered.querySelector('a[href="https://github.com/githubnext/control"]')?.textContent).toBe('githubnext/control');
  });
});
