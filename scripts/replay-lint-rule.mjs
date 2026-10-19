import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { cutoff, directory, hash, parserIdentity, validateCustody, coordinatedOriginals, selectedGraph } from "../docs/operational-value/proof/lint-rule/native.mjs";

const skill = ".github/skills/add-operational-value/scripts";
const names = ["eslint-miner", "eslint-refiner", "linter-miner"];
const run = args => execFileSync(process.execPath, args, { stdio: "inherit", timeout: 180000 });
run(["--test", "tests/unit/operational-value-lint-rule.test.mjs"]);
const workflows = {};
for (const name of names) {
  const modulePath = `docs/operational-value/proof/functions/${name}.mjs`;
  run([`${skill}/verify-value-function.mjs`, "--collector", modulePath]);
  run([`${skill}/evaluate.mjs`, "--root", process.cwd(), "--end", cutoff,
    "--output-dir", "docs/operational-value/proof/lint-rule/reports", "--function", modulePath, "--refresh", "github/gh-aw", name]);
  const report = JSON.parse(readFileSync(path.join(directory, "reports/github-gh-aw", `${name}-timeline.json`)));
  const known = report.snapshots.filter(snapshot => snapshot.metrics["observed-partial"] !== null);
  assert.equal(report.snapshots.length, name === "linter-miner" ? 23 : 17);
  assert.equal(known.length, 1);
  assert.equal(known[0].metrics["observed-partial"], name === "linter-miner" ? 2 : 1);
  for (let i = 1; i < report.snapshots.length; i++) {
    assert.equal(report.snapshots[i].window.startAt, report.snapshots[i - 1].window.endAt);
  }
  assert.equal(report.snapshots.at(-1).window.endAt, cutoff);
  assert.equal(report.snapshots.at(-1).metrics["observed-partial"], null);
  const module = await import(path.resolve(modulePath));
  workflows[name] = {
    module: modulePath, moduleSha256: hash(readFileSync(modulePath)),
    snapshots: report.snapshots.length, knownSelectedWindows: 1, unknownWindows: report.snapshots.length - 1,
    nativeQuantity: known[0].metrics["observed-partial"], unit: module.definition.metrics[0].unit,
    deliveredWindow: known[0].window,
    nativeCoverageClassification: name === "eslint-refiner"
      ? "Source-level compatibility facet only; real-target diagnostic coverage remains not measured"
      : "Bounded independently checked native repository improvement; not exhaustive workflow acceptance",
    fullGoal: null, allOutputDelivery: null, workflowAttribution: null, safety: null, costs: null, keepDecision: "not rated",
    sourceProfiles: known[0].evidence.sourceEra.profiles,
  };
}
const packet = validateCustody();
coordinatedOriginals();
const graph = selectedGraph(packet);
const assessment = {
  schemaVersion: 1, repository: "github/gh-aw", repositoryId: 1036865607,
  integrationCheckpoint: "ce52f9bb36e7a1747f544a912978a87c925fa096",
  revision: "c86377ec47b38f0b5af463277ee55d1d03d08da8", cutoff,
  sourceFirstContractSha256: hash(readFileSync(path.join(directory, "contract.json"))),
  retrospectiveFacetsSha256: hash(readFileSync(path.join(directory, "facets.json"))),
  discovery: { originalPartitions: 346, originalEntities: 58048,
    direct: { "eslint-miner": 68, "eslint-refiner": 176, "linter-miner": 115 },
    limitation: "Complete issue/PR discovery only; not exhaustive native outcomes, Discussions or comments" },
  custody: { rawGitObjects: packet.objects.size, unresolvedRequestedObjects: packet.custody.missing.length,
    coordinatedOriginalFiles: 49, selectedCorroboratedPRLinks: graph.links.length },
  toolchain: { bundledAcorn: parserIdentity(),
    go: execFileSync("go", ["version"], { encoding: "utf8" }).trim(),
    oracleSha256: hash(readFileSync(path.join(directory, "oracle.go"))) },
  workflows,
  coverage: { boundedNativeRepositoryImprovementWorkflows: 2, sourceCompatibilityOnlyWorkflows: 1,
    fullyAcceptedWorkflows: null,
    interpretation: "Do not add three fully native workflows to portfolio coverage. The refiner's latent source compatibility correction is not a real-target diagnostic outcome." },
  validation: { nativeTests: "passed", collectorChecks: 3, frozenCutoffRefreshes: 3,
    rootLint: "blocked: yaml and eslint are not installed; no installation performed",
    rootTypecheck: "blocked: TypeScript compiler is not installed; no installation performed",
    workflowCompile: "passed in authoring checkout; not required for offline evidence replay" },
  reusableLessons: [
    "Freeze predicates before candidate/result descriptions, not just before numeric scoring; preserve outcome-informed facets as retrospective.",
    "Follow rule delivery to actual native repository conditions. Do not treat declarations, registration, tests authored or merge success as those conditions.",
    "A latent standard-API compatibility correction can be retained separately, but neither its fixture nor its source allowlist proves real-target diagnostic defects resolved.",
    "context.Background replaced with context.TODO is not demonstrated context propagation. A lint waiver is not repair.",
    "Match retained native opportunities, exact arguments and function-local transitions; aggregate count coincidences alone are insufficient.",
    "Verify complete shared acquisition once per process, with source-specific semantics and digest-checked lossless originals.",
    "Pin source/executor eras and preserve unknown intermediate continuity; never backdate present queue policy or runtime identity."
  ],
};
writeFileSync(path.join(directory, "assessment.json"), JSON.stringify(assessment, null, 2) + "\n");
function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? files(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);
}
for (const filename of files(directory)) assert.ok(statSync(filename).size <= 256 * 1024, `Oversized artifact: ${filename}`);
console.log(JSON.stringify({ assessment: path.relative(process.cwd(), path.join(directory, "assessment.json")),
  sha256: hash(readFileSync(path.join(directory, "assessment.json"))),
  observations: Object.fromEntries(Object.entries(workflows).map(([name, result]) => [name, result.nativeQuantity])) }));
