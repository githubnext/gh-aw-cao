export function sqliteRetention(configuredDetail, configuredRuns, dayMs) {
  const otherWindow = configuredDetail ?? 30 * dayMs;
  return {
    retentionWindowMs: configuredDetail ?? 7 * dayMs,
    retentionWindowMsByStore: {
      runs: configuredRuns ?? otherWindow,
      operationalValues: otherWindow
    }
  };
}
