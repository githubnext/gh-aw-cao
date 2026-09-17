/**
 * Runs an asynchronous operation again after transient failures.
 *
 * @template T
 * @param {(attempt: number) => Promise<T>} operation
 * @param {{ attempts?: number, delayMs?: number }} [options]
 * @returns {Promise<T>}
 */
export async function withRetries(operation, options = {}) {
  const attempts = options.attempts ?? 3;
  const delayMs = options.delayMs ?? 250;
  if (!Number.isSafeInteger(attempts) || attempts < 1) {
    throw new TypeError('Retry attempts must be a positive integer.');
  }
  if (!Number.isFinite(delayMs) || delayMs < 0) {
    throw new TypeError('Retry delay must be a non-negative number.');
  }

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      if (attempt >= attempts) throw error;
      await new Promise((resolve) => {
        setTimeout(resolve, delayMs * (2 ** (attempt - 1)));
      });
    }
  }
}
