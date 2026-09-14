// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { renderDashboard } from '../../src/presenter.js';

const authoritativeDashboardDocument = JSON.parse(
  readFileSync(`${process.cwd()}/dashboard.json`, 'utf8')
);

const metadata = {
  'source-id': 'cost-fixture',
  'source-kind': 'fixture',
  'as-of': '2026-08-31T05:00:00Z',
  'retrieved-at': '2026-08-31T05:01:00Z',
  completeness: /** @type {'partial'} */ ('partial'),
  freshness: /** @type {'fresh'} */ ('fresh'),
  availability: /** @type {'available'} */ ('available')
};

/** @param {HTMLElement} rendered */
async function activateCostPage(rendered) {
  const link = /** @type {HTMLAnchorElement | null} */ (rendered.querySelector('[data-nav-page-id="cost"]'));
  expect(link).not.toBeNull();
  link?.click();
  await vi.waitFor(() => {
    expect(rendered.querySelector('[data-page-id="cost"]')?.hasAttribute('data-page-pending')).toBe(false);
  });
  rendered.ownerDocument.defaultView?.history.replaceState(null, '', '/');
  return rendered.querySelector('[data-page-id="cost"]');
}

describe('Cost and efficiency dashboard view', () => {
  it('renders observed AI Credit usage as one full-view lazy table', async () => {
    const rendered = renderDashboard({
      document: authoritativeDashboardDocument,
      sources: {
        usage: {
          source: 'usage',
          rows: [
            { organization: 'githubnext', repository: 'gh-aw-cao', workflow: '.github/workflows/daily.md', run: '101', invocation: 'usage-1', aic: 3.5, 'estimated-usd': 0.0341, 'rollout-mode': 'review' },
            { organization: 'githubnext', repository: 'gh-aw-cao', workflow: '.github/workflows/daily.md', run: '101', invocation: 'usage-2', aic: 1.5, 'estimated-usd': 0.015, 'rollout-mode': 'live' },
            { organization: 'octo-org', repository: 'service', workflow: '.github/workflows/review.md', run: '202', invocation: 'usage-3', aic: 4, 'estimated-usd': 0.04, 'rollout-mode': 'unknown' }
          ],
          metadata
        }
      }
    });

    const page = await activateCostPage(rendered);
    const dashboardPage = authoritativeDashboardDocument.dashboard.pages.find(
      (/** @type {{ id: string }} */ candidate) => candidate.id === 'cost'
    );

    expect(dashboardPage).toMatchObject({ kind: 'custom', icon: 'meter' });
    expect(dashboardPage.sections).toBeUndefined();
    expect(dashboardPage.views).toHaveLength(1);
    expect(dashboardPage.views[0]).toMatchObject({
      id: 'cost-usage-records',
      mark: 'table',
      controls: 'interactive',
      'lazy-list': true,
      layout: 'full-view',
      data: { source: 'usage' }
    });
    expect(rendered.querySelector('[data-nav-page-id="cost"] .octicon-meter')).not.toBeNull();
    expect(page?.querySelectorAll('[data-view-layout="full-view"]')).toHaveLength(1);
    expect(page?.querySelector('[data-lazy-list]')).not.toBeNull();
    expect(page?.querySelectorAll('tbody tr')).toHaveLength(3);
    expect(page?.textContent).toContain('gh-aw-cao');
    expect(page?.textContent).toContain('service');
    expect([...page?.querySelectorAll('[data-field="aic"]') ?? []].map((cell) => cell.textContent)).toContain('4');
    expect([...page?.querySelectorAll('[data-field="estimated-usd"]') ?? []].map((cell) => cell.textContent)).toContain('0.034');
  });
});
