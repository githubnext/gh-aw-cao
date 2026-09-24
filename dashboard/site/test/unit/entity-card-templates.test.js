// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const document = JSON.parse(readFileSync(`${process.cwd()}/dashboard.json`, 'utf8'));
const dashboard = document.dashboard;
const templates = Object.fromEntries(dashboard['card-templates'].map(
  (/** @type {Record<string, any>} */ template) => [template.id, template]
));
const pages = Object.fromEntries(dashboard.pages.map(
  (/** @type {Record<string, any>} */ page) => [page.id, page]
));

describe('entity card templates', () => {
  it('declares cards for every navigable canonical entity', () => {
    expect(Object.keys(templates)).toEqual(expect.arrayContaining([
      'repository',
      'workflow',
      'run',
      'event',
      'campaign',
      'operation'
    ]));
  });

  it('declares the factory campaign cards in JSON', () => {
    expect(templates.campaign).toMatchObject({
      icon: 'goal',
      title: { field: 'campaign-name' },
      labels: [
        { field: 'modes', display: 'label' }
      ],
      details: [
        { field: 'dispatches', title: '# dispatches' },
        { field: 'value-created', title: '# value', unit: 'ops-value' },
        { field: 'aic', title: '# aic', unit: 'aic' }
      ]
    });
    expect(templates.campaign.details).not.toContainEqual(expect.objectContaining({ field: 'runs' }));
    expect(pages.overview.views.find(
      (/** @type {Record<string, any>} */ view) => view.id === 'overview-campaigns'
    )).toMatchObject({
      data: { sources: ['overview-campaign-links'] },
      mark: 'element',
      element: 'link-button-list',
      config: {
        'label-field': 'campaign-name',
        'link-field': 'campaign-dashboard-link',
        'icon-field': 'campaign-icon',
        'fallback-icon': 'goal'
      }
    });
    expect(pages.campaigns.definition.views.find(
      (/** @type {Record<string, any>} */ view) => view.id === 'campaigns-inventory'
    )).toMatchObject({
      title: 'Campaigns',
      data: { source: 'campaign-inventory' },
      mark: 'table'
    });
  });

  it('presents runs like a GitHub Actions run row', () => {
    expect(templates.run).toMatchObject({
      status: { field: 'run-conclusion', 'fallback-field': 'run-status' },
      title: { field: 'workflow', format: 'workflow-relative-path' },
      subtitle: { field: 'target-repository' },
      labels: [
        { field: 'run-status', title: 'Status', display: 'label' },
        { field: 'run-conclusion', title: 'Outcome', display: 'label' },
        { field: 'branch', display: 'ref' }
      ],
      timing: [
        { field: 'started-at', icon: 'calendar' },
        { field: 'duration', icon: 'stopwatch' }
      ]
    });
    const runQuery = dashboard.queries.find((/** @type {Record<string, any>} */ query) => query.name === 'runs-table');
    const selected = runQuery.select.map((/** @type {Record<string, any>} */ field) => field.field);
    expect(selected).toEqual(expect.arrayContaining(['run', 'run-status', 'run-conclusion', 'repository-coordinate', 'rollout-mode', 'run-link']));
  });

  it('presents workflow inventory cards with identity and run outcome totals', () => {
    expect(templates.workflow).toMatchObject({
      icon: 'workflow',
      title: { field: 'workflow-name' },
      subtitle: { field: 'workflow', format: 'workflow-relative-path' },
      details: expect.arrayContaining([
        { field: 'successful-runs', title: 'Success' },
        { field: 'failed-runs', title: 'Failures' },
        { field: 'aic-per-run', title: 'Average AIC', unit: 'aic-per-run' }
      ])
    });
    expect(templates.workflow.details).not.toContainEqual({ field: 'runs', title: 'Runs' });
    const inventoryQuery = dashboard.queries.find(
      (/** @type {Record<string, any>} */ query) => query.name === 'workflow-inventory'
    );
    const selected = inventoryQuery.select.map((/** @type {Record<string, any>} */ field) => field.as ?? field.field);
    expect(selected).toEqual(expect.arrayContaining(['workflow-name', 'workflow', 'runs', 'successful-runs', 'failed-runs', 'aic-per-run']));
    const inventoryView = pages.workflows.definition.views.find(
      (/** @type {Record<string, any>} */ view) => view.id === 'workflows-inventory'
    );
    const columns = inventoryView.encoding.columns.map((/** @type {Record<string, any>} */ field) => field.field);
    expect(columns).toEqual(expect.arrayContaining(['workflow-name', 'workflow', 'runs', 'successful-runs', 'failed-runs', 'aic-per-run']));
  });

  it('declares a firewall domain card with allowed and blocked metrics', () => {
    expect(templates['firewall-domain']).toEqual({
      id: 'firewall-domain',
      icon: 'globe',
      title: { field: 'domain', title: 'Domain' },
      labels: [],
      details: [
        { field: 'accepted', title: 'Allowed' },
        { field: 'blocked', title: 'Blocked' },
        { field: 'run', title: 'Runs' }
      ]
    });
  });

  it('retains the reusable operation card template', () => {
    expect(templates.operation).toMatchObject({
      icon: 'workflow',
      'icon-field': 'operation-icon',
      title: { field: 'operation-name' },
      subtitle: { field: 'operation-description' }
    });
  });

  it('removes unreachable reusable entity drill views', () => {
    expect(dashboard.views).toBeUndefined();
    expect(pages['repository-workflows']).toBeUndefined();
    expect(pages['workflow-run-cards']).toBeUndefined();
    expect(pages['run-events']).toBeUndefined();
  });

  it('removes unreachable entity event queries', () => {
    expect(dashboard.queries.some((/** @type {{ name: string }} */ query) => query.name === 'entity-events')).toBe(false);
  });
});
