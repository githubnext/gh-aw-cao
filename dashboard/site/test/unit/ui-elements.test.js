// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderUiElement } from '../../src/components/ui-elements.js';

const metadata = {
  'source-id': 'outcomes-fixture',
  'source-kind': 'fixture',
  'as-of': '2026-08-30T12:00:00Z',
  'retrieved-at': '2026-08-30T12:01:00Z',
  completeness: /** @type {'complete'} */ ('complete'),
  freshness: /** @type {'fresh'} */ ('fresh'),
  availability: /** @type {'available'} */ ('available')
};

describe('UI elements', () => {
  it('does not render removed element names', () => {
    expect(renderUiElement('summary-grid', /** @type {never} */ ({}))).toBeNull();
  });

  it('renders outcome-detail-section from declarative config and filtered outcome scope', () => {
    const rendered = renderUiElement('outcome-detail-section', {
      pageId: 'outcome-detail',
      title: 'Outcome metadata',
      sourceNames: ['outcomes'],
      elementConfig: { section: 'outcome-detail-section', body: 'metadata' },
      scope: { 'safe-output': 'outcome-1' },
      headingTag: 'h3',
      contextDetails: [],
      sources: {
        outcomes: {
          source: 'outcomes',
          metadata,
          rows: [{
            'safe-output': 'outcome-1',
            'outcome-state': 'lifecycle-close',
            'outcome-status': 'closed',
            'rollout-mode': 'live',
            'outcome-category': 'pull-request',
            'workflow-name': 'Daily review',
            'external-link': { relation: 'external', href: 'https://github.com/octo/repo/pull/1', label: 'View output' }
          }]
        }
      }
    });

    expect(rendered?.className).toBe('outcome-meta');
    expect(rendered?.textContent).toContain('Daily review');
    expect(rendered?.textContent).toContain('Pull Request');
  });
});
