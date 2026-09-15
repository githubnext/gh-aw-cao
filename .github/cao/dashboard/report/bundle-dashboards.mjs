import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { actionsLog as log } from "../../activity/actions-log.mjs";
import { composeDashboardDocuments } from "./compose-dashboard-documents.mjs";

/** @typedef {import("./compose-dashboard-documents.mjs").DashboardDocument} DashboardDocument */

/**
 * @param {unknown} value
 * @param {string} source
 * @returns {DashboardDocument}
 */
function dashboard(value, source) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${source} is not a dashboard document`);
  }
  const candidate = /** @type {Record<string, unknown>} */ (value);
  if (typeof candidate["language-version"] !== "string" || candidate["language-version"].length === 0
      || !candidate.dashboard || typeof candidate.dashboard !== "object" || Array.isArray(candidate.dashboard)) {
    throw new Error(`${source} is not a dashboard document`);
  }
  const dashboardCandidate = /** @type {Record<string, unknown>} */ (candidate.dashboard);
  if (!Array.isArray(dashboardCandidate.pages) || dashboardCandidate.pages.length === 0) {
    throw new Error(`${source} is not a dashboard document`);
  }
  return /** @type {DashboardDocument} */ (value);
}

/**
 * @param {string} outputPath
 * @param {string} dashboardsDirectory
 */
export async function bundleDashboards(outputPath, dashboardsDirectory) {
  const entries = await readdir(dashboardsDirectory, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  await bundleDashboardFiles(
    outputPath,
    entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => path.join(dashboardsDirectory, entry.name)),
  );
}

/**
 * @param {string} outputPath
 * @param {string[]} dashboardPaths
 */
export async function bundleDashboardFiles(outputPath, dashboardPaths) {
  const primary = dashboard(JSON.parse(await readFile(outputPath, "utf8")), outputPath);
  const additions = await Promise.all(
    dashboardPaths.toSorted().map(async (source) => (
      dashboard(JSON.parse(await readFile(source, "utf8")), source)
    )),
  );
  await writeFile(outputPath, `${JSON.stringify(composeDashboardDocuments(primary, additions), null, 2)}\n`);
}

async function main() {
  const [, , outputPath, dashboardsDirectory] = process.argv;
  if (!outputPath || !dashboardsDirectory) {
    throw new Error("usage: bundle-dashboards.mjs OUTPUT_DASHBOARD DASHBOARDS_DIRECTORY");
  }
  log.group`Bundle dashboard documents`;
  try {
    await bundleDashboards(path.resolve(outputPath), path.resolve(dashboardsDirectory));
    log.info`Bundled dashboard documents into ${outputPath}`;
  } finally {
    log.endGroup();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch((error) => {
    log.error`${error instanceof Error ? error.stack || error.message : String(error)}`;
    process.exitCode = 1;
  });
}
