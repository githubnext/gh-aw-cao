// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from 'vitest';
import { renderUiElement } from '../../src/components/ui-elements.js';
import { configureSourceLoader, resetSourceStore } from '../../src/source-store.js';

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

beforeEach(resetSourceStore);
afterEach(resetSourceStore);

/**
 * @param {'factory-header'|'factory-floor'|'link-button-list'} element
 * @param {Record<string, import('../../src/presenter.js').LogicalSourceInput>} sources
 * @param {Record<string, unknown>} [elementConfig]
 * @returns {import('../../src/components/ui-elements.js').ElementRenderContext}
 */
function context(element, sources, elementConfig) {
  return {
    pageId: 'overview',
    viewId: element === 'factory-header' ? 'overview-header' : element === 'factory-floor' ? 'overview-floor' : 'overview-campaigns',
    viewIndex: element === 'factory-header' ? 0 : element === 'factory-floor' ? 1 : 2,
    title: element === 'factory-header' ? 'How are we doing?' : element === 'factory-floor' ? 'Factory floor' : 'Campaigns',
    sourceNames: Object.keys(sources),
    sources,
    elementConfig,
    contextDetails: [],
    headingTag: /** @type {const} */ ('h3')
  };
}

it('renders campaign shortcuts through the reusable link button list', () => {
  const rendered = renderUiElement('link-button-list', {
    ...context('link-button-list', {
    'overview-campaign-links': source('overview-campaign-links', [
      {
        campaign: 'aw-doctor',
        'campaign-name': 'AW Doctor',
        'campaign-icon': 'gear',
        'campaign-dashboard-link': {
          'dashboard-href': '#page-campaign-insights?campaign=aw-doctor',
          'dashboard-label': 'View AW Doctor campaign dashboard'
        }
      }
    ])
    }),
    elementConfig: {
      'label-field': 'campaign-name',
      'link-field': 'campaign-dashboard-link',
      'icon-field': 'campaign-icon',
      'fallback-icon': 'goal'
    }
  });

  expect(rendered?.querySelectorAll('.link-button-list-item')).toHaveLength(1);
  expect(rendered?.querySelector('.link-button-list-item a')?.getAttribute('href'))
    .toBe('#page-campaign-insights?campaign=aw-doctor');
  expect(rendered?.querySelector('.link-button-list-item a')?.getAttribute('aria-label'))
    .toBe('View AW Doctor campaign dashboard');
});

it('renders the factory header from only its declared JSON sources', () => {
  const rendered = renderUiElement('factory-header', context('factory-header', {
    'overview-outcome-summary': source('overview-outcome-summary', [{ 'useful-outputs': 2, 'delivered-repositories': 3 }]),
    'overview-run-summary': source('overview-run-summary', [{ 'active-runs': 4, 'active-live': 1, 'active-review': 3 }]),
    'overview-factory-status': source('overview-factory-status', [{ 'factory-heading': 'Your factory is delivering value.' }]),
    'overview-rhythm': source('overview-rhythm', [{ rhythm }])
  }));

  expect(rendered?.classList.contains('factory-intro')).toBe(true);
  expect(rendered?.querySelector('.factory-running')).toBeNull();
  expect(rendered?.querySelector('h2')?.textContent).toBe('Your factory is delivering value.');
  expect(rendered?.querySelector('.factory-intro-copy > p:last-child')?.textContent)
    .toBe('2 retained issue and pull request outputs are backed by Actions evidence across 3 repositories.');
  expect(rendered?.querySelectorAll('.factory-rhythm-day')).toHaveLength(7);
});

it('renders the factory floor from its independent JSON view and configuration', () => {
  const rendered = renderUiElement('factory-floor', context('factory-floor', {
    'database-campaign-count': source('database-campaign-count', [{ campaigns: 2 }]),
    'overview-outcome-summary': source('overview-outcome-summary', [{ 'useful-outputs': 2 }]),
    'overview-run-summary': source('overview-run-summary', [{ 'successful-runs': 2, 'failed-runs': 2, 'active-runs': 4 }]),
    'overview-dispatch-summary': source('overview-dispatch-summary', [{ dispatches: 4, 'failed-dispatches': 2 }]),
    'overview-delivery-summary': source('overview-delivery-summary', [{ 'delivered-repositories': 3 }]),
    'overview-value-summary': source('overview-value-summary', [{ 'value-gains': 1 }]),
    'overview-registered-repository-summary': source('overview-registered-repository-summary', [{ 'registered-repositories': 6 }]),
    'overview-worker-summary': source('overview-worker-summary', [{ workers: 2 }]),
    'database-issue-count': source('database-issue-count', [{ issues: 5 }])
  }, {
    animate: 'number',
    labels: {
      dispatches: { singular: 'Successful dispatch', plural: 'Successful dispatches' }
    }
  }));

  expect(rendered?.classList.contains('factory-floor-active')).toBe(true);
  expect([...rendered?.querySelectorAll('.factory-station') ?? []].map((station) => station.textContent)).toEqual([
    'Campaigns2',
    'Repositories registered6',
    'Issues & PRs5',
    'Successful runs22 failed',
    'Successful dispatches42 failed',
    'Value gain1'
  ]);
  expect(rendered?.querySelector('.factory-station:nth-child(4) strong .metric-number-animated')).not.toBeNull();
  expect(rendered?.querySelector('.factory-station:nth-child(5) small a')?.getAttribute('href'))
    .toBe('#page-dispatches?campaign-worker-dispatches.status=failure');
  expect(rendered?.getAttribute('aria-label')).toContain('6 repositories registered with 3 delivered to');
});

it('keeps unavailable registered repository evidence distinct from zero', () => {
  const rendered = renderUiElement('factory-floor', context('factory-floor', {
    'database-campaign-count': source('database-campaign-count', [{ campaigns: 0 }]),
    'overview-outcome-summary': source('overview-outcome-summary', [{ 'useful-outputs': 0 }]),
    'overview-run-summary': source('overview-run-summary', [{ 'successful-runs': 0, 'failed-runs': 0, 'active-runs': 0 }]),
    'overview-dispatch-summary': source('overview-dispatch-summary', [{ dispatches: 0, 'failed-dispatches': 0 }]),
    'overview-delivery-summary': source('overview-delivery-summary', [{ 'delivered-repositories': 3 }]),
    'overview-value-summary': source('overview-value-summary', [{ 'value-gains': 0 }]),
    'overview-registered-repository-summary': source('overview-registered-repository-summary', [], { availability: 'unavailable' }),
    'overview-worker-summary': source('overview-worker-summary', [{ workers: 0 }]),
    'database-issue-count': source('database-issue-count', [{ issues: 0 }])
  }));

  expect(rendered?.querySelector('.factory-station:nth-child(2)')?.textContent).toBe('Repositories registeredUnavailable');
  expect(rendered?.querySelector('.factory-station:nth-child(2) strong a')).toBeNull();
  expect(rendered?.getAttribute('aria-label')).toContain('Registered repositories unavailable');
});

it('renders both elements immediately and updates only widgets whose query resolves', async () => {
  /** @type {Array<{ name: string, pageId?: string, viewId?: string }>} */
  const requests = [];
  /** @type {Map<string, (value: import('../../src/presenter.js').LogicalSourceInput) => void>} */
  const resolvers = new Map();
  configureSourceLoader((name, options) => {
    requests.push({ name, pageId: options?.pageId, viewId: options?.viewId });
    return new Promise((resolve) => resolvers.set(`${options?.viewId}:${name}`, resolve));
  });

  const header = renderUiElement('factory-header', context('factory-header', {}));
  const floor = renderUiElement('factory-floor', context('factory-floor', {}));
  floor?.classList.add('custom-view');

  expect(header?.classList.contains('factory-intro')).toBe(true);
  expect(header?.querySelector('.factory-heading-pending')).not.toBeNull();
  expect(header?.querySelector('.factory-rhythm-pending')).not.toBeNull();
  expect(floor?.classList.contains('factory-floor')).toBe(true);
  expect(floor?.querySelectorAll('.factory-station-pending')).toHaveLength(6);
  expect(requests.map(({ name }) => name)).toEqual([
    'overview-outcome-summary',
    'overview-factory-status',
    'overview-rhythm',
    'database-campaign-count',
    'overview-registered-repository-summary',
    'database-issue-count',
    'overview-outcome-summary',
    'overview-run-summary',
    'overview-dispatch-summary',
    'overview-delivery-summary',
    'overview-value-summary',
    'overview-worker-summary'
  ]);
  expect(requests.every(({ pageId }) => pageId === 'overview')).toBe(true);

  const runSummary = source('overview-run-summary', [{
    'successful-runs': 3,
    'failed-runs': 1,
    'active-runs': 2,
    'active-live': 1,
    'active-review': 1
  }]);
  resolvers.get('overview-floor:overview-run-summary')?.(runSummary);
  await Promise.resolve();
  await Promise.resolve();

  expect(header?.querySelector('.factory-running')).toBeNull();
  expect(floor?.querySelector('.factory-station:nth-child(4)')?.textContent).toBe('Successful runs31 failed');
  expect(floor?.querySelector('.factory-station:nth-child(4)')?.classList.contains('factory-station-pending')).toBe(false);
  expect(floor?.querySelector('.factory-station:nth-child(5)')?.classList.contains('factory-station-pending')).toBe(true);
  expect(floor?.classList.contains('custom-view')).toBe(true);
});

it('stops updating an element after its rendered root is removed', async () => {
  const first = renderUiElement('factory-header', context('factory-header', {
    'overview-outcome-summary': source('overview-outcome-summary', []),
    'overview-factory-status': source('overview-factory-status', [{ 'factory-heading': 'First status' }]),
    'overview-rhythm': source('overview-rhythm', [{ rhythm }])
  }));
  if (!first) throw new Error('Expected the factory header element.');
  document.body.append(first);
  first.remove();
  await new Promise((resolve) => setTimeout(resolve, 0));

  renderUiElement('factory-header', context('factory-header', {
    'overview-outcome-summary': source('overview-outcome-summary', []),
    'overview-factory-status': source('overview-factory-status', [{ 'factory-heading': 'Second status' }]),
    'overview-rhythm': source('overview-rhythm', [{ rhythm }])
  }));

  expect(first.querySelector('h2')?.textContent).toBe('First status');
  expect(first.querySelector('.factory-running')).toBeNull();
});
