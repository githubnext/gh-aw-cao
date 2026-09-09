// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { automaticHistogramBinCount, binHistogramValues, renderHistogram } from '../../src/components/histogram.js'

describe('histogram', () => {
  it('bins finite values without losing the maximum boundary', () => {
    const bins = binHistogramValues([0, 1, 2, 3, 4], 4)

    expect(bins).toHaveLength(4)
    expect(bins.map((bin) => bin.count)).toEqual([1, 1, 1, 2])
  })

  it('selects a deterministic automatic bin count from finite samples', () => {
    expect(automaticHistogramBinCount([])).toBe(0)
    expect(automaticHistogramBinCount([1, 2, 3, 4])).toBe(3)
    expect(automaticHistogramBinCount([1, Number.NaN, 2])).toBe(2)
    expect(automaticHistogramBinCount(Array.from({ length: 100_000 }, (_, index) => index))).toBe(18)
  })

  it('renders a compact accessible SVG', () => {
    const rendered = renderHistogram({
      values: [1, 2, 2, 3],
      label: 'Latency distribution',
    })

    expect(rendered.tagName).toBe('svg')
    expect(rendered.getAttribute('role')).toBe('img')
    expect(rendered.getAttribute('aria-label')).toBe('Latency distribution')
    expect(rendered.querySelectorAll('rect')).toHaveLength(3)
    expect(rendered.querySelector('rect')?.getAttribute('style')).toContain('--chart-entry-index: 0')
  })
})
