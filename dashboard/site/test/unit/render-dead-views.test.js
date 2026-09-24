import { describe, expect, it } from 'vitest';
import {
  deadElementRendererNames,
  elementRendererNames,
  referencedElementNames
} from '../../scripts/render-dead-views.mjs';

describe('dead element view analysis', () => {
  it('reads names from the element renderer registry', () => {
    const source = `
      const ELEMENT_RENDERERS = new Map([
        ['summary-grid', renderSummaryGrid],
        ["signal-list", renderSignalList]
      ]);
    `;

    expect(elementRendererNames(source)).toEqual(['summary-grid', 'signal-list']);
  });

  it('finds element views recursively', () => {
    const document = {
      dashboard: {
        pages: [
          { views: [{ mark: 'element', element: 'summary-grid' }] },
          { views: [{ mark: 'table', element: 'not-an-element-view' }] }
        ],
        reusable: {
          mark: 'element',
          element: 'signal-list'
        }
      }
    };

    expect([...referencedElementNames(document)]).toEqual(['summary-grid', 'signal-list']);
  });

  it('returns registered renderers that no dashboard references', () => {
    expect(deadElementRendererNames(
      ['summary-grid', 'signal-list', 'context-summary'],
      ['summary-grid', 'context-summary']
    )).toEqual(['signal-list']);
  });
});
