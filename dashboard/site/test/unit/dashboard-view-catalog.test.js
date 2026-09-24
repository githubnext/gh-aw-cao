// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BUILT_IN_PAGE_VALUES,
  VIEW_CHART_VALUES,
  VIEW_ELEMENT_VALUES,
  VIEW_MARK_VALUES
} from '../../src/specification.js';
import {
  deadViewNames,
  elementRendererNames,
  referencedElementNames,
  renderDeadViews
} from '../../scripts/list-dead-views.mjs';

const catalog = readFileSync(
  fileURLToPath(new URL('../../../../docs/dashboard-view-catalog.md', import.meta.url)),
  'utf8'
);

describe('dashboard view catalog', () => {
  it.each([
    ['built-in page', BUILT_IN_PAGE_VALUES],
    ['view mark', VIEW_MARK_VALUES],
    ['chart', VIEW_CHART_VALUES],
    ['named element', VIEW_ELEMENT_VALUES]
  ])('lists every standardized %s', (_kind, values) => {
    for (const value of values) {
      expect(catalog).toContain(`| \`${value}\` |`);
    }
  });

  it('renders registered named views that no dashboard document references', () => {
    const renderers = elementRendererNames(`
      const ELEMENT_RENDERERS = new Map([
        ['used-element', renderUsed],
        ['dead-element', renderDead]
      ]);
    `);
    const references = referencedElementNames({
      dashboard: {
        pages: [{ views: [{ mark: 'element', element: 'used-element' }] }]
      }
    });

    const dead = deadViewNames(renderers, references);

    expect(dead).toEqual(['dead-element']);
    expect(renderDeadViews(dead)).toBe('Dead dashboard views (1):\n- dead-element');
  });

  it('renders an explicit empty report when every named view is referenced', () => {
    expect(renderDeadViews([])).toBe('No dead dashboard views.');
  });
});