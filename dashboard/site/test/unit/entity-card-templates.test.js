// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const document = JSON.parse(readFileSync(`${process.cwd()}/dashboard.json`, 'utf8'));
const dashboard = document.dashboard;
const templates = Object.fromEntries(dashboard['card-templates'].map(
  (/** @type {Record<string, any>} */ template) => [template.id, template]
));
const views = Object.fromEntries(dashboard.views.map(
  (/** @type {Record<string, any>} */ view) => [view.id, view]
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
      title: { field: 'run-title' },
      labels: [{ field: 'branch', display: 'ref' }],
      timing: [
        { field: 'started-at', icon: 'calendar' },
        { field: 'duration', icon: 'stopwatch' }
      ]
    });
    const runQuery = dashboard.queries.find((/** @type {Record<string, any>} */ query) => query.name === 'entity-runs');
    const selected = runQuery.select.map((/** @type {Record<string, any>} */ field) => field.field);
    expect(selected).toEqual(expect.arrayContaining(['run-title', 'branch', 'event', 'duration', 'started-at']));
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
    const entityQuery = dashboard.queries.find(
      (/** @type {Record<string, any>} */ query) => query.name === 'entity-workflows'
    );
    const entityFields = entityQuery.select.map((/** @type {Record<string, any>} */ field) => field.as ?? field.field);
    expect(entityFields).toEqual(expect.arrayContaining(['runs', 'successful-runs', 'failed-runs', 'aic-per-run']));
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

  it('declares the operation marketplace as a worker-queried card grid', () => {
      expect(templates.operation).toMatchObject({
        icon: 'workflow',
        'icon-field': 'operation-icon',
        title: { field: 'operation-name' },
        subtitle: { field: 'operation-description' }
      });
      const marketplaceGroupQuery = dashboard.queries.find(
        (/** @type {Record<string, any>} */ query) => query.name === 'marketplace-operation-groups'
      );
      expect(marketplaceGroupQuery).toMatchObject({
        from: 'workflows',
        aggregate: {
          by: expect.arrayContaining(['operation-id', 'operation-name', 'operation-dashboard-href'])
        }
      });
      const marketplaceQuery = dashboard.queries.find(
        (/** @type {Record<string, any>} */ query) => query.name === 'marketplace-operations'
      );
      expect(marketplaceQuery).toMatchObject({
        from: 'marketplace-operation-groups',
        joins: [
          {
            source: 'repositories',
            type: 'left',
            on: [
              { left: 'organization', right: 'organization' },
              { left: 'repository', right: 'repository' }
            ],
            fields: [{ field: 'repository-link', as: 'repository-link' }]
          }
        ],
        compute: expect.arrayContaining([
          expect.objectContaining({
            as: 'operation-link',
            function: 'dashboard-link',
            args: expect.arrayContaining([{ field: 'repository-link' }])
          })
        ]),
        'order-by': [
          { field: 'operation-kind', direction: 'asc' },
          { field: 'operation-name', direction: 'asc' }
        ]
      });
      expect(pages.agents.views[0]).toMatchObject({
        data: { source: 'marketplace-operations' },
        mark: 'list',
        list: {
          style: 'entity-cards',
          layout: 'grid',
          card: 'operation',
          drill: { type: 'external', field: 'operation-link' }
        }
    });
  });

  it('drills from repositories through workflows and runs to events', () => {
    expect(views['entity-repositories'].list).toMatchObject({
      card: 'repository',
      drill: {
        type: 'query',
        page: 'repository-workflows',
        query: 'entity-workflows',
        arguments: [
          { name: 'organization', field: 'organization' },
          { name: 'repository', field: 'repository' }
        ]
      }
    });
    expect(views['repository-workflows'].data.arguments).toEqual([
      { name: 'organization', field: 'organization' },
      { name: 'repository', field: 'repository' }
    ]);
    expect(views['repository-workflows'].list.drill).toMatchObject({
      page: 'workflow-run-cards',
      query: 'entity-runs'
    });
    expect(views['workflow-runs-cards'].list.drill).toMatchObject({
      page: 'run-events',
      query: 'entity-events'
    });
    expect(pages['run-events'].views).toEqual(['run-events']);
  });

  it('specializes GitHub entity events', () => {
    expect(views['run-events']).toMatchObject({
      data: {
        source: 'entity-events',
        arguments: expect.arrayContaining([{ name: 'run', field: 'run' }])
      },
      list: {
        card: 'event',
        drill: { type: 'external', field: 'event-url' }
      }
    });
    expect(views.issues.list).toMatchObject({
      card: 'issue',
      drill: { type: 'external', field: 'entity-url' }
    });
    expect(views['pull-requests'].list).toMatchObject({
      card: 'pull-request',
      drill: { type: 'external', field: 'entity-url' }
    });
  });
});
