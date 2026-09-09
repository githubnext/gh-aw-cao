import { describe, expect, it } from 'vitest'
import { dashboardPageIds, lighthouseArguments, profiles, routeUrl } from '../performance/pages-health-config.js'

describe('Pages health collector', () => {
  it('enumerates every unique declared page', () => {
    expect(
      dashboardPageIds({
        dashboard: { pages: [{ id: 'overview' }, { id: 'runs' }] },
      }),
    ).toEqual(['overview', 'runs'])
    expect(() =>
      dashboardPageIds({
        dashboard: { pages: [{ id: 'overview' }, { id: 'overview' }] },
      }),
    ).toThrow(/missing or duplicate/)
  })

  it('builds encoded hash routes without losing the site base path', () => {
    expect(routeUrl('https://example.test/base/', 'cost center')).toBe('https://example.test/base/#page-cost%20center')
  })

  it('defines desktop, mobile, and constrained-network Lighthouse profiles', () => {
    const desktop = profiles.find(({ id }) => id === 'desktop')
    const lowBandwidth = profiles.find(({ id }) => id === 'low-bandwidth')
    if (!desktop || !lowBandwidth) throw new Error('Expected Pages health profiles')
    expect(profiles.map(({ id }) => id)).toEqual(['desktop', 'mobile', 'low-bandwidth'])
    expect(lowBandwidth.lighthouse).toContain('--throttling.throughputKbps=400')
    expect(desktop.lighthouse).toContain('--preset=desktop')
  })

  it('limits Lighthouse to performance and writes JSON evidence', () => {
    const desktop = profiles.find(({ id }) => id === 'desktop')
    if (!desktop) throw new Error('Expected desktop profile')
    const args = lighthouseArguments('/path/to/lighthouse', 'https://example.test/#page-overview', '/tmp/evidence/report.json', desktop)
    expect(args).toContain('--only-categories=performance')
    expect(args).toContain('--output=json')
    expect(args).toContain('--output-path=/tmp/evidence/report.json')
  })
})
