// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { createConsoleLogCapture } from '../../src/console-log-capture.js';

describe('console log capture', () => {
  it('captures formatted console output while preserving the original console call', () => {
    const output = {
      debug: vi.fn(),
      info: vi.fn(),
      log: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };
    const capture = createConsoleLogCapture(output);
    const originalWarn = output.warn;
    const circular = /** @type {Record<string, unknown>} */ ({ message: 'details' });
    circular.self = circular;

    capture.start();
    output.warn('Refresh failed', circular);

    expect(originalWarn).toHaveBeenCalledWith('Refresh failed', circular);
    expect(capture.text()).toContain(
      'WARN Refresh failed {"message":"details","self":"[Circular]"}'
    );
  });

  it('starts only once', () => {
    const output = {
      debug: vi.fn(),
      info: vi.fn(),
      log: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };
    const capture = createConsoleLogCapture(output);

    capture.start();
    capture.start();
    output.log('one entry');

    expect(capture.text().match(/LOG one entry/g)).toHaveLength(1);
  });
});
