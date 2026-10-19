import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const unitDirectory = join(root, "tests", "unit");

export const unitTestAreas = {
  activity: [/^activity-/, /^actions-log\./, /^github-telemetry\./],
  dashboard: [/^dashboard-/, /^cli-action-/, /^coolify-deployment-/, /^server-azure-/],
  workflows: [
    /^workflow-contract-/, /^control-/, /^campaign-/, /^contoso-/,
    /^setup-github-apps\./, /^setup-hosted-cli-app\./, /^gh-aw-version-/, /^release-workflow\./, /^build-release\./,
    /^add-operational-value-skill\./, /^token-intervention-lifecycle\./,
  ],
  tooling: [
    /^cao-/, /^ops-publish/, /^optimization-/, /^dependabot-/,
    /^eslint-rules-/, /^actions-context\./, /^agent-plugin\./,
    /^install-script\./, /^quickstart\./, /^setup-terminal\./, /^repository-/, /^no-hardcoded-github-actions-url\./,
    /^token-optimization-data-contract\./, /^unit-area-selection\./,
    /^backfill-stress-report\./, /^source-map-compat\./,
  ],
  documentation: [
    /^docs-/, /^landing-page-/, /^catalog-page\./,
    /^agent-docs-validation\./, /^svg-visual-language\./,
  ],
};

export function partitionUnitTests(files) {
  const partition = Object.fromEntries(Object.keys(unitTestAreas).map((area) => [area, []]));
  for (const file of files) {
    const matches = Object.entries(unitTestAreas)
      .filter(([, patterns]) => patterns.some((pattern) => pattern.test(file)))
      .map(([area]) => area);
    if (matches.length !== 1) {
      throw new Error(`Unit test ${file} must belong to exactly one area (found: ${matches.join(", ") || "none"})`);
    }
    partition[matches[0]].push(file);
  }
  for (const [area, selected] of Object.entries(partition)) {
    if (selected.length === 0) throw new Error(`Unit test area ${area} has no tests`);
  }
  return partition;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const area = process.argv[2];
  if (!Object.hasOwn(unitTestAreas, area) || process.argv.length !== 3) {
    throw new Error(`Expected one unit test area: ${Object.keys(unitTestAreas).join(", ")}`);
  }
  const files = readdirSync(unitDirectory).filter((file) => file.endsWith(".test.mjs")).sort();
  const selected = partitionUnitTests(files)[area].map((file) => join(unitDirectory, file));
  const executable = process.env.CAO_EXECUTABLE || join(root, ".tmp", process.platform === "win32" ? "gh-cao.exe" : "gh-cao");
  const serverExecutable = process.env.CAO_DASHBOARD_EXECUTABLE || join(root, ".tmp", process.platform === "win32" ? "cao-dashboard.exe" : "cao-dashboard");
  if (!process.env.CAO_EXECUTABLE) {
    const build = spawnSync("go", ["build", "-o", executable, "./cmd/gh-cao"], { cwd: root, stdio: "inherit" });
    if (build.error) throw build.error;
    if (build.status !== 0) throw new Error(`Native Go test binary build failed (${build.signal ?? build.status}).`);
  }
  if (!process.env.CAO_DASHBOARD_EXECUTABLE) {
    const build = spawnSync("go", ["-C", "server", "build", "-o", serverExecutable, "./cmd/cao-dashboard"], { cwd: root, stdio: "inherit" });
    if (build.error) throw build.error;
    if (build.status !== 0) throw new Error(`Go dashboard server build failed (${build.signal ?? build.status}).`);
  }
  const result = spawnSync(process.execPath, ["--test", ...selected], {
    stdio: "inherit",
    env: { ...process.env, CAO_EXECUTABLE: executable, CAO_DASHBOARD_EXECUTABLE: serverExecutable },
  });
  if (result.error) throw result.error;
  if (result.signal) process.kill(process.pid, result.signal);
  process.exitCode = result.status ?? 1;
}
