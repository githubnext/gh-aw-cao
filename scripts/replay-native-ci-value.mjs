import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJsonArchive, writeJsonArchive } from "../.github/skills/add-operational-value/scripts/json-archive.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = "docs/operational-value/proof/native-ci";
const module = "docs/operational-value/proof/functions/ci-coach.mjs";
const reports = `${directory}/reports`;
const timelineFile = `${reports}/github-gh-aw/ci-coach-timeline.json`;
const run = args => execFileSync(process.execPath, args, {
  cwd: root, timeout: 180000, maxBuffer: 8 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"],
});
const normalize = value => {
  const copy = structuredClone(value);
  delete copy.generatedAt;
  return copy;
};
run(["--test", "tests/unit/native-ci-value.test.mjs"]);
run([".github/skills/add-operational-value/scripts/verify-value-function.mjs", "--collector", module]);
let expected;
for (let pass = 0; pass < 3; pass++) {
  run([".github/skills/add-operational-value/scripts/evaluate.mjs", "--root", ".", "--function", module,
    "--output-dir", reports, "--end", "2026-10-18T15:00:12Z", "--refresh", "github/gh-aw", "ci-coach"]);
  const actual = normalize(readJsonArchive(path.join(root, timelineFile)));
  if (pass === 0) expected = actual;
  else assert.deepEqual(actual, expected, `Native CI timeline changed on refresh ${pass}`);
}
const { definition } = await import(new URL(`../${module}`, import.meta.url));
assert.equal(definition.nativeAssessment.nativeSubtotal, 9);
const receipt = {
  schemaVersion: 1, focusedTests: 9, actualCollectorVerified: true,
  initialStandardEvaluation: true, completeRefreshes: 2,
  exactTimelineParityIgnoringOnlyGeneratedAt: true,
  timelineFactsSha256: createHash("sha256").update(JSON.stringify(expected)).digest("hex"),
  nativeSubtotal: definition.nativeAssessment.nativeSubtotal,
  qualification: "Conditional native fuzz-selector coverage only; not eleven executions or measured CI efficiency",
  fullAcceptance: null, targetCodeExecuted: false,
};
writeJsonArchive(path.join(root, directory, "assessment.json.gz"), definition.nativeAssessment);
writeJsonArchive(path.join(root, directory, "replay-receipt.json"), receipt);
console.log(JSON.stringify(receipt));
