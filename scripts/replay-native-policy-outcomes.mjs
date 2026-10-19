import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  hash, modelGap, original, proofRoot, readProof, replayNetwork, replaySetup, sourceText,
} from "./native-policy-outcomes.mjs";

export async function replay() {
  const originals = readdirSync(path.join(proofRoot, "originals")).sort();
  for (const file of originals) original(`docs/operational-value/proof/native-policy-outcomes/originals/${file}`);
  const goals = readProof("source-closure.json.gz").closure;
  const sourceHistory = {};
  for (const [slug, row] of Object.entries(goals)) {
    sourceHistory[slug] = row.profiles.map(source => {
      const content = sourceText(source);
      const body = content.slice(content.indexOf("\n---", 4) + 4);
      return { revision: source.revision, blob: source.blob, bodySha256: hash(body) };
    });
    sourceText(row.compiledAtCutoff);
  }
  const modules = [
    "weekly-network-domains-audit", "daily-workflow-security-model", "daily-action-setup-security-audit",
  ];
  const reports = {};
  for (const slug of modules) {
    const module = await import(`../docs/operational-value/proof/functions/${slug}.mjs`);
    const file = path.join(proofRoot, "reports/github-gh-aw", `${slug}-timeline.json`);
    const timeline = JSON.parse(readFileSync(file));
    assert.deepEqual(timeline.valueFunction.definition, module.definition, `Frozen definition changed: ${slug}`);
    const requests = timeline.snapshots.map(row => ({
      windowStart: row.window.startAt, windowEnd: row.window.endAt, observedAt: row.observedAt,
    }));
    const collected = await module.collectBatch(requests);
    const ids = new Set();
    const periods = collected.map((row, index) => {
      const value = module.scoreMetric("native-deliveries", row.evidence);
      assert.equal(value, timeline.snapshots[index].metrics["native-deliveries"], `Replay changed period: ${slug}`);
      assert.deepEqual(row.evidence, timeline.snapshots[index].evidence, `Replay changed evidence: ${slug}`);
      for (const event of row.evidence.events) {
        assert.ok(!ids.has(event.id), `Repeated lifetime delivery: ${event.id}`);
        ids.add(event.id);
      }
      return { ...requests[index], nativeValue: value, missingReason: row.evidence.missingReason,
        coverageStatus: row.evidence.coverageStatus, knownPreparationFailures: row.evidence.knownPreparationFailures };
    });
    const known = periods.filter(row => row.nativeValue !== null);
    reports[slug] = {
      nativeCoverage: known.length ? "bounded-native-subtotal" : "gap-not-native-coverage",
      acceptedNativeSubtotal: known.length ? known.reduce((sum, row) => sum + row.nativeValue, 0) : null,
      measuredPeriods: known.length, missingPeriods: periods.length - known.length, totalPeriods: periods.length,
      fullAcceptance: null, safeguards: "Not comprehensively replayed; bounded native postconditions only.",
      workflowContribution: null, costs: null, decision: "not-rated", periods,
    };
  }
  assert.equal(reports["weekly-network-domains-audit"].acceptedNativeSubtotal, 3);
  assert.equal(reports["daily-action-setup-security-audit"].acceptedNativeSubtotal, 2);
  assert.equal(reports["daily-workflow-security-model"].acceptedNativeSubtotal, null);
  const native = { network: replayNetwork(), setup: replaySetup(), model: modelGap() };
  return {
    schemaVersion: 1, kind: "native-policy-outcomes-independent-replay",
    scope: readProof("source-history.json.gz").scope,
    toolchain: {
      node: process.version, platform: process.platform,
      git: execFileSync("git", ["--version"], { encoding: "utf8" }).trim(),
      bash: execFileSync("bash", ["--version"], { encoding: "utf8" }).split("\n")[0],
    },
    originalsVerified: originals.length, sourceHistory, reports, native,
    coverage: { attemptedWorkflows: 3, workflowsWithBoundedNativeOutcomes: 2, honestGapReports: 1 },
    isolation: "No network, no shared Git cache, no shared output/Discussion acquisition and no target workflow execution during replay.",
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const receipt = await replay();
  const output = `${JSON.stringify(receipt, null, 2)}\n`;
  if (process.argv[2]) writeFileSync(process.argv[2], output);
  console.log(JSON.stringify({ coverage: receipt.coverage, originalsVerified: receipt.originalsVerified,
    reports: Object.fromEntries(Object.entries(receipt.reports).map(([slug, row]) =>
      [slug, { subtotal: row.acceptedNativeSubtotal, measuredPeriods: row.measuredPeriods, missingPeriods: row.missingPeriods }])) }));
}
