import { describe, expect, it } from 'vitest';
import {
  dashboardPageIds,
  lighthouseArguments,
  profiles,
  routeUrl
} from '../performance/pages-health.mjs';

describe('Pages health collector', () => {
  it('enumerates every unique declared page', () => {
    expect(dashboardPageIds({
      dashboard: { pages: [{ id: 'overview' }, { id: 'runs' }] }
    })).toEqual(['overview', 'runs']);
    expect(() => dashboardPageIds({
      dashboard: { pages: [{ id: 'overview' }, { id: 'overview' }] }
    })).toThrow(/missing or duplicate/);
  });

  it('builds encoded hash routes without losing the site base path', () => {
    expect(routeUrl('https://example.test/base/', 'cost center'))
      .toBe('https://example.test/base/#page-cost%20center');
  });

  it('defines desktop, mobile, and constrained-network Lighthouse profiles', () => {
    expect(profiles.map(({ id }) => id)).toEqual(['desktop', 'mobile', 'low-bandwidth']);
    expect(profiles.find(({ id }) => id === 'low-bandwidth').lighthouse)
      .toContain('--throttling.throughputKbps=400');
    expect(profiles.find(({ id }) => id === 'desktop').lighthouse)
      .toContain('--preset=desktop');
  });

  it('limits Lighthouse to performance and writes JSON evidence', () => {
    const args = lighthouseArguments(
      'https://example.test/#page-overview',
      '/tmp/evidence/report.json',
      profiles[0]
    );
    expect(args).toContain('--only-categories=performance');
    expect(args).toContain('--output=json');
    expect(args).toContain('--output-path=/tmp/evidence/report.json');
  });
});
