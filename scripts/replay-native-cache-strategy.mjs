import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJsonArchive, writeJsonArchive } from "../.github/skills/add-operational-value/scripts/json-archive.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = "docs/operational-value/proof/native-cache-strategy";
const module = "docs/operational-value/proof/functions/daily-cache-strategy-analyzer.mjs";
const reports = `${directory}/reports`;
const timelineFile = `${reports}/github-gh-aw/daily-cache-strategy-analyzer-timeline.json`;
const run = args => execFileSync(process.execPath, args, {
  cwd: root, timeout: 180000, maxBuffer: 8 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"],
});
run(["--test", "tests/unit/native-cache-strategy-value.test.mjs", "tests/unit/native-cache-dependency-value.test.mjs"]);
run([".github/skills/add-operational-value/scripts/verify-value-function.mjs", "--collector", module]);
let expected;
for (let pass = 0; pass < 3; pass++) {
  run([".github/skills/add-operational-value/scripts/evaluate.mjs", "--root", ".", "--function", module,
    "--output-dir", reports, "--end", "2026-10-18T15:00:12Z", "--refresh", "--no-runs",
    "github/gh-aw", "daily-cache-strategy-analyzer"]);
  const timeline = structuredClone(readJsonArchive(path.join(root, timelineFile)));
  delete timeline.generatedAt;
  if (pass === 0) expected = timeline;
  else assert.deepEqual(timeline, expected, `Cache timeline changed on refresh ${pass}`);
}
const { definition } = await import(new URL(`../${module}`, import.meta.url));
assert.equal(definition.nativeAssessment.nativeUnits, 1);
const receipt = {
  schemaVersion: 1, focusedTests: 15, actualCollectorVerified: true,
  initialStandardEvaluation: true, completeRefreshes: 2,
  exactTimelineParityIgnoringOnlyGeneratedAt: true,
  timelineFactsSha256: createHash("sha256").update(JSON.stringify(expected)).digest("hex"),
  nativeSubtotal: 1, qualification: "One conditional cache-persistence dependency-gate repair; not a measured cache hit or saving.",
  targetCodeExecuted: false, fullAcceptance: null, workflowContribution: null,
};
writeJsonArchive(path.join(root, directory, "assessment.json.gz"), definition.nativeAssessment);
writeJsonArchive(path.join(root, directory, "replay-receipt.json"), receipt);
console.log(JSON.stringify(receipt));
