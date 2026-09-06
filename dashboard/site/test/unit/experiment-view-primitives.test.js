import { describe, expect, it } from 'vitest';
import { numericObservation } from '../../src/components/experiment-view-primitives.js';

describe('numericObservation', () => {
  it('maps eval-sourced YES/NO results to 1/0 and unknown results to NaN', () => {
    expect(numericObservation({ sourceType: 'eval', result: 'YES' })).toBe(1);
    expect(numericObservation({ sourceType: 'eval', result: 'NO' })).toBe(0);
    expect(numericObservation({ sourceType: 'eval', result: 'MAYBE' })).toBeNaN();
  });

  it('parses non-eval results as finite numbers, otherwise NaN', () => {
    expect(numericObservation({ sourceType: 'metric', result: '3.5' })).toBe(3.5);
    expect(numericObservation({ sourceType: 'metric', result: 'not-a-number' })).toBeNaN();
  });
});
