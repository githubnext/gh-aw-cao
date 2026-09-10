import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import {
  CanonicalIngestionError,
  classifyIngestionError,
  INGESTION_ERROR_CODES
} from '../../src/data/ingest/errors.js';
import { ingestDashboardSources } from '../../src/data/ingest/coordinator.js';

describe('canonical ingestion errors', () => {
  it('classifies quota, validation, and transaction failures', () => {
    expect(classifyIngestionError(
      new DOMException('Storage is full', 'QuotaExceededError'),
      'staging'
    )).toBe(INGESTION_ERROR_CODES.quotaExceeded);
    expect(classifyIngestionError(new Error('Canonical relationship validation failed'), 'writing'))
      .toBe(INGESTION_ERROR_CODES.relationshipValidationFailed);
    expect(classifyIngestionError(new Error('write failed'), 'staging'))
      .toBe(INGESTION_ERROR_CODES.transactionAborted);
  });

  it('wraps invalid source input with stable phase context', async () => {
    await expect(ingestDashboardSources(indexedDB, {
      repositories: { rows: [{ repository: 'missing-owner' }] }
    })).rejects.toMatchObject({
      name: 'CanonicalIngestionError',
      code: 'NORMALIZATION_FAILED',
      phase: 'normalizing'
    });
  });

  it('retains the underlying cause and safe diagnostic fields', () => {
    const cause = new Error('write failed');
    const error = new CanonicalIngestionError('TRANSACTION_ABORTED', 'writing', cause);

    expect(error.cause).toBe(cause);
    expect(error.message).toContain('TRANSACTION_ABORTED during writing');
  });
});