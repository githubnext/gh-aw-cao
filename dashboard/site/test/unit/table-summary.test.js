// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { renderTableSummaryRow } from '../../src/components/table-summary.js'
import { summarizeTableColumns } from '../../src/table-summary-data.js'

/** @param {import('../../src/table-summary-data.js').TableSummaryColumn[]} columns */
function renderSummaries(columns) {
  const summaries = summarizeTableColumns(columns)
  return renderTableSummaryRow(
    summaries.map((summary, index) => ({
      ...summary,
      label: columns[index]?.label ?? '',
    })),
  )
}

describe('renderTableSummaryRow', () => {
  it('summarizes categorical values by frequency and percentage', () => {
    const rendered = renderSummaries([
      {
        label: 'Status',
        type: 'nominal',
        values: ['open', 'closed', 'open', 'open'],
      },
    ])

    expect(rendered.querySelectorAll('li')).toHaveLength(2)
    expect(rendered.textContent).toContain('open75%')
    expect(rendered.textContent).toContain('closed25%')
  })

  it('summarizes quantitative values and includes a histogram', () => {
    const rendered = renderSummaries([
      {
        label: 'Score',
        type: 'quantitative',
        values: [1, 2, 3],
      },
    ])

    expect(rendered.textContent).toContain('Mean2')
    expect(rendered.textContent).toContain('Stddev1')
    expect(rendered.textContent).not.toContain('Median')
    expect(rendered.querySelector('svg')?.getAttribute('aria-label')).toBe(
      'Score distribution, 3 values',
    )
  })

  it('reports an unavailable deviation for a single quantitative value', () => {
    const rendered = renderSummaries([
      {
        label: 'Score',
        type: 'quantitative',
        values: [4],
      },
    ])

    expect(rendered.textContent).toContain('StddevN/A')
  })

  it('summarizes temporal values by start, stop, and duration', () => {
    const rendered = renderSummaries([
      {
        label: 'Started',
        type: 'temporal',
        values: [
          '2026-08-31T14:25:55Z',
          '2026-08-31T13:25:23Z',
          'invalid',
          '2026-08-30T12:00:00Z',
        ],
      },
    ])

    expect(rendered.textContent).toContain('StartAug 30, 2026, 12:00 PM')
    expect(rendered.textContent).toContain('StopAug 31, 2026, 2:25 PM')
    expect(rendered.textContent).toContain('Duration1d 2h')
    expect(rendered.querySelector('.table-summary-categories')).toBeNull()
  })

  it('reports unavailable temporal values without treating them as categories', () => {
    const rendered = renderSummaries([
      {
        label: 'Started',
        type: 'temporal',
        values: ['invalid'],
      },
    ])

    expect(rendered.textContent).toBe('No timestamps')
  })

  it('auto-detects boolean values and summarizes their true percentage', () => {
    const rendered = renderSummaries([
      {
        label: 'Ready',
        type: 'nominal',
        values: [true, false, true, null],
      },
    ])

    expect(rendered.textContent).toBe('66.7% true')
  })

  it('leaves the summary empty when the column type is unknown', () => {
    const rendered = renderSummaries([
      {
        label: 'Unknown',
        values: ['alpha', 'bravo', 'charlie', null],
      },
    ])

    expect(rendered.querySelector('.table-summary-cell')?.textContent).toBe('')
  })

  it('leaves the summary empty when typed values have unknown meaning', () => {
    const rendered = renderSummaries([
      {
        label: 'Details',
        type: 'nominal',
        values: [{ label: 'alpha' }],
      },
    ])

    expect(rendered.querySelector('.table-summary-cell')?.textContent).toBe('')
  })

  it('leaves the summary empty for report link columns', () => {
    const rendered = renderSummaries([
      {
        label: 'Report',
        type: 'nominal',
        display: 'outcome-link',
        values: ['First report', 'Second report'],
      },
    ])

    expect(rendered.querySelector('.table-summary-cell')?.textContent).toBe('')
  })

  it('leaves the summary empty for run-linked text columns', () => {
    const rendered = renderSummaries([
      {
        label: 'Error',
        type: 'nominal',
        display: 'run-link',
        values: ['Target authority missing', 'Process failed'],
      },
    ])

    expect(rendered.querySelector('.table-summary-cell')?.textContent).toBe('')
  })

  it('leaves the summary empty for evidence-linked text columns', () => {
    const rendered = renderSummaries([
      {
        label: 'Work',
        type: 'nominal',
        display: 'evidence-link',
        values: ['Review dependency update', 'Review release evidence'],
      },
    ])

    expect(rendered.querySelector('.table-summary-cell')?.textContent).toBe('')
  })

  it('summarizes run-like columns and object values by item count', () => {
    const rendered = renderSummaries([
      {
        field: 'run',
        label: 'Run',
        type: 'nominal',
        values: ['1001', '1002'],
      },
      {
        field: 'run-link',
        label: 'Run Link',
        type: 'nominal',
        values: [{ href: 'https://example.com/runs/1', label: 'Run 1' }],
      },
    ])

    expect(
      [...rendered.querySelectorAll('.table-summary-count')].map(
        (node) => node.textContent,
      ),
    ).toEqual(['2 items', '1 item'])
    expect(rendered.textContent).not.toContain('[object Object]')
  })
})
