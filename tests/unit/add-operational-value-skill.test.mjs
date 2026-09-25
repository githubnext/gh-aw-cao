import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "../..");
const scripts = path.join(root, ".github/skills/add-operational-value/scripts");

test("skill uses query-first evidence without limiting history to source retention", () => {
  const skill = readFileSync(
    path.join(root, ".github/skills/add-operational-value/SKILL.md"),
    "utf8",
  );
  assert.match(skill, /Use a declarative query over canonical CAO data/);
  assert.match(skill, /temporary checkout of the target repository at the immutable cutoff/);
  assert.match(skill, /Query retention is a source limitation, not the operational-value history window/);
  assert.match(skill, /contemporaneous accepted snapshot was preserved/);
});

test("skill tests whether each measured phenomenon existed before adoption", () => {
  const skill = readFileSync(
    path.join(root, ".github/skills/add-operational-value/SKILL.md"),
    "utf8",
  );
  assert.match(skill, /Do not confuse workflow adoption with creation of the measured phenomenon/);
  assert.match(skill, /antecedent-existence test/);
  assert.match(skill, /pre-existing-and-reconstructable/);
  assert.match(skill, /pre-existing-but-not-reconstructable/);
  assert.match(skill, /created-at-adoption/);
  assert.match(skill, /same native formula, unit, population, grain, filters, and window/);
  assert.match(skill, /“the workflow did not exist yet” is not sufficient/);
  assert.match(skill, /Attainment-only is a fallback after an explicit failed reconstruction/);
});

test("campaign workflow listing returns only direct manifest worker workflows", () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "operational-value-campaign-list-"));
  mkdirSync(path.join(temporary, ".github/workflows"), { recursive: true });
  mkdirSync(path.join(temporary, "example"), { recursive: true });
  const workflow = (name, role) => `---
name: ${name}
imports:
  - uses: shared/control.md
    with:
      role: ${role}
---
# ${name}
`;
  writeFileSync(
    path.join(temporary, ".github/workflows/example.md"),
    workflow("example", "orchestrator"),
  );
  writeFileSync(
    path.join(temporary, ".github/workflows/example-worker.md"),
    workflow("example-worker", "worker"),
  );
  writeFileSync(
    path.join(temporary, ".github/workflows/unrelated.md"),
    workflow("unrelated", "worker"),
  );
  writeFileSync(path.join(temporary, "example/aw.yml"), `name: Example
includes:
  - ../aw.yml
  - .github/workflows/example.md
  - .github/workflows/example-worker.md
`);

  const output = execFileSync(
    process.execPath,
    [path.join(scripts, "list-workflows.mjs"), "--campaign", "example"],
    { cwd: temporary, encoding: "utf8" },
  );
  assert.equal(output, "example-worker\n");
  assert.equal(execFileSync(
    process.execPath,
    [path.join(scripts, "list-workflows.mjs"), "example-worker", "--campaign", "example"],
    { cwd: temporary, encoding: "utf8" },
  ), ".github/workflows/example-worker.md\n");
  assert.throws(() => execFileSync(
    process.execPath,
    [path.join(scripts, "list-workflows.mjs"), "example", "--campaign", "example"],
    { cwd: temporary, stdio: "pipe" },
  ), /workflow not found: example/);
  assert.throws(() => execFileSync(
    process.execPath,
    [path.join(scripts, "list-workflows.mjs"), "unrelated", "--campaign", "example"],
    { cwd: temporary, stdio: "pipe" },
  ), /workflow not found: unrelated/);
});

test("campaign wiring creates one standard adapter without unsupported manifest entries", () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "operational-value-campaign-wire-"));
  mkdirSync(path.join(temporary, "example/operational-value"), { recursive: true });
  writeFileSync(path.join(temporary, "example/aw.yml"), `name: Example
includes:
  - ../aw.yml
  - .github/workflows/example.md
`);
  writeFileSync(
    path.join(temporary, "example/operational-value/example.mjs"),
    "export const definition = {};\n",
  );
  const command = [
    path.join(scripts, "wire-campaign.mjs"),
    "example",
    "example",
    "--root",
    temporary,
  ];
  execFileSync(process.execPath, command);
  execFileSync(process.execPath, command);

  assert.equal(
    readFileSync(path.join(temporary, "example/operational-value.mjs"), "utf8"),
    readFileSync(path.join(root, ".github/skills/add-operational-value/templates/campaign-operational-value.mjs"), "utf8"),
  );
  const manifest = readFileSync(path.join(temporary, "example/aw.yml"), "utf8");
  assert.equal(manifest.includes("operational-value.mjs"), false);
  assert.equal(manifest.includes("operational-value/example.mjs"), false);
  assert.equal(manifest.endsWith("\n"), true);

  writeFileSync(path.join(temporary, "example/operational-value.mjs"), "custom adapter\n");
  assert.throws(
    () => execFileSync(process.execPath, command, { stdio: "pipe" }),
    /already exists and is not the standard campaign adapter/,
  );
});

test("CAO verification accepts namespaced metrics for multiple repositories", () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "operational-value-multi-repository-"));
  const source = path.join(root, "daily-file-diet/operational-value/daily-file-diet.mjs");
  const valueModule = path.join(temporary, "daily-file-diet.mjs");
  const adapter = path.join(temporary, "operational-value.mjs");
  writeFileSync(valueModule, `
import * as original from ${JSON.stringify(pathToFileURL(source).href)};
export const definition = {
  ...original.definition,
  evidence: {
    ...original.definition.evidence,
    repositories: ["github/gh-aw", "githubnext/gh-aw-cao"]
  }
};
export const collectBatch = original.collectBatch;
export const scoreMetric = original.scoreMetric;
`);
  writeFileSync(adapter, `
const request = JSON.parse(await new Promise((resolve) => {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => { input += chunk; });
  process.stdin.on("end", () => resolve(input));
}));
for (const repository of request.repositories) {
  for (const valueId of [
    "daily-file-diet.largest-file-health",
    "daily-file-diet.compliant-line-mass-share"
  ]) {
    const metricUnit = valueId.endsWith("largest-file-health") ? "score" : "share";
    console.log(JSON.stringify({repository, valueId, value: 0.5, metricUnit, timestamp: request.timestamp}));
  }
}
`);

  const output = execFileSync(
    process.execPath,
    [
      path.join(scripts, "verify-value-function.mjs"),
      "--cao-adapter",
      adapter,
      valueModule,
    ],
    { encoding: "utf8" },
  );
  assert.equal(output, `verified ${valueModule}\n`);
});

test("attainment evaluation includes dubious observations from adoption", () => {
  const temporary = mkdtempSync(path.join(os.tmpdir(), "operational-value-maturation-"));
  const source = path.join(root, "optimization/operational-value/optimization-token-optimizer.mjs");
  const valueModule = path.join(temporary, "maturation-test.mjs");
  const reports = path.join(temporary, "reports");
  writeFileSync(valueModule, `
import * as original from ${JSON.stringify(pathToFileURL(source).href)};
export const definition = {
  ...original.definition,
  slug: "maturation-test",
  sourcePath: ".github/workflows/maturation-test.md",
  evaluation: { mode: "attainment-only" }
};
export const collectBatch = (requests) => requests.map(() => ({
  evidence: {
    maturityStatus: "interim",
    dubious: true,
    eligibleWorkflowCount: 1,
    successfulRunCount: 1,
    successfulRunAicTotal: 0,
    concludedRunCount: 1,
    failedRunCount: 0,
    cancelledRunCount: 0,
    failedRunPercentagePointTotal: 0,
    cancelledRunPercentagePointTotal: 0
  },
  provenance: [{ repository: definition.repository, kind: "test-fixture", ref: definition.adoption.commit }]
}));
export const scoreMetric = original.scoreMetric;
`);

  execFileSync(
    process.execPath,
    [
      path.join(scripts, "evaluate.mjs"),
      "--function",
      valueModule,
      "--end",
      "2026-09-24T20:48:02Z",
      "--output-dir",
      reports,
      "--no-runs",
      "githubnext/gh-aw-cao",
      "maturation-test",
    ],
    { cwd: root, stdio: "pipe" },
  );
  const timeline = JSON.parse(readFileSync(
    path.join(reports, "githubnext-gh-aw-cao/maturation-test-timeline.json"),
    "utf8",
  ));
  assert.equal(
    timeline.snapshots[0].observedAt,
    timeline.valueFunction.definition.adoption.adoptedAt,
  );
  assert.equal(timeline.snapshots[0].evidence.maturityStatus, "interim");
  assert.equal(timeline.snapshots[0].evidence.dubious, true);
  assert.equal(timeline.snapshots[0].metrics["aic-per-successful-run"], 0);
});
