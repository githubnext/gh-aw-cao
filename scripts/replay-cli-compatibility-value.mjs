import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJsonArchive } from "../.github/skills/add-operational-value/scripts/json-archive.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = path.join(root, "docs/operational-value/proof/cli-compatibility");
const module = "docs/operational-value/proof/functions/breaking-change-checker.mjs";
const reports = "docs/operational-value/proof/cli-compatibility/reports";
const timelineFile = path.join(root, reports, "github-gh-aw/breaking-change-checker-timeline.json");
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const normalized = value => {
  const copy = structuredClone(value);
  delete copy.generatedAt;
  return copy;
};
const expected = normalized(readJsonArchive(timelineFile));
const run = args => execFileSync(process.execPath, args, {
  cwd: root, timeout: 180000, maxBuffer: 8 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"],
});
run(["--test", "tests/unit/operational-value-cli-compatibility.test.mjs"]);
run([".github/skills/add-operational-value/scripts/verify-value-function.mjs", "--collector", module]);
for (let pass = 1; pass <= 2; pass++) {
  run([".github/skills/add-operational-value/scripts/evaluate.mjs", "--root", ".", "--function", module,
    "--output-dir", reports, "--end", "2026-10-18T15:00:12Z", "--refresh", "github/gh-aw", "breaking-change-checker"]);
  assert.deepEqual(normalized(readJsonArchive(timelineFile)), expected, `Native timeline changed on refresh ${pass}`);
}
const { definition } = await import(new URL(`../${module}`, import.meta.url));
const receipt = {
  schemaVersion: 1, actualCollectorVerified: true, focusedTests: 7, completeRefreshes: 2,
  exactTimelineParityIgnoringOnlyGeneratedAt: true, timelineFactsSha256: digest(expected),
  functionSha256: createHash("sha256").update(readFileSync(path.join(root, module))).digest("hex"),
  qualifiedWorkflows: definition.nativeAssessment.qualifiedWorkflows,
  nativeSubtotal: definition.nativeAssessment.nativeSubtotal,
  targetCodeExecuted: false, qualification: "One bounded automatic-migration repair, not full compatibility or original-report accuracy",
};
writeFileSync(path.join(directory, "assessment.json"), `${JSON.stringify(definition.nativeAssessment, null, 2)}\n`);
writeFileSync(path.join(directory, "replay-receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify(receipt));
