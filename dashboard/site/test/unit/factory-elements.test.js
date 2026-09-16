// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { renderUiElement } from '../../src/components/ui-elements.js';

/** @type {import('../../src/presenter.js').SourceMetadata} */
const metadata = {
  'source-id': 'fixture',
  'source-kind': 'fixture',
  'as-of': '2026-09-11T12:00:00Z',
  'retrieved-at': '2026-09-11T12:00:00Z',
  availability: 'available',
  completeness: 'complete',
  freshness: 'unknown'
};

/** @param {string} name @param {Record<string, unknown>[]} rows @param {Partial<import('../../src/presenter.js').SourceMetadata>} [metadataOverride] */
function source(name, rows, metadataOverride = {}) {
  return { source: name, rows, metadata: { ...metadata, ...metadataOverride } };
}

const rhythm = {
  days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((label, index) => ({
    label,
    date: `2026-09-${String(7 + index).padStart(2, '0')}`,
    current: index === 2 ? 2 : 0,
    previous: index === 2 ? 1 : 0,
    reached: index < 3
  }))
};

/**
 * @param {'factory-header'|'factory-floor'} element
 * @param {Record<string, import('../../src/presenter.js').LogicalSourceInput>} sources
 * @param {Record<string, unknown>} [elementConfig]
 * @returns {import('../../src/components/ui-elements.js').ElementRenderContext}
 */
function context(element, sources, elementConfig) {
  return {
    pageId: 'overview',
    title: element === 'factory-header' ? 'How are we doing?' : 'Factory floor',
    sourceNames: Object.keys(sources),
    sources,
    elementConfig,
    contextDetails: [],
    headingTag: /** @type {const} */ ('h3')
  };
}

it('renders the factory header from only its declared JSON sources', () => {
  const rendered = renderUiElement('factory-header', context('factory-header', {
    'overview-outcome-summary': source('overview-outcome-summary', [{ 'useful-outputs': 2, 'delivered-repositories': 3 }]),
    'overview-run-summary': source('overview-run-summary', [{ 'active-runs': 4, 'active-live': 1, 'active-review': 3 }]),
    'overview-factory-status': source('overview-factory-status', [{ 'factory-heading': 'Your factory is delivering value.' }]),
    'overview-rhythm': source('overview-rhythm', [{ rhythm }])
  }));

  expect(rendered?.classList.contains('factory-intro')).toBe(true);
  expect(rendered?.querySelector('.factory-running-active')?.textContent).toBe('Work in motion');
  expect(rendered?.querySelector('h2')?.textContent).toBe('Your factory is delivering value.');
  expect(rendered?.querySelector('.factory-intro-copy > p:last-child')?.textContent)
    .toBe('2 retained issue and pull request outputs are backed by Actions evidence across 3 repositories.');
  expect(rendered?.querySelectorAll('.factory-rhythm-day')).toHaveLength(7);
});

it('renders the factory floor from its independent JSON view and configuration', () => {
  const rendered = renderUiElement('factory-floor', context('factory-floor', {
    'overview-outcome-summary': source('overview-outcome-summary', [{ 'useful-outputs': 2 }]),
    'overview-run-summary': source('overview-run-summary', [{ 'successful-runs': 2, 'failed-runs': 2, 'active-runs': 4 }]),
    'overview-dispatch-summary': source('overview-dispatch-summary', [{ dispatches: 4, 'failed-dispatches': 2 }]),
    'overview-delivery-summary': source('overview-delivery-summary', [{ 'delivered-repositories': 3 }]),
    'overview-value-summary': source('overview-value-summary', [{ 'value-gains': 1 }]),
    'overview-registered-repository-summary': source('overview-registered-repository-summary', [{ 'registered-repositories': 6 }]),
    'overview-worker-summary': source('overview-worker-summary', [{ workers: 2 }])
  }, {
    animate: 'number',
    labels: {
      dispatches: { singular: 'Successful dispatch', plural: 'Successful dispatches' }
    }
  }));

  expect(rendered?.classList.contains('factory-floor-active')).toBe(true);
  expect([...rendered?.querySelectorAll('.factory-station') ?? []].map((station) => station.textContent)).toEqual([
    'Repositories registered6',
    'Successful runs22 failed',
    'Successful dispatches42 failed',
    'Value gain1'
  ]);
  expect(rendered?.querySelector('.factory-station:nth-child(2) strong .metric-number-animated')).not.toBeNull();
  expect(rendered?.querySelector('.factory-station:nth-child(3) small a')?.getAttribute('href'))
    .toBe('#page-dispatches?package-worker-dispatches.status=failure');
  expect(rendered?.getAttribute('aria-label')).toContain('6 repositories registered with 3 delivered to');
});

it('keeps unavailable registered repository evidence distinct from zero', () => {
  const rendered = renderUiElement('factory-floor', context('factory-floor', {
    'overview-outcome-summary': source('overview-outcome-summary', [{ 'useful-outputs': 0 }]),
    'overview-run-summary': source('overview-run-summary', [{ 'successful-runs': 0, 'failed-runs': 0, 'active-runs': 0 }]),
    'overview-dispatch-summary': source('overview-dispatch-summary', [{ dispatches: 0, 'failed-dispatches': 0 }]),
    'overview-delivery-summary': source('overview-delivery-summary', [{ 'delivered-repositories': 3 }]),
    'overview-value-summary': source('overview-value-summary', [{ 'value-gains': 0 }]),
    'overview-registered-repository-summary': source('overview-registered-repository-summary', [], { availability: 'unavailable' }),
    'overview-worker-summary': source('overview-worker-summary', [{ workers: 0 }])
  }));

  expect(rendered?.querySelector('.factory-station')?.textContent).toBe('Repositories registeredUnavailable');
  expect(rendered?.querySelector('.factory-station:first-child strong a')).toBeNull();
  expect(rendered?.getAttribute('aria-label')).toContain('Registered repositories unavailable');
});
