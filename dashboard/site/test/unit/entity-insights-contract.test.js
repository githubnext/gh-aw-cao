import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const dashboard = JSON.parse(readFileSync(`${process.cwd()}/dashboard.json`, 'utf8')).dashboard;

describe('canonical entity insights', () => {
  for (const entity of [
    { id: 'domain', card: 'firewall-domain', source: 'domains', identifier: 'domain' },
    { id: 'tool', card: 'mcp-tool', source: 'mcp-tool-calls', identifier: 'mcp-tool-label' },
    { id: 'audit', card: 'audit', source: 'audits', identifier: 'event-summary' }
  ]) {
    it(`gives ${entity.id} entities an Insights chart, native link, and related Runs facet`, () => {
      const insights = dashboard.pages.find((/** @type {Record<string, any>} */ page) => page.id === `${entity.id}-insights`);
      const runs = dashboard.pages.find((/** @type {Record<string, any>} */ page) => page.id === `${entity.id}-runs`);
      const chrome = insights?.views.find((/** @type {Record<string, any>} */ view) => view.element === 'entity-route');

      expect(insights?.route.tabs).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'insights', page: `${entity.id}-insights` }),
        expect.objectContaining({ id: 'runs', page: `${entity.id}-runs` })
      ]));
      expect(insights?.views.filter((/** @type {Record<string, any>} */ view) => view.mark === 'chart')).toHaveLength(1);
      expect(chrome?.data.sources).toEqual([entity.source]);
      expect(chrome?.['title-link']).toEqual({
        'href-field': 'run-link',
        'identifier-field': entity.identifier
      });
      expect(dashboard['card-templates'].find(
        (/** @type {Record<string, any>} */ template) => template.id === entity.card
      )?.drill).toMatchObject({
        page: `${entity.id}-insights`,
        query: `${entity.id}-entity-insights`,
        'title-field': entity.identifier
      });
      expect(runs?.views).toEqual(expect.arrayContaining([
        expect.objectContaining({
          mark: 'table',
          data: expect.objectContaining({ source: entity.source })
        })
      ]));
    });
  }
});
