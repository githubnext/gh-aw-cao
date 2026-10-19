import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { smokeCases, smokeDigest, smokeRead } from "./native-smoke-value.mjs";
import { smokeBehaviorProofs } from "./collect-smoke-native-evidence.mjs";

const root = "docs/operational-value/proof/smoke-native";
const contracts = smokeRead(path.join(root, "contracts.json"));
const coverage = { schemaVersion: 1, kind: "workflow-native-value-coverage", family: "smoke",
  repository: "github/gh-aw", repositoryId: 1036865607, sourceRevision: contracts[0].sourceRevision,
  until: contracts[0].until, functions: 3, evaluated: 3, nativeMeasured: 0, evidenceBlocked: 0,
  workflows: [], costs: "not-measured", decision: "not-rated",
  integrationPaths: { contracts: path.join(root, "contracts.json"), coverage: path.join(root, "coverage.json"),
    functions: "docs/operational-value/proof/functions/smoke-{agy,aider,claude-copilot}.mjs",
    evidence: root, reports: path.join(root, "reports/github-gh-aw"),
    author: "scripts/author-smoke-native-functions.mjs", collector: "scripts/collect-smoke-native-evidence.mjs",
    replay: "scripts/summarize-smoke-native-evidence.mjs",
    tests: "tests/unit/cao-operational-value-smoke-native.test.mjs" },
  lessons: [
    "Bind native proof to the exact host assertion step and trusted environment, not the run/job/agent conclusion.",
    "A source-defined regex assertion proves its precise conjunction, not every aspirational capability named in the prompt.",
    "Match immutable execution lock blobs and host runtime trees to reviewed frozen mainline history; do not exclude legitimate dispatch branches by name.",
    "Default pull-request checkouts can use merge refs rather than the API head SHA: require a retained checkout receipt or leave them unknown.",
    "Specialized imported native extensions must be established separately from shared conformance; a failed gate cannot be decomposed into invented failed cases.",
    "Preserve known partial native quantities and keep full source-goal acceptance separate.",
    "A zero-run inventory plus absent issue/PR output candidates is an evidence gap, not zero behavioral value.",
  ] };
for (const contract of contracts) {
  const { workflowId } = contract;
  const functionPath = `docs/operational-value/proof/functions/${workflowId}.mjs`;
  const module = await import(pathToFileURL(path.resolve(functionPath)).href);
  const indexPath = path.join(root, `${workflowId}-index.json`);
  const index = smokeRead(indexPath);
  assert.equal(index.contractSha256, smokeDigest(contract));
  const rows = index.partitions.flatMap(part => {
    const rows = smokeRead(path.join(root, part.file));
    assert.equal(smokeDigest(rows), part.sha256);
    assert.equal(rows.length, part.rows);
    return rows;
  });
  assert.equal(rows.length, index.observations);
  for (const row of rows) {
    const replay = smokeBehaviorProofs(workflowId, row.gates, row.coreReport);
    assert.deepEqual(row.cases, replay.cases);
    assert.equal(row.fullAcceptance, replay.fullAcceptance);
  }
  const proofs = rows.flatMap(row => row.cases).filter(item => item.passed === true).length;
  const measured = rows.filter(row => row.status === "measured").length;
  const outputDir = path.join(root, "reports/github-gh-aw");
  const archiveSuffix = existsSync(path.join(outputDir, `${workflowId}-evidence-archive.json.gz`))
    ? "evidence-archive.json.gz" : "evidence-archive.json";
  const reportPaths = Object.fromEntries(["timeline.json", "pulse.html", "pulse.json", "definitions.md", archiveSuffix]
    .map(suffix => [suffix, path.join(outputDir, `${workflowId}-${suffix}`)]));
  const timeline = smokeRead(reportPaths["timeline.json"]);
  let replayedWindows = 0;
  for (const snapshot of timeline.snapshots) {
    const fresh = (await module.collectBatch([{
      repository: contract.repository, windowStart: snapshot.window.startAt,
      windowEnd: snapshot.window.endAt, observedAt: snapshot.observedAt,
    }]))[0];
    assert.deepEqual(fresh.evidence, snapshot.evidence, "Standard report evidence must replay identically");
    for (const metric of module.definition.metrics) {
      const scored = module.scoreMetric(metric.id, fresh.evidence);
      const saved = snapshot.metrics?.[metric.id];
      assert.equal(scored, saved);
    }
    replayedWindows++;
  }
  const fullAcceptanceKnown = rows.length > 0 && rows.every(row => row.fullAcceptance !== null);
  const result = {
    workflowId, status: measured ? "native-partial-measured" : "evidence-blocked",
    function: functionPath, sourceGitBlob: contract.sourceGitBlob, adoption: contract.adoption,
    sourceReceipt: path.join(root, `${workflowId}-sources.json.gz`), evidenceIndex: indexPath,
    contractSha256: smokeDigest(contract),
    interpreter: { path: "scripts/native-smoke-value.mjs", sha256: contract.interpreterSha256 },
    reports: reportPaths, evaluation: { standardEvaluator: ".github/skills/add-operational-value/scripts/evaluate.mjs", replayedWindows },
    native: { unit: "behavior proofs", observedProvenBehaviors: measured ? proofs : null,
      assertionCases: smokeCases[workflowId], measuredAssessments: measured,
      observedFullyAcceptedAssessments: rows.filter(row => row.fullAcceptance === true).length,
      completeFullAcceptanceCount: fullAcceptanceKnown ? rows.filter(row => row.fullAcceptance).length : null,
      latestPeriod: timeline.snapshots.at(-1)?.window,
      latestMetrics: timeline.snapshots.at(-1)?.metrics,
      inventoryRuns: index.inventoryRuns, inventoryAttempts: rows.length,
      caveat: "Inventory totals describe acquisition coverage, not outcome/value. Native quantities count repeated independently observed monitoring assertions, not unique code changes or exclusive causation." },
    outputCandidates: index.outputHistory.candidates,
    gaps: [...new Set(rows.flatMap(row => row.missing))],
    limitations: contract.limitations,
  };
  if (!measured) result.gaps.push("No retained historical execution attempts or independent output candidates prove this canary's native behavior.");
  coverage.workflows.push(result);
  coverage[measured ? "nativeMeasured" : "evidenceBlocked"]++;
}
const checkSizes = directory => {
  for (const item of readdirSync(directory)) {
    const file = path.join(directory, item);
    if (statSync(file).isDirectory()) checkSizes(file);
    else assert.ok(statSync(file).size <= 256 * 1024, `Oversized smoke artifact: ${file}`);
  }
};
checkSizes(root);
coverage.validation = { nativeReplay: "passed", reportReplay: "passed", maxFileBytes: 256 * 1024,
  scorerSha256: createHash("sha256").update(readFileSync("scripts/native-smoke-value.mjs")).digest("hex") };
writeFileSync(path.join(root, "coverage.json"), `${JSON.stringify(coverage, null, 2)}\n`);
console.log(JSON.stringify(coverage, null, 2));
