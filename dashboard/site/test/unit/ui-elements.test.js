// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  elementHandlesEmptyRows,
  elementLoadsSourcesAsync,
  renderUiElement
} from '../../src/components/ui-elements.js';

const context = {
  pageId: 'test-page',
  title: 'Test',
  sourceNames: [],
  sources: {},
  contextDetails: [],
  headingTag: /** @type {'h3'} */ ('h3')
};

describe('UI elements', () => {
  it('does not expose custom elements removed by dashboard garbage collection', () => {
    for (const name of [
      'anomaly-readiness',
      'campaign-activity',
      'campaign-activity-shell',
      'campaign-detail',
      'campaign-dispatches',
      'campaign-insights',
      'campaign-problem-list',
      'campaign-reports',
      'campaign-run-trend',
      'campaign-status-grid',
      'campaign-summary-table',
      'campaign-utilization',
      'configuration-actions',
      'context-summary',
      'domain-attention',
      'insights-overview',
      'local-database',
      'needs-attention-list',
      'readiness-verdict',
      'signal-list',
      'summary-grid',
      'work-project-view',
      'workflow-route'
    ]) {
      expect(renderUiElement(name, context), name).toBeNull();
      expect(elementHandlesEmptyRows(name), name).toBe(false);
      expect(elementLoadsSourcesAsync(name), name).toBe(false);
    }
  });

  it('retains independently loaded elements referenced by the dashboard', () => {
    expect(elementLoadsSourcesAsync('factory-header')).toBe(true);
    expect(elementLoadsSourcesAsync('factory-floor')).toBe(true);
    expect(elementLoadsSourcesAsync('link-button-list')).toBe(true);
    expect(elementLoadsSourcesAsync('outcomes-overview')).toBe(true);
  });

  it('retains the referenced custom element renderers', () => {
    expect(elementHandlesEmptyRows('campaign-route')).toBe(true);
    expect(elementHandlesEmptyRows('workflow-route-page')).toBe(true);
    expect(elementHandlesEmptyRows('configuration-policy')).toBe(true);
    expect(renderUiElement('outcomes-overview', context)).not.toBeNull();
  });
});
