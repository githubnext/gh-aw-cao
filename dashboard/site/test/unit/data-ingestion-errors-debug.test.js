import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.doUnmock('../../src/debug.js');
  vi.resetModules();
});

describe('data ingestion errors debug logging', () => {
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
    const { CanonicalIngestionError, classifyIngestionError } = await import('../../src/data/ingest/errors.js');

    classifyIngestionError(new Error('write failed'), 'staging');
    new CanonicalIngestionError('TRANSACTION_ABORTED', 'writing', new Error('write failed'));

    expect(output.debug).not.toHaveBeenCalled();
  });

  it('logs the classification outcome and error creation under its predictable category when enabled', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=errors', output })
      };
    });
    vi.resetModules();
    const { CanonicalIngestionError, classifyIngestionError, INGESTION_ERROR_CODES } = await import('../../src/data/ingest/errors.js');

    classifyIngestionError(new DOMException('Storage is full', 'QuotaExceededError'), 'staging');
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:errors]',
      'classified',
      { code: INGESTION_ERROR_CODES.quotaExceeded, phase: 'staging' }
    );

    output.debug.mockClear();
    classifyIngestionError(new Error('Canonical relationship validation failed'), 'writing');
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:errors]',
      'classified',
      { code: INGESTION_ERROR_CODES.relationshipValidationFailed, phase: 'writing' }
    );

    output.debug.mockClear();
    new CanonicalIngestionError('TRANSACTION_ABORTED', 'writing', new Error('write failed'));
    expect(output.debug).toHaveBeenCalledWith(
      '[cao:errors]',
      'ingestion-error-created',
      { code: 'TRANSACTION_ABORTED', phase: 'writing', causeName: 'Error' }
    );
  });

  it('never logs secrets, causes, or unconstrained error messages, only scalar diagnostic metadata', async () => {
    const output = { debug: vi.fn() };
    vi.doMock('../../src/debug.js', async () => {
      const actual = /** @type {typeof import('../../src/debug.js')} */ (
        await vi.importActual('../../src/debug.js')
      );
      return {
        ...actual,
        createDebug: (/** @type {string} */ category) =>
          actual.createDebug(category, { search: () => '?debug=errors', output })
      };
    });
    vi.resetModules();
    const { CanonicalIngestionError, classifyIngestionError } = await import('../../src/data/ingest/errors.js');

    classifyIngestionError(new Error('secret-token-abc123 write failed'), 'staging');
    new CanonicalIngestionError('TRANSACTION_ABORTED', 'writing', new Error('secret-token-abc123'));

    for (const call of output.debug.mock.calls) {
      const [, payload] = call;
      for (const value of Object.values(payload)) {
        expect(typeof value === 'string' || typeof value === 'number').toBe(true);
      }
      expect(JSON.stringify(payload)).not.toContain('secret-token-abc123');
    }
  });
});
