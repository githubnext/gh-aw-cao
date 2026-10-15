import { recycleActivityCache } from '../cli/cache.mjs';

export function runRecycleCache({ options, option, retentionWindowMs, rejectUnknownOptions, UsageError }) {
  rejectUnknownOptions(options, ['input-dir', 'retention-days', 'max-bytes']);
  const bytes = option(options, 'max-bytes', false);
  if (bytes !== undefined && (!Number.isSafeInteger(Number(bytes)) || Number(bytes) < 1)) {
    throw new UsageError('--max-bytes must be a positive integer');
  }
  return recycleActivityCache(option(options, 'input-dir'), {
    maxBytes: bytes === undefined ? undefined : Number(bytes),
    retentionWindowMs: retentionWindowMs(options)
  });
}
