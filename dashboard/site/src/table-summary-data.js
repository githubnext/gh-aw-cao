const RUN_SUMMARY_FIELDS = new Set(['run', 'run-link'])
const RUN_SUMMARY_LABELS = new Set(['run', 'run link', 'workflow run', 'workflow runs'])
const SUMMARY_TYPES = new Set(['boolean', 'nominal', 'ordinal', 'quantitative', 'temporal'])
const MAX_AUTOMATIC_HISTOGRAM_BINS = 48

/** @param {number} sampleSize */
function histogramBinCountForSampleSize(sampleSize) {
  return sampleSize > 0 ? Math.min(sampleSize, Math.ceil(Math.log2(sampleSize) + 1), MAX_AUTOMATIC_HISTOGRAM_BINS) : 0
}

/**
 * @typedef {{ field?: string, label: string, type?: string, display?: string, values: unknown[] }} TableSummaryColumn
 * @typedef {{ kind: 'none' } | { kind: 'empty', message: string } | { kind: 'boolean', ratio: number } | { kind: 'count', count: number } | { kind: 'categorical', values: Array<{ label: string, ratio: number }> } | { kind: 'quantitative', count: number, mean: number, deviation: number | null, bins: HistogramBin[] } | { kind: 'temporal', start: number, stop: number }} TableColumnSummary
 * @typedef {{ lower: number, upper: number, count: number }} HistogramBin
 */

/**
 * @param {TableSummaryColumn[]} columns
 * @returns {TableColumnSummary[]}
 */
export function summarizeTableColumns(columns) {
  return columns.map(summarizeTableColumn)
}

/**
 * @param {TableSummaryColumn} column
 * @returns {TableColumnSummary}
 */
function summarizeTableColumn(column) {
  if (['outcome-link', 'run-link', 'evidence-link'].includes(column.display ?? '') || !SUMMARY_TYPES.has(String(column.type ?? ''))) {
    return { kind: 'none' }
  }
  const values = column.values.filter((value) => value != null && value !== '')
  if (values.length === 0) {
    return { kind: 'empty', message: 'No values' }
  }
  if (column.type === 'boolean' || values.every((value) => typeof value === 'boolean')) {
    return {
      kind: 'boolean',
      ratio: values.filter((value) => value === true).length / values.length,
    }
  }
  if (column.type === 'quantitative') {
    const numericValues = values.map((value) => (typeof value === 'number' ? value : Number(value))).filter(Number.isFinite)
    if (numericValues.length === 0) {
      return { kind: 'empty', message: 'No numeric values' }
    }
    const mean = numericValues.reduce((total, value) => total + value, 0) / numericValues.length
    return {
      kind: 'quantitative',
      count: numericValues.length,
      mean,
      deviation:
        numericValues.length > 1 ? Math.sqrt(numericValues.reduce((total, value) => total + (value - mean) ** 2, 0) / (numericValues.length - 1)) : null,
      bins: binHistogramValues(numericValues),
    }
  }
  if (column.type === 'temporal') {
    const timestamps = values.map((value) => Date.parse(String(value))).filter(Number.isFinite)
    return timestamps.length > 0
      ? {
          kind: 'temporal',
          start: Math.min(...timestamps),
          stop: Math.max(...timestamps),
        }
      : { kind: 'empty', message: 'No timestamps' }
  }
  if (shouldRenderCountSummary(column)) {
    return { kind: 'count', count: values.length }
  }
  if (values.some((value) => typeof value === 'object')) {
    return { kind: 'none' }
  }
  /** @type {Map<string, number>} */
  const counts = new Map()
  for (const value of values) {
    const label = String(value)
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  return {
    kind: 'categorical',
    values: [...counts]
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 3)
      .map(([label, count]) => ({ label, ratio: count / values.length })),
  }
}

/**
 * @param {TableSummaryColumn} column
 * @returns {boolean}
 */
function shouldRenderCountSummary(column) {
  const type = String(column.type ?? '')
  if (!['nominal', 'ordinal', 'temporal'].includes(type)) {
    return false
  }
  const field = String(column.field ?? '').toLocaleLowerCase('en')
  const label = column.label.toLocaleLowerCase('en')
  return RUN_SUMMARY_FIELDS.has(field) || RUN_SUMMARY_LABELS.has(label)
}

/**
 * Uses Sturges' rule to choose a deterministic bin count from the sample size.
 * @param {number[]} values
 * @returns {number}
 */
export function automaticHistogramBinCount(values) {
  let sampleSize = 0
  for (const value of values) {
    if (Number.isFinite(value)) sampleSize += 1
  }
  return histogramBinCountForSampleSize(sampleSize)
}

/**
 * @param {number[]} values
 * @param {number} [binCount]
 * @returns {HistogramBin[]}
 */
export function binHistogramValues(values, binCount) {
  let sampleSize = 0
  let minimum = Infinity
  let maximum = -Infinity
  for (const value of values) {
    if (!Number.isFinite(value)) continue
    sampleSize += 1
    minimum = Math.min(minimum, value)
    maximum = Math.max(maximum, value)
  }
  if (sampleSize === 0) return []
  if (minimum === maximum) {
    return [{ lower: minimum, upper: maximum, count: sampleSize }]
  }

  const automaticBinCount = histogramBinCountForSampleSize(sampleSize)
  const count = Math.max(1, Math.min(Math.floor(binCount ?? automaticBinCount), sampleSize))
  const step = (maximum - minimum) / count
  const bins = Array.from({ length: count }, (_, index) => ({
    lower: minimum + index * step,
    upper: minimum + (index + 1) * step,
    count: 0,
  }))
  for (const value of values) {
    if (!Number.isFinite(value)) continue
    const index = Math.min(Math.floor((value - minimum) / step), count - 1)
    bins[index].count += 1
  }
  return bins
}
