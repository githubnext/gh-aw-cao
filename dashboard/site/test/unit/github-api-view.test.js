// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { renderDashboard } from '../../src/presenter.js';

const dashboard = JSON.parse(readFileSync(`${process.cwd()}/dashboard.json`, 'utf8'));
const metadata = {
  'source-id': 'github-api-fixture',
  'source-kind': 'fixture',
  'as-of': '2026-09-04T13:00:00Z',
  'retrieved-at': '2026-09-04T13:00:00Z',
  completeness: /** @type {'complete'} */ ('complete'),
  freshness: /** @type {'fresh'} */ ('fresh'),
  availability: /** @type {'available'} */ ('available')
};

/** @param {Record<string, unknown>} [overrides] @returns {Record<string, unknown>} */
function rateLimitRow(overrides = {}) {
  return {
    'observation-id': 'run-1:after:reader:core:2026-09-04T12:00:00Z',
    'operation-execution-id': 'run-1',
    'observed-at': '2026-09-04T12:00:00Z',
    phase: 'after',
    operation: 'refresh-activity',
    outcome: 'success',
    credential: 'reader',
    'credential-type': 'app',
    resource: 'core',
    bucket: 'core · reader',
    'maximum-lane': 'core · reader · max 5000',
    'history-series': 'core · reader',
    'has-history': true,
    remaining: 4_875,
    limit: 5_000,
    used: 125,
    'remaining-percent': 97.5,
    'reset-at': '2026-09-04T13:00:00Z',
    'minutes-to-reset': 60,
    'consumed-since-previous': 25,
    'burn-rate-per-minute': 0.417,
    'projected-remaining-at-reset': 4_850,
    'projected-exhaustion-at': '2026-09-12T14:00:00Z',
    'runway-ratio': 195,
    'risk-status': 'healthy',
    'risk-order': 2,
    'is-current': true,
    'attribution-status': 'available',
    'operation-consumed': 25,
    ...overrides
  };
}

/**
 * @param {{
 *   source: string,
 *   metadata: {
 *     'source-id': string,
 *     'source-kind': string,
 *     'as-of': string,
 *     'retrieved-at': string,
 *     completeness: 'complete'|'partial'|'unknown',
 *     freshness: 'fresh'|'stale'|'unknown',
 *     availability: 'available'|'empty'|'unavailable'
 *   },
 *   rows: Array<Record<string, unknown>>
 * }} [rateLimitSource]
 * @param {Array<Record<string, unknown>>} [stackRows]
 */
async function renderApiPage(rateLimitSource = {
  source: 'github-api-rate-limits',
  metadata,
  rows: [
    rateLimitRow({
      'observation-id': 'run-0:after:reader:core:2026-09-04T11:00:00Z',
      'operation-execution-id': 'run-0',
      'observed-at': '2026-09-04T11:00:00Z',
      remaining: 4_900,
      used: 100,
      'remaining-percent': 98,
      'is-current': false
    }),
    rateLimitRow(),
    rateLimitRow({
      'observation-id': 'run-2:after:reader:search:2026-09-04T12:00:00Z',
      'operation-execution-id': 'run-2',
      resource: 'search',
      bucket: 'search · reader',
      'maximum-lane': 'search · reader · max 30',
      'history-series': 'search · reader',
      remaining: 3,
      limit: 30,
      used: 27,
      'remaining-percent': 10,
      'reset-at': '2026-09-04T12:10:00Z',
      'minutes-to-reset': 10,
      'burn-rate-per-minute': null,
      'projected-remaining-at-reset': null,
      'projected-exhaustion-at': null,
      'runway-ratio': null,
      'risk-status': 'warning',
      'risk-order': 1,
      'attribution-status': 'unavailable',
      'operation-consumed': null
    })
  ]
}, stackRows = [
  {
    'observed-at': '2026-09-04T12:00:00Z',
    'operation-execution-id': 'run-1',
    phase: 'after',
    operation: 'refresh-activity',
    outcome: 'success',
    credential: 'reader',
    'stack-frame-id': 'run-1:after:0',
    'stack-parent-id': '',
    'stack-depth': 0,
    'stack-frame': 'at main (activity/github-telemetry.mjs:150:9)'
  },
  {
    'observed-at': '2026-09-04T12:00:00Z',
    'operation-execution-id': 'run-1',
    phase: 'after',
    operation: 'refresh-activity',
    outcome: 'success',
    credential: 'reader',
    'stack-frame-id': 'run-1:after:1',
    'stack-parent-id': 'run-1:after:0',
    'stack-depth': 1,
    'stack-frame': 'at recordGithubTelemetry (activity/github-telemetry.mjs:100:16)'
  }
]) {
  const rendered = renderDashboard({
    document: dashboard,
    sources: {
      'github-api-rate-limits': rateLimitSource,
      'github-api-collector-health': {
        source: 'github-api-collector-health',
        metadata,
        rows: [{
          'observed-at': '2026-09-04T12:00:00Z',
          'operation-execution-id': 'run-1',
          phase: 'after',
          operation: 'refresh-activity',
          outcome: 'success',
          credential: 'reader',
          'cache-hydrated': true,
          'cache-bytes': 1_024,
          'cache-entries': 7,
          'cache-folders': 1,
          'rate-limit-error': ''
        }]
      },
      'github-api-call-stacks': {
        source: 'github-api-call-stacks',
        metadata,
        rows: stackRows
      }
    }
  });
  rendered.ownerDocument.defaultView?.history.replaceState(null, '', '/');
  const link = /** @type {HTMLAnchorElement | null} */ (rendered.querySelector('[data-nav-page-id="github-api"]'));
  expect(link).not.toBeNull();
  link?.click();
  await vi.waitFor(() => {
    expect(rendered.querySelector('[data-page-id="github-api"]')?.hasAttribute('data-page-pending')).toBe(false);
  });
  return {
    rendered,
    link,
    page: rendered.querySelector('[data-page-id="github-api"]')
  };
}

describe('GitHub API rate-limit dashboard', () => {
  it('renders four essential operational views with accessible capacity evidence', async () => {
    const { link, page } = await renderApiPage();
    const apiPage = dashboard.dashboard.pages.find((/** @type {{ id: string }} */ candidate) => candidate.id === 'github-api');

    expect(link).not.toBeNull();
    expect(page).not.toBeNull();
    expect(apiPage).toMatchObject({
      kind: 'custom',
      title: 'GitHub API Rate Limits',
      icon: 'meter'
    });
    expect(apiPage.views.filter((/** @type {{ disclosure?: string }} */ view) => view.disclosure === 'essential')).toHaveLength(4);
    expect(apiPage.views.filter((/** @type {{ disclosure?: string }} */ view) => view.disclosure === 'supplemental')).toHaveLength(5);
    expect(apiPage.views[0]).toMatchObject({
      id: 'github-api-remaining-trend',
      chart: 'scatter',
      table: true
    });
    expect(apiPage.views.find((/** @type {{ id: string }} */ view) => view.id === 'github-api-remaining-capacity')).toMatchObject({
      id: 'github-api-remaining-capacity',
      chart: 'bar',
      table: true
    });
    expect(apiPage.views.find((/** @type {{ id: string }} */ view) => view.id === 'github-api-at-risk')).toMatchObject({
      mark: 'metric',
      encoding: { value: expect.objectContaining({ aggregate: 'count' }) }
    });
    expect(apiPage.views.find((/** @type {{ id: string }} */ view) => view.id === 'github-api-remaining-trend')).toMatchObject({
      chart: 'scatter',
      table: true,
      encoding: {
        y: expect.objectContaining({ field: 'remaining-percent', unit: 'percent' }),
        color: expect.objectContaining({ field: 'maximum-lane' })
      }
    });
    expect(page?.querySelector('[aria-labelledby="github-api-remaining-capacity-heading"]')
      ?.querySelectorAll('.bar-chart-bar')).toHaveLength(2);
    expect(page?.querySelectorAll('.scatter-chart-point')).toHaveLength(3);
    expect(page?.querySelector('.line-chart-series')).toBeNull();
    expect(page?.textContent).toContain('At-risk buckets');
    expect(page?.textContent).toContain('1');
    expect(page?.textContent).toContain('4875');
    expect(page?.textContent).toContain('5000');
    expect(page?.textContent).toContain('warning');
    expect(page?.textContent).toContain('Last observed (UTC)');
    expect(page?.textContent).not.toContain('As of');
  });

  it('keeps raw quota and collector/cache diagnostics supplemental and distinct', async () => {
    const { page } = await renderApiPage();
    const supplemental = [...(page?.querySelectorAll('details[data-disclosure="supplemental"]') ?? [])];

    expect(supplemental).toHaveLength(5);
    expect(supplemental.map((view) => view.querySelector('summary')?.textContent)).toEqual(expect.arrayContaining([
      expect.stringContaining('Raw quota observations'),
      expect.stringContaining('Collector and cache health'),
      expect.stringContaining('Collection call stacks')
    ]));
    expect(page?.textContent).toContain('Collection completeness, retrieval failures, and activity-cache state');
    const stackTable = page?.querySelector('table[role="treegrid"]');
    expect(stackTable?.getAttribute('role')).toBe('treegrid');
    expect(stackTable?.querySelectorAll('tbody tr[aria-level]')).toHaveLength(2);
    expect(stackTable?.querySelector('tbody tr:nth-child(2)')?.getAttribute('aria-level')).toBe('2');
    expect(stackTable?.querySelectorAll('.tree-table-cell')).toHaveLength(2);
    expect(stackTable?.querySelector('tbody tr:nth-child(2) .tree-table-cell')?.getAttribute('style')).toContain('--tree-depth: 1');
    expect(stackTable?.textContent).toContain('activity/github-telemetry.mjs:100:16');
  });

  it('keeps call-stack rows with missing tree ids as independent roots', async () => {
    const { page } = await renderApiPage(undefined, [
      { 'stack-frame': 'missing id root one', 'stack-parent-id': '' },
      { 'stack-frame': 'missing id root two', 'stack-parent-id': '' },
      { 'stack-frame': 'parent row', 'stack-frame-id': 'parent', 'stack-parent-id': '' },
      { 'stack-frame': 'child row', 'stack-frame-id': 'child', 'stack-parent-id': 'parent' },
      { 'stack-frame': 'orphan row', 'stack-frame-id': 'orphan', 'stack-parent-id': 'missing-parent' }
    ]);
    const rows = [...(page?.querySelectorAll('table[role="treegrid"] tbody tr') ?? [])];
    /** @param {string} text */
    const levelFor = (text) => rows.find((row) => row.textContent?.includes(text))?.getAttribute('aria-level');

    expect(levelFor('missing id root one')).toBe('1');
    expect(levelFor('missing id root two')).toBe('1');
    expect(levelFor('parent row')).toBe('1');
    expect(levelFor('child row')).toBe('2');
    expect(levelFor('orphan row')).toBe('1');
  });

  it('exposes stale, partial, unavailable, and empty source states without fabricated quota values', async () => {
    const stalePartial = {
      source: 'github-api-rate-limits',
      metadata: {
        ...metadata,
        completeness: /** @type {'partial'} */ ('partial'),
        freshness: /** @type {'stale'} */ ('stale'),
        availability: /** @type {'unavailable'} */ ('unavailable')
      },
      rows: []
    };
    const { page } = await renderApiPage(stalePartial);

    expect(page?.textContent).toContain('This view is unavailable.');
    expect(page?.textContent).toContain('Affected source: github-api-rate-limits');
    expect(page?.textContent).toContain('partial');
    expect(page?.textContent).toContain('stale');
    expect(page?.textContent).not.toContain('0.0 %');
  });

  it('shows sparse quota observations as independent scatter points', async () => {
    const observedAt = '2026-09-04T12:00:00Z';
    const { page } = await renderApiPage({
      source: 'github-api-rate-limits',
      metadata,
      rows: [
        rateLimitRow({ 'observed-at': observedAt, 'history-series': 'core · reader', 'has-history': false }),
        rateLimitRow({
          'observation-id': 'run-1:after:reader:search:2026-09-04T12:00:00Z',
          'observed-at': observedAt,
          resource: 'search',
          bucket: 'search · reader',
          'history-series': 'search · reader',
          'has-history': false
        })
      ]
    });
    const historyHeading = [...(page?.querySelectorAll('h3, h4') ?? [])]
      .find((heading) => heading.textContent === 'Quota history');
    const history = historyHeading?.closest('section');

    expect(history?.textContent).not.toContain('No quota observations are available');
    expect(history?.querySelector('.chart-legend')).not.toBeNull();
    expect(history?.querySelectorAll('.scatter-chart-point')).toHaveLength(2);
    expect(history?.querySelector('.line-chart-series')).toBeNull();
  });
});
