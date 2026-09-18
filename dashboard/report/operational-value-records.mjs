/**
 * Native operational-value collector records explicitly set `resultAvailable`.
 * Legacy cache records from the replay-era collector did not have that field,
 * but a retained observation payload means the evaluator produced displayable
 * evidence that must not be replaced by a later empty logs shard.
 *
 * @param {Record<string, unknown> | null | undefined} record
 */
export function hasOperationalValueResult(record) {
  return record?.resultAvailable === true
    || Boolean(record?.observation && typeof record.observation === "object" && !Array.isArray(record.observation));
}

/**
 * Shared observation timestamp precedence for native and legacy cache records.
 *
 * @param {Record<string, unknown>} record
 */
export function operationalValueRecordTime(record) {
  return record.observedAt || record.observation?.evidenceAt || record.run?.createdAt || "";
}
