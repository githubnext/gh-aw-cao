import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { conformanceAcquisitionDigest, coreBehaviorProbes, engineConformanceModule } from "./native-engine-conformance.mjs";
import { censusDigest, readCensusJson } from "./operational-value-census-io.mjs";
import { agyConformanceModule } from "./native-agy-conformance.mjs";

export function engineConformanceValueEvents(contract) {
  const directory = "docs/operational-value/proof/engine-conformance";
  const archive = readCensusJson(path.join(directory, `${contract.workflowId}-v2.json.gz`));
  if (archive.complete !== true || archive.contractSha256 !== conformanceAcquisitionDigest(contract)
    || archive.observationsSha256 !== censusDigest(archive.observations)) throw new Error("Incomplete or conflicting native conformance evidence");
  const module = contract.engine === "agy" ? agyConformanceModule(contract) : engineConformanceModule(contract);
  const observedAt = archive.completedAt.replace(/\.\d{3}Z$/, "Z");
  const window = { startAt: contract.adoption.adoptedAt, endAt: contract.until };
  const usable = archive.observations.filter(row => row.status === "available"
    && row.report.checks.some(check => check.name === "fixtures" && check.status === "passed"));
  if (!usable.length) return { ready: false, reason: "No surviving independently usable host assessment in the retained execution population." };
  const [{ evidence }] = module.collectBatch([{ windowStart: window.startAt, windowEnd: window.endAt, observedAt }]);
  const expected = module.scoreMetric("observed-core-passes", evidence);
  if (expected === null) throw new Error("Retained host assessments do not satisfy the native value function");
  const events = usable.map(row => {
    const passed = coreBehaviorProbes.map(name => row.report.checks.some(check => check.name === name && check.status === "passed"));
    const value = module.scoreMetric("observed-core-passes", { observedValid: true,
      observedAssessments: [{ id: row.id, passed }] });
    return { id: `host-core:${row.id}`, at: row.at, value, attribution: "receipt-verified",
      label: `${value}/5 independently proven core behaviors`,
      detail: "Protected host assertions verify schema, file reading, inference, shell/environment and production MCP round-trip. This is verification work, not a run-success count or proof of repository improvement.",
      evidence: [{ label: "Exact execution attempt", url: row.runUrl },
        { label: "Immutable checker source", url: `https://github.com/${contract.repository}/blob/${row.headSha}/.github/workflows/${contract.workflowId}.lock.yml` }] };
  });
  if (events.reduce((sum, row) => sum + row.value, 0) !== expected) throw new Error("Conformance event projection differs from its frozen function");
  const gaps = archive.observations.filter(row => !usable.some(item => item.id === row.id)
    && row.at >= window.startAt && row.at < window.endAt).map(row => Date.parse(row.at)).sort((a, b) => a - b);
  const coverage = [];
  let cursor = Date.parse(window.startAt);
  for (const at of [...new Set(gaps)]) {
    if (at > cursor) coverage.push({ startAt: new Date(cursor).toISOString(), endAt: new Date(at).toISOString(), status: "complete" });
    coverage.push({ startAt: new Date(at).toISOString(), endAt: new Date(at + 1).toISOString(), status: "missing" });
    cursor = at + 1;
  }
  if (cursor < Date.parse(window.endAt)) coverage.push({ startAt: new Date(cursor).toISOString(), endAt: window.endAt, status: "complete" });
  const modulePath = `docs/operational-value/proof/functions/${contract.workflowId}.mjs`;
  return { ready: true, input: { schemaVersion: 1, kind: "operational-value-events",
    repository: contract.repository, workflowSlug: contract.workflowId, workflowName: module.definition.workflowName,
    sourcePath: module.definition.sourcePath, observedAt, cadenceDays: module.definition.evidence.window.cadenceDays,
    metric: { id: "observed-core-passes", name: "Observed independently proven core behaviors",
      unit: "probes", direction: "increase", version: censusDigest({ module: readFileSync(modulePath, "utf8"),
        interpreter: contract.nativeModelSha256 }) },
    basis: "workflow-contribution", window, coverage, opportunities: null, events,
    nativeContext: { observedCorePasses: expected, independentlyUsableAssessments: usable.length,
      survivingRuns: archive.runInventory.length, unknownAssessments: gaps.length,
      sourceRevision: archive.sourceRevision, nativeModelSha256: contract.nativeModelSha256 },
    limitations: ["Native units are passing independent behavioral probe cases, not successful runs, output volume or financial value.",
      "A source-verified successful host assertion step proves its conjunction only when the exact reviewed script and protected environment match and failures are not tolerated.",
      "Receipt verification identifies the actual protected host execution; it does not claim a safe-output issue/PR creation receipt.",
      "Failures are decomposed only from retained protected reports; generic job/agent failure is not assigned a made-up native zero.",
      "The observed subtotal survives unknown assessments. Complete totals and rates crossing a missing assessment remain unknown.",
      "Coverage is scoped to surviving enumerated Actions executions; deleted executions cannot be reconstructed by this instrument.",
      "These checks verify observed configuration behavior, not exclusive workflow causation, speedups or full engine-specific/staged-output acceptance.",
      "Repeated probe work can support assurance but does not establish that more execution is cost-effective; costs and a keep bar are not measured."],
  } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [contractsPath, directory, ...extra] = process.argv.slice(2);
  if (!contractsPath || !directory || extra.length) throw new Error("usage: build-engine-conformance-value-events.mjs CONTRACTS.json REPORT_DIRECTORY");
  for (const contract of readCensusJson(contractsPath)) {
    const result = engineConformanceValueEvents(contract);
    if (result.ready) writeFileSync(path.join(directory, `${contract.workflowId}-value-events.json`), `${JSON.stringify(result.input, null, 2)}\n`);
    console.log(JSON.stringify({ workflow: contract.workflowId, ready: result.ready,
      ...(result.ready ? result.input.nativeContext : { reason: result.reason }) }));
  }
}
