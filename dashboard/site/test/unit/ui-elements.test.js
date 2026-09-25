import { describe, expect, it } from 'vitest';
import {
  elementHandlesEmptyRows,
  elementLoadsSourcesAsync,
  renderUiElement
} from '../../src/components/ui-elements.js';

const REMOVED_ELEMENTS = [
  'domain-attention',
  'campaign-status-grid',
  'summary-grid',
  'readiness-verdict',
  'context-summary',
  'anomaly-readiness',
  'signal-list',
  'needs-attention-list',
  'campaign-activity',
  'campaign-utilization',
  'campaign-run-trend',
  'campaign-summary-table',
  'campaign-activity-shell',
  'workflow-route',
  'configuration-actions',
  'work-project-view',
  'insights-overview',
  'outcomes-overview',
  'local-database'
];

describe('UI element registry', () => {
  it.each(REMOVED_ELEMENTS)('does not expose the unreferenced %s renderer', (element) => {
    expect(renderUiElement(element, /** @type {never} */ ({}))).toBeNull();
    expect(elementHandlesEmptyRows(element)).toBe(false);
    expect(elementLoadsSourcesAsync(element)).toBe(false);
  });

  it.each(['factory-header', 'factory-floor', 'link-button-list'])(
    'keeps independently loaded sources for the live %s renderer',
    (element) => {
      expect(elementLoadsSourcesAsync(element)).toBe(true);
      expect(elementHandlesEmptyRows(element)).toBe(true);
    }
  );
});
