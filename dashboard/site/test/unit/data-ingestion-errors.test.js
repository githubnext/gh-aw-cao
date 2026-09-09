import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import {
  CanonicalIngestionError,
  classifyIngestionError,
  INGESTION_ERROR_CODES
} from '../../src/data/ingest/errors.js';
import { ingestDashboardSources } from '../../src/data/ingest/coordinator.js';

describe('canonical ingestion errors', () => {
  it('classifies quota, incomplete, validation, and transaction failures', () => {
    expect(classifyIngestionError(
      new DOMException('Storage is full', 'QuotaExceededError'),
      'staging'
    )).toBe(INGESTION_ERROR_CODES.quotaExceeded);
    expect(classifyIngestionError(new Error('Generation a is incomplete'), 'activating'))
      .toBe(INGESTION_ERROR_CODES.generationIncomplete);
    expect(classifyIngestionError(new Error('Generation relationship validation failed'), 'activating'))
      .toBe(INGESTION_ERROR_CODES.generationValidationFailed);
    expect(classifyIngestionError(new Error('write failed'), 'staging'))
      .toBe(INGESTION_ERROR_CODES.transactionAborted);
  });

  it('wraps invalid source input with stable phase context', async () => {
    await expect(ingestDashboardSources(indexedDB, {})).rejects.toMatchObject({
      name: 'CanonicalIngestionError',
      code: 'NORMALIZATION_FAILED',
      phase: 'adapting',
      generation: null
    });
  });

  it('retains the underlying cause and safe diagnostic fields', () => {
    const cause = new Error('write failed');
    const error = new CanonicalIngestionError('TRANSACTION_ABORTED', 'staging', 'generation-a', cause);

    expect(error.cause).toBe(cause);
    expect(error.message).toContain('TRANSACTION_ABORTED during staging');
  });
});