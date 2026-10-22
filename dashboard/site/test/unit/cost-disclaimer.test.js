import { expect, it } from 'vitest';
import { renderDashboard } from '../../src/presenter.js';
import { authoritativeDashboard } from '../authoritative-dashboard.js';

it('renders the cost estimate disclaimer before charts without requiring cost data', () => {
  const page = authoritativeDashboard.dashboard.pages.find(
    (/** @type {{ id: string }} */ page) => page.id === 'cost'
  );
  const disclaimer = page.sections[0];
  expect(disclaimer).toMatchObject({
    id: 'cost-estimates',
    layout: 'full',
    description: 'All costs shown are estimates. Review your billing dashboard for precise numbers.'
  });
  expect(disclaimer.views).toEqual(page.views.map((/** @type {{ id: string }} */ view) => view.id));

  const rendered = renderDashboard({
    document: {
      languageVersion: '0.1.0',
      dashboard: {
        id: 'cost-disclaimer-test',
        title: 'Cost',
        pages: [page]
      }
    },
    sources: {}
  });
  const section = rendered.querySelector('[data-section-id="cost-estimates"]');
  expect(section?.textContent).toContain(disclaimer.description);
  const firstView = section?.querySelector('[data-view-id]');
  expect(firstView?.getAttribute('data-view-id')).toBe('cost-by-repository');
  expect(section?.textContent?.indexOf(disclaimer.description)).toBeLessThan(
    section?.textContent?.indexOf('Cost per repository') ?? -1
  );
});
