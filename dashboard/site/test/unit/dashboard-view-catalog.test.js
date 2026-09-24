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
  elementRendererNames,
  referencedElementNames
} from '../../scripts/lint-element-renderers.mjs';

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

  it('identifies registered renderers and element view references for dead-renderer linting', () => {
    expect(elementRendererNames(`
      const ELEMENT_RENDERERS = new Map([
        ['used-element', renderUsed],
        ['dead-element', renderDead]
      ]);
    `)).toEqual(['used-element', 'dead-element']);
    expect([...referencedElementNames({
      dashboard: {
        pages: [{ views: [{ mark: 'element', element: 'used-element' }] }]
      }
    })]).toEqual(['used-element']);
  });
});