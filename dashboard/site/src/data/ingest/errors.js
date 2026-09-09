export const INGESTION_ERROR_CODES = /** @type {const} */ ({
  normalizationFailed: 'NORMALIZATION_FAILED',
  transactionAborted: 'TRANSACTION_ABORTED',
  quotaExceeded: 'QUOTA_EXCEEDED',
  generationIncomplete: 'GENERATION_INCOMPLETE',
  generationValidationFailed: 'GENERATION_VALIDATION_FAILED',
})

export class CanonicalIngestionError extends Error {
  /**
   * @param {typeof INGESTION_ERROR_CODES[keyof typeof INGESTION_ERROR_CODES]} code
   * @param {string} phase
   * @param {string | null} generation
   * @param {unknown} cause
   */
  constructor(code, phase, generation, cause) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    super(`${code} during ${phase}: ${detail}`, { cause })
    this.name = 'CanonicalIngestionError'
    this.code = code
    this.phase = phase
    this.generation = generation
  }
}

/**
 * @param {unknown} error
 * @param {string} phase
 */
export function classifyIngestionError(error, phase) {
  if (error instanceof DOMException && error.name === 'QuotaExceededError') {
    return INGESTION_ERROR_CODES.quotaExceeded
  }
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('relationship validation failed')) {
    return INGESTION_ERROR_CODES.generationValidationFailed
  }
  if (message.includes('is incomplete')) {
    return INGESTION_ERROR_CODES.generationIncomplete
  }
  if (phase === 'adapting' || phase === 'normalizing') {
    return INGESTION_ERROR_CODES.normalizationFailed
  }
  return INGESTION_ERROR_CODES.transactionAborted
}
