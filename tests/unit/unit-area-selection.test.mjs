import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";
import { partitionUnitTests, unitTestAreas } from "../../scripts/run-unit-area.mjs";

test("every root unit test runs in exactly one topical area", () => {
  const files = readdirSync("tests/unit").filter((file) => file.endsWith(".test.mjs")).sort();
  const partition = partitionUnitTests(files);
  assert.deepEqual(Object.keys(partition), Object.keys(unitTestAreas));
  assert.deepEqual(Object.values(partition).flat().sort(), files);
  assert.ok(partition.tooling.includes("backfill-stress-report.test.mjs"));
  assert.ok(partition.tooling.includes("source-map-compat.test.mjs"));
  assert.ok(partition.workflows.includes("build-release.test.mjs"));
  assert.throws(() => partitionUnitTests([...files, "unclassified.test.mjs"]), /exactly one area/);
});

test("CI runs every defined unit test area", () => {
  const workflow = readFileSync(".github/workflows/workflow-contracts.yml", "utf8").replaceAll("\r\n", "\n");
  const areas = /^\s+area: \[([^\]]+)\]/m.exec(workflow)?.[1].split(", ");
  assert.deepEqual(areas, Object.keys(unitTestAreas));
  assert.equal((workflow.match(/npm run test:unit:area -- \$\{\{ matrix\.area \}\}/g) ?? []).length, 1);
  assert.match(
    workflow,
    /name: Install dashboard dependencies\n\s+if: matrix\.area == 'dashboard'\n\s+run: npm ci --prefix dashboard\/site$/m,
  );
});

test("native dashboard contract jobs install pinned Go and build the production server before testing", () => {
  const workflow = parse(readFileSync(".github/workflows/workflow-contracts.yml", "utf8"));
  for (const [jobId, testCommand] of [
    ["unit", "npm run test:unit:area"],
    ["full-contracts", "npm run test:integration"],
  ]) {
    const steps = workflow.jobs[jobId].steps;
    const goIndex = steps.findIndex((step) => step.uses?.startsWith("actions/setup-go@"));
    const buildIndex = steps.findIndex((step) => step.name === "Build native dashboard server");
    const testIndex = steps.findIndex((step) => step.run?.includes(testCommand));
    assert.ok(goIndex >= 0 && goIndex < buildIndex && buildIndex < testIndex, `${jobId} must build Go before testing`);
    assert.match(steps[goIndex].uses, /^actions\/setup-go@[a-f0-9]{40}$/);
    assert.equal(steps[goIndex].with["go-version-file"], "go.mod");
    assert.equal(steps[buildIndex].run, "npm --prefix dashboard/site run build:preview");
  }
});

test("site browser runner builds a native preview without Node terminal preparation", () => {
  const manifest = JSON.parse(readFileSync("dashboard/site/package.json", "utf8"));
  assert.equal(manifest.scripts["pretest:e2e"], "npm run build:preview");
  assert.equal(manifest.scripts["build:preview"], "go -C ../.. build -o .tmp/gh-cao ./cmd/gh-cao");
  assert.equal(manifest.dependencies["node-pty"], undefined);
  assert.equal(manifest.scripts.postinstall, undefined);
});

test("browser and worker memory fixtures explicitly exercise IndexedDB", () => {
  for (const file of [
    "tests/e2e/dashboard-mobile-live.spec.mjs",
    "tests/e2e/dashboard-overview-memory.spec.mjs",
    "tests/e2e/dashboard-worker-memory-trace.mjs",
  ]) {
    assert.match(readFileSync(file, "utf8"), /dataBackend: ["']indexeddb["']/, file);
  }
});
