import { createDebug } from '../../debug.js';

const debug = createDebug('errors');

export const INGESTION_ERROR_CODES = /** @type {const} */ ({
  normalizationFailed: 'NORMALIZATION_FAILED',
  transactionAborted: 'TRANSACTION_ABORTED',
  quotaExceeded: 'QUOTA_EXCEEDED',
  relationshipValidationFailed: 'RELATIONSHIP_VALIDATION_FAILED'
});

export class CanonicalIngestionError extends Error {
  /**
   * @param {typeof INGESTION_ERROR_CODES[keyof typeof INGESTION_ERROR_CODES]} code
   * @param {string} phase
   * @param {unknown} cause
   */
  constructor(code, phase, cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`${code} during ${phase}: ${detail}`, { cause });
    this.name = 'CanonicalIngestionError';
    this.code = code;
    this.phase = phase;
    debug('ingestion-error-created', { code, phase, causeName: cause instanceof Error ? cause.name : typeof cause });
  }
}

/**
 * @param {unknown} error
 * @param {string} phase
 */
export function classifyIngestionError(error, phase) {
  // Browsers report storage exhaustion either as a DOMException or as a
  // standalone QuotaExceededError class, so classify by name.
  let code;
  if (typeof error === 'object'
    && error !== null
    && /** @type {{ name?: unknown }} */ (error).name === 'QuotaExceededError') {
    code = INGESTION_ERROR_CODES.quotaExceeded;
  } else {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('relationship validation failed')) {
      code = INGESTION_ERROR_CODES.relationshipValidationFailed;
    } else if (phase === 'adapting' || phase === 'normalizing') {
      code = INGESTION_ERROR_CODES.normalizationFailed;
    } else {
      code = INGESTION_ERROR_CODES.transactionAborted;
    }
  }
  debug('classified', { code, phase });
  return code;
}