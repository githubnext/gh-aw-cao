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

  it('logs scalar-only metadata for start, buffer eviction, and read under its predictable category', async () => {
    const debugOutput = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=console-log-capture', output: debugOutput })
      };
    });
    vi.resetModules();
    const { createConsoleLogCapture: createConsoleLogCaptureWithDebug } = await import('../../src/console-log-capture.js');

    const output = {
      debug: vi.fn(),
      info: vi.fn(),
      log: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };
    const capture = createConsoleLogCaptureWithDebug(output);

    capture.start();
    expect(debugOutput.debug).toHaveBeenCalledWith('[cao:console-log-capture]', { event: 'started', methodCount: 5 });

    for (let index = 0; index < 1002; index += 1) {
      output.log(`entry ${index}`);
    }
    expect(debugOutput.debug).toHaveBeenCalledWith(
      '[cao:console-log-capture]',
      { event: 'buffer-limit-reached', maxEntries: 1000 }
    );
    expect(debugOutput.debug.mock.calls.filter(([, metadata]) => metadata.event === 'buffer-limit-reached')).toHaveLength(1);

    capture.text();
    expect(debugOutput.debug).toHaveBeenCalledWith('[cao:console-log-capture]', { event: 'read', entryCount: 1000 });

    for (const call of debugOutput.debug.mock.calls) {
      const metadata = call[1];
      expect(Object.values(metadata).every((value) => typeof value !== 'object')).toBe(true);
    }

    vi.doUnmock('../../src/debug.js');
    vi.resetModules();
  });

  it('is disabled by default (no debug output) when the debug query is absent', async () => {
    const debugOutput = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '', output: debugOutput })
      };
    });
    vi.resetModules();
    const { createConsoleLogCapture: createConsoleLogCaptureWithoutDebug } = await import('../../src/console-log-capture.js');

    const output = {
      debug: vi.fn(),
      info: vi.fn(),
      log: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };
    const capture = createConsoleLogCaptureWithoutDebug(output);

    capture.start();
    output.log('an entry');
    capture.text();

    expect(debugOutput.debug).not.toHaveBeenCalled();

    vi.doUnmock('../../src/debug.js');
    vi.resetModules();
  });
});
