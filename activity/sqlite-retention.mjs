import { OPERATIONAL_VALUE_RETENTION_MS } from '../dashboard/site/src/data/storage/retention.js';

/**
 * @param {number | undefined} configuredDetail
 * @param {number | undefined} configuredRuns
 * @param {number} dayMs
 */
export function sqliteRetention(configuredDetail, configuredRuns, dayMs) {
  const otherWindow = configuredDetail ?? 30 * dayMs;
  return {
    retentionWindowMs: configuredDetail ?? 7 * dayMs,
    retentionWindowMsByStore: {
      runs: configuredRuns ?? otherWindow,
      operationalValues: Math.max(OPERATIONAL_VALUE_RETENTION_MS, configuredRuns ?? otherWindow)
    }
  };
}
