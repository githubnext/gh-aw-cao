import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { digest, localFile, verifyPins } from "./artifact-files.mjs";
import { isIsoUtc, isRepository, isSlug } from "./common.mjs";
import { readJsonArchive } from "./json-archive.mjs";
import { eventPulse, timelinePulse } from "./pulse-model.mjs";
import { renderPulse } from "./render-pulse.mjs";

export const reportingChecklist = Object.freeze([
  "intent-and-executor", "adoption-and-predecessors", "frozen-native-contract",
  "collector-and-independent-replay", "evidence-identity-and-cutoff",
  "timeline-and-definitions", "html-and-json-plot", "repository-outcome-and-contribution",
  "partial-versus-full-attainment", "safeguards-and-attribution",
  "history-and-missing-versus-zero", "cost-and-unrated-decision",
]);

export function validateReportCompleteness(root, expected, manifest) {
  assert.match(expected.key, /^[a-f0-9]{64}$/);
  assert.match(expected.contractSha256, /^[a-f0-9]{64}$/);
  assert.ok(isRepository(expected.repository) && isSlug(expected.workflow) && isIsoUtc(expected.until));
  assert.ok(typeof expected.sourcePath === "string" && expected.sourcePath.trim());
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.key, expected.key, "Report identity differs from frozen work");
  assert.equal(manifest.repository, expected.repository);
  assert.equal(manifest.workflow, expected.workflow);
  assert.ok(["native", "partial", "unavailable"].includes(manifest.disposition));
  verifyPins(root, manifest.files);
  for (const item of reportingChecklist) {
    const check = manifest.checks?.[item];
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
      path.join(import.meta.dirname, "validate-report-artifacts.mjs"),
      localFile(root, manifest.timeline), localFile(root, manifest.definitions),
    ], { stdio: "pipe", timeout: 30_000 });
    const timeline = readJsonArchive(localFile(root, manifest.timeline));
    assert.equal(timeline.repository, expected.repository);
    assert.equal(timeline.workflowSlug, expected.workflow);
    assert.equal(timeline.valueFunction.sha256, expected.contractSha256, "Timeline used another contract");
    assert.ok(Date.parse(timeline.window.endAt) <= Date.parse(expected.until), "Timeline exceeds frozen cutoff");
    const metric = timeline.valueFunction.definition.metrics.find(item => item.id === manifest.metricId);
    assert.ok(metric && (manifest.disposition === "partial" || metric.role === "primary"),
      "Name the evaluated native metric; diagnostics do not establish full native evaluation");
    const input = readJsonArchive(localFile(root, manifest.plotInput));
    const model = input.kind === "operational-value-events" ? eventPulse(input) : timelinePulse(input);
    assert.equal(model.repository, expected.repository);
    assert.equal(model.workflowSlug, expected.workflow);
    assert.equal(model.sourcePath, expected.sourcePath);
    assert.ok(Date.parse(model.window.endAt) <= Date.parse(expected.until), "Plot exceeds frozen cutoff");
    assert.ok(timeline.snapshots.some(snapshot => Number.isFinite(snapshot.metrics[manifest.metricId])),
      "All-unknown timeline is a gap, not a native evaluation");
    assert.equal(digest(readJsonArchive(localFile(root, manifest.pulseJson))), digest(model), "Pulse JSON differs from facts");
    assert.equal(readFileSync(localFile(root, manifest.pulseHtml), "utf8"), renderPulse(model), "Pulse HTML differs from facts");
  }
  return { key: manifest.key, disposition: manifest.disposition, reportManifestSha256: digest(manifest) };
}

if (process.argv[1] && existsSync(process.argv[1])
  && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const [root, expectedFile, manifestFile, ...extra] = process.argv.slice(2);
  assert.ok(root && expectedFile && manifestFile && !extra.length,
    "usage: report-completeness.mjs ROOT EXPECTED_IDENTITY MANIFEST");
  console.log(JSON.stringify(validateReportCompleteness(root,
    readJsonArchive(localFile(root, expectedFile)), readJsonArchive(localFile(root, manifestFile))), null, 2));
}
