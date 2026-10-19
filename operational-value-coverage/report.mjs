import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { readJsonArchive } from "../.github/skills/add-operational-value/scripts/json-archive.mjs";
import { eventPulse, timelinePulse } from "../.github/skills/add-operational-value/scripts/pulse-model.mjs";
import { renderPulse } from "../.github/skills/add-operational-value/scripts/render-pulse.mjs";
import { digest, localFile, readInventory, validatePlan, verifyPins, workKey } from "./coverage.mjs";

export const reportingChecklist = Object.freeze([
  "intent-and-executor", "adoption-and-predecessors", "frozen-native-contract",
  "collector-and-independent-replay", "evidence-identity-and-cutoff",
  "timeline-and-definitions", "html-and-json-plot", "repository-outcome-and-contribution",
  "partial-versus-full-attainment", "safeguards-and-attribution",
  "history-and-missing-versus-zero", "cost-and-unrated-decision",
]);

export function validateReport(root, plan, contract, manifest) {
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.key, workKey(plan, contract), "Report identity differs from frozen work");
  assert.equal(manifest.repository, plan.repository);
  assert.equal(manifest.workflow, contract.id);
  assert.ok(["native", "partial", "unavailable"].includes(manifest.disposition));
  verifyPins(root, manifest.files);
  for (const item of reportingChecklist) {
    const check = manifest.checks[item];
    assert.ok(check && ["verified", "unavailable"].includes(check.status)
      && typeof check.reason === "string" && check.reason.trim(), `Missing report check: ${item}`);
    assert.ok(Array.isArray(check.evidence) && check.evidence.length > 0
      && check.evidence.every(file => manifest.files.some(pin => pin.path === file)),
    `Missing retained reporting evidence: ${item}`);
  }
  assert.ok(["not-rated", "rated"].includes(manifest.decision));
  assert.ok(["not-measured", "matched"].includes(manifest.cost));
  assert.ok(typeof manifest.limitation === "string" && manifest.limitation.trim());
  if (manifest.disposition === "unavailable") {
    assert.ok(typeof manifest.blocker === "string" && manifest.blocker.trim());
    assert.equal(manifest.nativeEvaluated, false, "Gap disposition is not native measurement");
  } else {
    assert.equal(manifest.nativeEvaluated, true);
    for (const name of ["timeline", "definitions", "plotInput", "pulseJson", "pulseHtml"]) {
      assert.ok(manifest.files.some(pin => pin.path === manifest[name]), `Unpinned ${name}`);
    }
    execFileSync(process.execPath, [
      localFile(root, ".github/skills/add-operational-value/scripts/validate-report-artifacts.mjs"),
      localFile(root, manifest.timeline), localFile(root, manifest.definitions),
    ], { stdio: "pipe", timeout: 30_000 });
    const timeline = readJsonArchive(localFile(root, manifest.timeline));
    assert.equal(timeline.repository, plan.repository);
    assert.equal(timeline.workflowSlug, contract.id);
    assert.equal(timeline.valueFunction.sha256, contract.sha256, "Timeline used another contract");
    assert.ok(Date.parse(timeline.window.endAt) <= Date.parse(plan.until), "Timeline exceeds frozen cutoff");
    const metric = timeline.valueFunction.definition.metrics.find(item => item.id === manifest.metricId);
    assert.ok(metric && (manifest.disposition === "partial" || metric.role === "primary"),
      "Name the evaluated native metric; diagnostics do not establish full native evaluation");
    const input = readJsonArchive(localFile(root, manifest.plotInput));
    const model = input.kind === "operational-value-events" ? eventPulse(input) : timelinePulse(input);
    assert.equal(model.repository, plan.repository);
    assert.equal(model.workflowSlug, contract.id);
    assert.equal(model.sourcePath, `.github/workflows/${contract.id}.md`);
    assert.ok(Date.parse(model.window.endAt) <= Date.parse(plan.until), "Plot exceeds frozen cutoff");
    assert.ok(timeline.snapshots.some(snapshot => Number.isFinite(snapshot.metrics[manifest.metricId])),
      "All-unknown timeline is a gap, not a native evaluation");
    assert.equal(digest(readJsonArchive(localFile(root, manifest.pulseJson))), digest(model), "Pulse JSON differs from facts");
    assert.equal(readFileSync(localFile(root, manifest.pulseHtml), "utf8"), renderPulse(model), "Pulse HTML differs from facts");
  }
  return { key: manifest.key, disposition: manifest.disposition, reportManifestSha256: digest(manifest) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [root, planFile, workflow, manifestFile, ...extra] = process.argv.slice(2);
  assert.ok(root && planFile && workflow && manifestFile && !extra.length,
    "usage: report.mjs ROOT PLAN WORKFLOW MANIFEST");
  const plan = readJsonArchive(localFile(root, planFile));
  validatePlan(root, plan, readInventory(root, plan.portfolioPath));
  const contract = plan.cohorts.flatMap(cohort => cohort.workflows).find(item => item.id === workflow);
  assert.ok(contract, "Workflow is not assigned");
  console.log(JSON.stringify(validateReport(root, plan, contract, readJsonArchive(localFile(root, manifestFile))), null, 2));
}
