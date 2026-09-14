import { afterEach, describe, expect, it, vi } from 'vitest';
import { debounce } from '../../src/debounce.js';

describe('debounce', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('invokes the callback once with the latest arguments after the delay', () => {
    vi.useFakeTimers();
    const callback = vi.fn();
    const debounced = debounce(callback, 500);

    debounced('first');
    vi.advanceTimersByTime(200);
    debounced('second');
    vi.advanceTimersByTime(499);

    expect(callback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(callback).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith('second');
  });

  it('supports cancelling a pending invocation', () => {
    vi.useFakeTimers();
    const callback = vi.fn();
    const debounced = debounce(callback, 500);

    debounced();
    debounced.cancel();
    vi.runAllTimers();

    expect(callback).not.toHaveBeenCalled();
  });
});
