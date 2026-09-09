import { describe, expect, it } from 'vitest'
import { numericObservation, safeExperimentLink } from '../../src/components/experiment-view-primitives.js'

describe('numericObservation', () => {
  it('maps eval-sourced YES/NO results to 1/0 and unknown results to NaN', () => {
    expect(numericObservation({ sourceType: 'eval', result: 'YES' })).toBe(1)
    expect(numericObservation({ sourceType: 'eval', result: 'NO' })).toBe(0)
    expect(numericObservation({ sourceType: 'eval', result: 'MAYBE' })).toBeNaN()
  })

  it('parses non-eval results as finite numbers, otherwise NaN', () => {
    expect(numericObservation({ sourceType: 'metric', result: '3.5' })).toBe(3.5)
    expect(numericObservation({ sourceType: 'metric', result: 'not-a-number' })).toBeNaN()
  })
})

describe('safeExperimentLink', () => {
  it('returns null for non-object, missing, or unsafe-scheme values', () => {
    expect(safeExperimentLink(null)).toBeNull()
    expect(safeExperimentLink('https://example.com')).toBeNull()
    expect(safeExperimentLink({ href: 'javascript:alert(1)', label: 'bad' })).toBeNull()
  })

  it('returns a trimmed href/label pair for a safe https link', () => {
    expect(
      safeExperimentLink({
        href: 'https://example.com/run',
        label: '  Run 1  ',
      }),
    ).toEqual({
      href: 'https://example.com/run',
      label: 'Run 1',
    })
  })

  it('defaults the label to an empty string when absent', () => {
    expect(safeExperimentLink({ href: 'https://example.com/run' })).toEqual({
      href: 'https://example.com/run',
      label: '',
    })
  })
})
