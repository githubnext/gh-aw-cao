import path from "node:path";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readCensusJson, censusDigest } from "./operational-value-census-io.mjs";

export const coreBehaviorProbes = ["result-schema", "file-read", "inference", "shell-and-environment", "tool-round-trip"];
const pass = (report, name) => report.checks.find(check => check.name === name)?.status === "passed";
export function conformanceAcquisitionDigest(contract) {
  const scope = { ...contract };
  delete scope.nativeModelSha256;
  return censusDigest(scope);
}

export function normalizeConformanceReport(report, engine) {
  if (report?.engine !== engine || !["passed", "failed"].includes(report.status) || !Array.isArray(report.checks)
    || report.checks.some(check => !check || typeof check.name !== "string" || !["passed", "failed"].includes(check.status))
    || new Set(report.checks.map(check => check.name)).size !== report.checks.length
    || ![...coreBehaviorProbes, "fixtures", "agent-execution"].every(name => report.checks.some(check => check.name === name))
    || report.checks.some(check => ![...coreBehaviorProbes, "fixtures", "agent-execution", "staged-safe-output"].includes(check.name))
    || (report.status === "passed") !== report.checks.every(check => check.status === "passed")) {
    throw new Error("Malformed or incompatible independent conformance report");
  }
  return { engine, status: report.status, checks: report.checks.map(({ name, status }) => ({ name, status })) };
}

export function parseConformanceHostLog(text, engine) {
  const clean = text.replace(/\x1b\[[0-9;]*m/g, "").split("\n")
    .map(line => line.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z\s+/, "").replace(/\r$/, ""));
  const heading = `## Engine conformance: ${engine}`;
  if (clean.filter(line => line === heading).length !== 1) throw new Error("Missing or ambiguous independent host summary");
  const start = clean.indexOf(heading);
  const end = clean.findIndex((line, index) => index > start && /^Overall: \*\*(?:PASSED|FAILED)\*\*$/.test(line));
  if (end < 0) throw new Error("Incomplete independent host summary");
  const checks = clean.slice(start + 1, end).flatMap(line => {
    const match = line.match(/^\| ([a-z-]+) \| (passed|failed) \|$/);
    return match ? [{ name: match[1], status: match[2] }] : [];
  });
  return normalizeConformanceReport({ engine, status: clean[end].includes("PASSED") ? "passed" : "failed", checks }, engine);
}

export function scoreConformanceMetric(id, evidence) {
  const observed = id === "observed-core-passes";
  const assessments = observed ? evidence?.observedAssessments : evidence?.assessments;
  if (!["core-conformance", "verified-probes", "observed-core-passes"].includes(id)
    || (observed ? evidence?.observedValid !== true : evidence?.valid !== true)
    || !Array.isArray(assessments) || !assessments.length
    || new Set(assessments.map(row => row?.id)).size !== assessments.length
    || assessments.some(row => !row || typeof row.id !== "string" || !row.id
      || !Array.isArray(row.passed) || row.passed.length !== coreBehaviorProbes.length
      || row.passed.some(value => typeof value !== "boolean"))) return null;
  const successes = assessments.reduce((sum, row) => sum + row.passed.filter(Boolean).length, 0);
  return observed ? successes : id === "verified-probes" ? assessments.length * coreBehaviorProbes.length
    : successes * 100 / (assessments.length * coreBehaviorProbes.length);
}

export function engineConformanceModule(contract) {
  if (contract.nativeModelSha256 !== createHash("sha256").update(readFileSync(import.meta.filename)).digest("hex")) {
    throw new Error("Frozen conformance interpreter changed; preserve or explicitly version the native function");
  }
  const { repository, workflowId, engine, adoption } = contract;
  const example = (value, count = 1) => {
    const assessments = Array.from({ length: count }, (_, index) => ({ id: `fixture-${index}`, passed: Array(5).fill(value) }));
    return { valid: true, observedValid: true, assessments, observedAssessments: assessments };
  };
  const definition = {
    schemaVersion: 3, slug: workflowId, repository, workflowName: `Engine Conformance ${engine}`,
    sourcePath: `.github/workflows/${workflowId}.md`, intent: {
      goal: `Verify ${engine}'s configured file, inference, shell/environment and production MCP capabilities through independent host assertions.`,
      acceptance: "Five stable host-checked behavioral cases match protected fixture/receipt expectations. Count observed behavior, not workflow/job/agent success or the agent's completion claim.",
      temporalAnchor: "workflow-adoption",
    }, adoption, evaluation: { mode: "attainment-only" },
    evidence: { key: "engine-host-core-five-v1", repositories: [repository],
      opportunity: "Five stable behavioral probe cases per actual conformance assessment on the frozen mainline history.",
      filters: ["Only protected host assertions from an approved immutable checker script are accepted.",
        "Agent execution and fixture checks are admission/context, never numerator outcomes.",
        "Incomplete run inventories, expired evidence, incompatible scripts or failed admission remain unknown, not zero conformance.",
        "The later staged-safe-output probe and engine-native extensions are not silently folded into the stable five-case series."],
      collection: "Replay normalized bounded Actions attempt evidence. Acquisition and host-script verification happen separately, never per evaluation window.",
      measurementKind: "interval", window: { durationDays: 7, cadenceDays: 7, maturationDays: 0 } },
    model: { architecture: "The same five independently asserted behavioral cases across reviewed immutable checker versions.",
      recommendation: "Interpret conformance as observed configuration condition, not exclusive workflow impact; no keep/retire threshold is inferred.",
      presentation: { label: "Host-verified engine conformance", betterLabel: "More required behaviors independently conform" } },
    summary: { nativeLabel: "Host-verified core behavioral conformance" },
    metrics: [
      { id: "core-conformance", name: "Host-verified core conformance", role: "primary",
        formula: "100 * passed stable behavioral cases / assessed stable behavioral cases in complete admitted assessments",
        unit: "percent", direction: "increase",
        presentation: { name: "Core behavioral conformance", legendLabel: "Verified conformance", transform: "identity" } },
      { id: "verified-probes", name: "Independently verified behavioral cases", role: "diagnostic",
        formula: "count actual independently asserted stable behavioral cases, whether passing or failing; not successful runs",
        unit: "probes", direction: "increase",
        presentation: { name: "Independently verified cases", legendLabel: "Behavioral cases", transform: "identity" } },
      { id: "observed-core-passes", name: "Observed independently proven core behaviors", role: "diagnostic",
        formula: "count protected host behavioral assertions that demonstrably pass; preserve this observed subtotal when other attempts are unknown",
        unit: "probes", direction: "increase",
        presentation: { name: "Observed core behavior proofs", legendLabel: "Proven behaviors", transform: "identity" } },
    ],
    signal: { metricId: "observed-core-passes", basis: "workflow-contribution" },
    validationExamples: { targetAttained: example(true, 2),
    targetMissed: example(false), missing: { valid: false }, malformed: { valid: true, assessments: [{ id: "bad", passed: ["true"] }] } },
  };
  return { definition, scoreMetric: scoreConformanceMetric,
    collectBatch(requests) {
      const archive = readCensusJson(path.resolve(import.meta.dirname,
        `../docs/operational-value/proof/engine-conformance/${workflowId}-v2.json.gz`));
      if (archive.repository !== repository || archive.workflowId !== workflowId || archive.complete !== true
        || archive.contractSha256 !== conformanceAcquisitionDigest(contract) || !Array.isArray(archive.observations)
        || censusDigest(archive.observations) !== archive.observationsSha256) throw new Error("Conformance evidence scope or integrity mismatch");
      return requests.map(request => {
        if (request.repository && request.repository !== repository) throw new Error("Conformance repository scope mismatch");
        const rows = archive.observations.filter(row => row.at >= request.windowStart && row.at < request.windowEnd);
        const available = rows.filter(row => row.status === "available");
        const admitted = available.filter(row => pass(row.report, "fixtures")
          && (pass(row.report, "agent-execution") || coreBehaviorProbes.some(name => pass(row.report, name))));
        const valid = request.windowStart >= adoption.adoptedAt && request.windowEnd <= archive.until
          && rows.length > 0 && admitted.length === rows.length;
        return { evidence: { valid, coverageStatus: valid ? "complete" : "missing",
          missingReason: valid ? null : "No complete independently admitted host-evidence cohort for this period.",
          assessments: admitted.map(row => ({ id: row.id, passed: coreBehaviorProbes.map(name => pass(row.report, name)) })),
          observedValid: available.some(row => pass(row.report, "fixtures")),
          observedAssessments: available.filter(row => pass(row.report, "fixtures")).map(row => ({
            id: row.id, passed: coreBehaviorProbes.map(name => pass(row.report, name)) })),
          observedReports: available.length, observedRuns: rows.length, costs: "not-measured",
          limitation: "Stable core behavioral facet, not full staged-output/native-extension acceptance or exclusive workflow impact." },
        provenance: [{ repository, kind: "immutable-workflow-source", ref: contract.sourceGitBlob },
          { repository, kind: "normalized-host-evidence-sha256", ref: archive.observationsSha256 }],
        commit: archive.sourceRevision };
      });
    } };
}
