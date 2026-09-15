import { describe, expect, it } from 'vitest';
import { initialDashboardPageId } from '../../src/dashboard-route.js';

const pages = [
  { id: 'operations' },
  { id: 'packages' },
  { id: 'repository-detail' },
  { id: 'configuration' }
];

describe('dashboard startup route', () => {
  it('loads the page addressed by the current hash', () => {
    expect(initialDashboardPageId(pages, '#page-packages')).toBe('packages');
    expect(initialDashboardPageId(
      pages,
      '#page-repository-detail?repository=githubnext%2Fgh-aw-cao'
    )).toBe('repository-detail');
  });

  it('falls back to the first non-configuration page for invalid routes', () => {
    expect(initialDashboardPageId(pages, '#page-missing')).toBe('operations');
    expect(initialDashboardPageId(pages, '#page-%E0%A4%A')).toBe('operations');
    expect(initialDashboardPageId([{ id: 'configuration' }], '')).toBe('configuration');
  });
});
