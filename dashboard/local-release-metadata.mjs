import { parseVersion, updateState } from "../activity/version.mjs";

export function refreshCanonicalCompilerRelease(value, latestVersion) {
  if (value?.kind !== "record" || value.collection !== "workflows") return value;
  return {
    ...value,
    record: {
      ...value.record,
      ghAwCurrentVersion: latestVersion,
      ghAwUpdateState: updateState(value.record.ghAwVersion, latestVersion),
    },
  };
}

/**
 * Enrich snapshot inputs before canonical ingestion without changing installed
 * version evidence or its observation time.
 * @param {Record<string, { rows: Record<string, unknown>[], [key: string]: unknown }>} sources
 * @param {string} latestVersion
 */
export function refreshDashboardCompilerRelease(sources, latestVersion) {
  const parsed = parseVersion(latestVersion);
  if (!parsed || parsed.prerelease.length > 0) {
    throw new Error("GitHub returned an invalid latest stable gh-aw release.");
  }
  if (!sources.workflows) return sources;
  if (!Array.isArray(sources.workflows.rows)) {
    throw new Error("Dashboard workflow inventory does not contain source rows.");
  }
  return {
    ...sources,
    workflows: {
      ...sources.workflows,
      rows: sources.workflows.rows.map((row) => ({
        ...row,
        "gh-aw-current-version": parsed.normalized,
        "gh-aw-update-state": updateState(row["gh-aw-version"], parsed.normalized),
      })),
    },
  };
}
