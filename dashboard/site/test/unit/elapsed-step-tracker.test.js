import { describe, expect, it, vi } from 'vitest';
import { createElapsedStepTracker } from '../../src/elapsed-step-tracker.js';

describe('elapsed step tracker', () => {
  it('tracks current and completed step durations independently', () => {
    const now = vi.fn()
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(2_000)
      .mockReturnValueOnce(2_000)
      .mockReturnValueOnce(5_000);
    const tracker = createElapsedStepTracker('Preparing...', { now });

    tracker.advance('Parsing...');

    expect(tracker.snapshot()).toEqual({
      message: 'Parsing... +3s',
      history: ['Preparing... +2s', 'Parsing... +3s']
    });
  });

  it('updates one phase in place and bounds completed history', () => {
    const tracker = createElapsedStepTracker('Preparing...', {
      historyLimit: 2,
      now: () => 0
    });

    tracker.update('Parsed 1 record.', 'parsing');
    tracker.update('Parsed 2 records.', 'parsing');
    tracker.advance('Storing...');

    expect(tracker.snapshot().history).toEqual([
      'Parsed 2 records. +0s',
      'Storing... +0s'
    ]);
  });
});
