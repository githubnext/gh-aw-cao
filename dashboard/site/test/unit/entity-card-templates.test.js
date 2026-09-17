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
      'session',
      'event',
      'operation'
    ]));
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
      const marketplaceQuery = dashboard.queries.find(
        (/** @type {Record<string, any>} */ query) => query.name === 'marketplace-operations'
      );
      expect(marketplaceQuery).toMatchObject({
        from: 'workflows',
        aggregate: {
          by: expect.arrayContaining(['operation-id', 'operation-name', 'operation-link'])
        },
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
    expect(pages['run-events'].views).toEqual(['run-sessions', 'run-events']);
  });

  it('drills from sessions to events and specializes GitHub entity events', () => {
    expect(views['entity-sessions'].list.drill).toEqual({
      type: 'query',
      page: 'session-events',
      query: 'entity-events',
      'title-field': 'session',
      arguments: [{ name: 'session', field: 'session' }]
    });
    expect(views['session-events']).toMatchObject({
      data: {
        source: 'entity-events',
        arguments: [{ name: 'session', field: 'session' }]
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
