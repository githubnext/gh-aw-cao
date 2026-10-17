import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const scopes = {
  contracts: (file) => file !== ".github/workflows/cid.yml" && !file.startsWith("dashboard/site/"),
  dashboard: (file) => [
    ".github/workflows/cid.yml", "docs/assets/logo-day.svg", "docs/assets/logo-night.svg", "public/favicon.svg",
  ].includes(file) || (file.startsWith("dashboard/site/") && !file.endsWith(".md")),
  server: (file) => file === ".github/workflows/cgo.yml" || (file.startsWith("server/") && !file.endsWith(".md")),
};

export function scopeApplies(scope, files) {
  const matches = Object.hasOwn(scopes, scope) && scopes[scope];
  if (!matches) throw new Error(`Unknown CI scope: ${scope}`);
  return files.some((file) => {
    if (file === "scripts/ci-release-gates.mjs" || file.startsWith(".github/actions/ci-scope/")) return true;
    return matches(file);
  });
}

export function requireGate(needs) {
  if (needs.scope?.result !== "success") throw new Error("CI scope selection did not succeed");
  const applicable = needs.scope.outputs?.applicable;
  if (applicable !== "true" && applicable !== "false") throw new Error("CI scope output is missing or invalid");
  const jobs = Object.entries(needs).filter(([name]) => name !== "scope");
  if (!jobs.length) throw new Error("No CI producers were declared");
  const expected = applicable === "true" ? "success" : "skipped";
  for (const [name, job] of jobs) {
    if (job.result !== expected) throw new Error(`${name}: expected ${expected}, received ${job.result}`);
  }
  return applicable === "true" ? "Applicable CI succeeded" : "No applicable changes; CI intentionally skipped";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [mode, scope] = process.argv.slice(2);
    if (mode === "scope") {
      let applicable = true;
      if (process.env.GITHUB_EVENT_NAME === "pull_request") {
        // Checkout must be the synthetic PR merge with both parents available.
        const parents = execFileSync("git", ["rev-list", "--parents", "-n", "1", "HEAD"], { encoding: "utf8" }).trim().split(" ");
        if (parents.length !== 3) throw new Error("CI scope requires the pull-request merge commit");
        const files = execFileSync("git", ["diff", "--no-renames", "--name-only", "-z", "HEAD^1", "HEAD"], {
          encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
        }).split("\0").filter(Boolean);
        applicable = scopeApplies(scope, files);
      } else {
        scopeApplies(scope, []);
      }
      appendFileSync(process.env.GITHUB_OUTPUT, `applicable=${applicable}\n`);
    } else if (mode === "gate") {
      console.log(requireGate(JSON.parse(process.env.CI_NEEDS)));
    } else {
      throw new Error("Usage: node scripts/ci-release-gates.mjs scope <scope> | gate");
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
