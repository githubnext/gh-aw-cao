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
const queries = Object.fromEntries(dashboard.queries.map(
  (/** @type {Record<string, any>} */ query) => [query.name, query]
));

describe('entity card templates', () => {
  it('declares cards for every navigable canonical entity', () => {
    expect(Object.keys(templates)).toEqual(expect.arrayContaining([
      'repository',
      'workflow',
      'run',
      'session',
      'event'
    ]));
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

  it('routes workflow, run, MCP, and firewall pages through stored-query cards', () => {
    expect(pages.workflows.definition.views).toEqual(['workflow-inventory-cards']);
    expect(pages.runs.definition.views).toEqual(['entity-runs']);
    expect(pages.mcps.views).toEqual(['mcp-tool-observations']);
    expect(pages.firewall.views).toEqual(['firewall-domain-observations']);

    expect(views['workflow-inventory-cards']).toMatchObject({
      data: { source: 'workflow-inventory' },
      list: {
        style: 'entity-cards',
        card: 'workflow',
        drill: { type: 'query', page: 'workflow-run-cards', query: 'entity-runs' }
      }
    });
    expect(views['entity-runs']).toMatchObject({
      data: { source: 'entity-runs' },
      list: {
        style: 'entity-cards',
        card: 'run',
        drill: { type: 'query', page: 'run-events', query: 'entity-events' }
      }
    });
    expect(views['mcp-tool-observations']).toMatchObject({
      data: { source: 'mcp-tool-observations' },
      list: {
        style: 'entity-cards',
        card: 'event',
        drill: { type: 'external', field: 'run-link' }
      }
    });
    expect(views['firewall-domain-observations']).toMatchObject({
      data: { source: 'firewall-domain-observations' },
      list: {
        style: 'entity-cards',
        card: 'event',
        drill: { type: 'external', field: 'run-link' }
      }
    });

    expect(queries['mcp-tool-observations']).toMatchObject({
      from: 'mcp-tool-calls',
      filter: { predicates: [{ field: 'safe-output-server', equals: false }] }
    });
    expect(queries['firewall-domain-observations']).toMatchObject({
      from: 'firewall-observations',
      filter: { predicates: [{ field: 'decision', in: ['allowed', 'denied'] }] }
    });
  });
});
