import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

describe('repository memory JSONL debug logging', () => {
  it('is disabled by default (no debug output) when the debug query is absent', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) => actual.createDebug(category, { search: () => '', output })
      };
    });
    vi.resetModules();
    const { prepareMemoryFile } = await import('../../src/data/repository-memory-jsonl.js');

    prepareMemoryFile('memory/notes.jsonl', '{"a":"1"}\n{"a":"2"}');
    prepareMemoryFile('memory/notes.jsonl', 'not json');

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs prepare and parse outcomes under its predictable category when enabled', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=repository-memory-jsonl', output })
      };
    });
    vi.resetModules();
    const { prepareMemoryFile } = await import('../../src/data/repository-memory-jsonl.js');

    prepareMemoryFile('memory/notes.jsonl', '{"a":"1"}\n{"a":"2"}');
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:repository-memory-jsonl]',
      'prepare-memory-file',
      { kind: 'jsonl', contentLength: 19 }
    );
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:repository-memory-jsonl]',
      'parse-jsonl',
      { outcome: 'parsed', recordCount: 2, columnCount: 1 }
    );

    output.debug.mockClear();
    prepareMemoryFile('memory/notes.jsonl', 'not json');
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:repository-memory-jsonl]',
      'parse-jsonl',
      { outcome: 'invalid-json', line: 1 }
    );

    output.debug.mockClear();
    prepareMemoryFile('memory/notes.txt', 'plain text');
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:repository-memory-jsonl]',
      'prepare-memory-file',
      { kind: 'other', contentLength: 10 }
    );
  });

  it('never logs file content, secrets, or record values, only scalar diagnostic metadata', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=repository-memory-jsonl', output })
      };
    });
    vi.resetModules();
    const { prepareMemoryFile } = await import('../../src/data/repository-memory-jsonl.js');

    prepareMemoryFile('memory/notes.jsonl', '{"token":"secret-token-abc123"}');

    for (const call of output.debug.mock.calls) {
      const [, , payload] = call;
      for (const value of Object.values(payload)) {
        expect(typeof value === 'string' || typeof value === 'number').toBe(true);
      }
      expect(JSON.stringify(payload)).not.toContain('secret-token-abc123');
    }
  });
});
