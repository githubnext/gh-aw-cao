/**
 * Native operational-value collector records explicitly set `resultAvailable`
 * and retain the normalized metrics array; records missing that array are
 * malformed and should be retried instead of treated as complete cache hits.
 * Legacy cache records from the replay-era collector did not have that field,
 * but a retained observation payload means the evaluator produced displayable
 * evidence that must not be replaced by a later empty logs shard.
 *
 * @param {Record<string, unknown> | null | undefined} record
 */
export function hasOperationalValueResult(record) {
  if (record?.resultAvailable === true) return Array.isArray(record.metrics);
  if (record?.resultAvailable !== undefined) return false;
  return Boolean(record?.observation && typeof record.observation === "object" && !Array.isArray(record.observation));
}

/**
 * Shared observation timestamp precedence for native and legacy cache records.
 *
 * @param {Record<string, unknown>} record
 */
export function operationalValueRecordTime(record) {
  return record?.observedAt || record?.observation?.evidenceAt || record?.run?.createdAt || "";
}
