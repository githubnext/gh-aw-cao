import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { partitionUnitTests, unitTestAreas } from "../../scripts/run-unit-area.mjs";

test("every root unit test runs in exactly one topical area", () => {
  const files = readdirSync("tests/unit").filter((file) => file.endsWith(".test.mjs")).sort();
  const partition = partitionUnitTests(files);
  assert.deepEqual(Object.keys(partition), Object.keys(unitTestAreas));
  assert.deepEqual(Object.values(partition).flat().sort(), files);
  assert.ok(partition.tooling.includes("backfill-stress-report.test.mjs"));
  assert.ok(partition.tooling.includes("source-map-compat.test.mjs"));
  assert.throws(() => partitionUnitTests([...files, "unclassified.test.mjs"]), /exactly one area/);
});

test("CI runs every defined unit test area", () => {
  const workflow = readFileSync(".github/workflows/workflow-contracts.yml", "utf8").replaceAll("\r\n", "\n");
  const areas = /^\s+area: \[([^\]]+)\]/m.exec(workflow)?.[1].split(", ");
  assert.deepEqual(areas, Object.keys(unitTestAreas));
  assert.equal((workflow.match(/npm run test:unit:area -- \$\{\{ matrix\.area \}\}/g) ?? []).length, 1);
  assert.match(
    workflow,
    /name: Install dashboard dependencies\n\s+if: matrix\.area == 'dashboard'\n\s+run: npm ci --prefix dashboard\/site --ignore-scripts/,
  );
});
