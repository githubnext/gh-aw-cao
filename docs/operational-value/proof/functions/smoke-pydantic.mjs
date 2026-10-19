import { readFileSync } from "node:fs";
import path from "node:path";
import { readJsonArchive } from "../../../../.github/skills/add-operational-value/scripts/json-archive.mjs";
import {
  cutoff, epochNs, introduction, nativeDigest, repository, validateRequest,
} from "../../../../scripts/native-smoke-pydantic.mjs";
import { proofRoot, sha256 } from "../../../../scripts/collect-smoke-pydantic.mjs";

const dependencyPins = {
  "scripts/native-smoke-pydantic.mjs": "0df4eafb26e80d27ef8c99c7eee66b443518f2c9ed4fed0d5094d2593aebb8f5",
  "scripts/collect-smoke-pydantic.mjs": "3001086bb3b8631d7ac953d5263d47a9924faf7a3f7f0bffeda73f62baa50232",
  "docs/operational-value/proof/smoke-pydantic/acceptance.json": "790e5607970f0aa1bc7c34db30f42f2461796e2eef30178b666b680ce8900f0d",
  "docs/operational-value/proof/smoke-pydantic/partial-contract.json": "a7e3361fa4a9d9c871b49866423b4aafbe95ef9b1e2279b502336cf044296227",
  "docs/operational-value/proof/smoke-pydantic/source-review.json": "e60310cc0cd7ba78e500ab81c4cc8c3c2f54e7e866f5bde7cb9a71bd364fe3e1",
};
for (const [relative, expected] of Object.entries(dependencyPins)) {
  if (sha256(readFileSync(new URL(`../../../../${relative}`, import.meta.url))) !== expected) {
    throw new Error(`Frozen native interpreter/contract dependency changed: ${relative}`);
  }
}

const acceptance = JSON.parse(readFileSync(path.join(proofRoot, "acceptance.json"), "utf8"));
const partial = JSON.parse(readFileSync(path.join(proofRoot, "partial-contract.json"), "utf8"));
const contractVersion = partial.contractVersion;
const anchor = introduction();
const facets = [
  ["native-read-cases", "Verified README reads", "read", "primary"],
  ["inference-cases", "Verified inference", "inference", "diagnostic"],
  ["mcp-cases", "Available safeoutputs MCP", "mcpAvailability", "diagnostic"],
  ["transport-cases", "Verified transport", "transport", "diagnostic"],
  ["persisted-issues", "Receipt-bound issues", "safeOutputPersistence", "diagnostic"],
  ["full-goal-cases", "Complete source goal", "fullGoal", "diagnostic"],
  ["linked-read-cases", "Workflow-linked reads", "contribution", "diagnostic"],
  ["python-filesystem-read-cases", "Native Python README reads", "pythonFilesystemRead", "diagnostic"],
  ["linked-python-read-cases", "Workflow Python reads", "pythonReadContribution", "diagnostic"],
];
const example = status => ({
  contractVersion,
  coverageStatus: "partial",
  cases: [{ id: "example/1", facets: Object.fromEntries(facets.map(([, , key]) => [key, status])) }],
});

export const definition = {
  schemaVersion: 3,
  slug: "smoke-pydantic",
  repository,
  workflowName: "Smoke Pydantic AI",
  sourcePath: acceptance.sourcePath,
  intent: {
    goal: acceptance.goal,
    acceptance: acceptance.primary.acceptance,
    temporalAnchor: "workflow-adoption",
  },
  adoption: anchor,
  evaluation: { mode: "attainment-only" },
  interpretation: acceptance.interpretation,
  historicalScope: "Adoption anchors the actual workflow lineage. Its initial file-write/bash/git goal differs; the later README acceptance applies only to reviewed coherent source profiles, never retrospectively to incompatible eras.",
  dependencyPins,
  bootstrap: {
    regularFiles: 35,
    archiveSha256: "f70992410c521b739bd323485108381cf6c9fbf41b6fb12c6f56b664c84f86fb",
    manifestSha256: "24a1ddee03dcf2cf2047fa40d6e57c86f2ec7cc63ebac7e8911c6ff8ee17fef6",
    policy: "Interpreter or contract changes require new module bytes and therefore a new function-hash archive key. The owned packager verifies all bootstrap bytes before and after fresh replay.",
  },
  referenceRevision: acceptance.referenceRevision,
  sourceGitBlob: acceptance.sourceGitBlob,
  acceptanceSha256: sha256(readFileSync(path.join(proofRoot, "acceptance.json"))),
  contract: acceptance,
  partialEvidenceContract: partial,
  sourceProfiles: JSON.parse(readFileSync(path.join(proofRoot, "source-review.json"), "utf8")),
  evidence: {
    key: contractVersion,
    repositories: [repository],
    opportunity: acceptance.primary.opportunity,
    filters: ["Original smoke-pydantic only", "One native case per run/attempt service lifetime",
      "Coherent reviewed source profile", "Actual immutable README bytes", "Native timestamps within requested interval"],
    collection: "Offline digest-checked original native receipts and Git source custody; complete production output-history discovery. Partial run selection never establishes a complete population.",
    measurementKind: "interval",
    window: { durationDays: 7, cadenceDays: 7, maturationDays: 0 },
  },
  model: {
    architecture: "Source-specific deterministic native-capability checker; no inference model during intake, scoring or reporting.",
    recommendation: "Native Python filesystem reads are an explicitly versioned partial, never read_file conformance or full acceptance. Contribution, coverage and costs remain separate.",
    presentation: { label: "Verified native cases", betterLabel: "More independently verified cases" },
  },
  summary: { nativeLabel: "verified capability cases per disjoint period" },
  metrics: facets.map(([id, name, facet, role]) => ({
    id, name, role,
    formula: `Count distinct accepted ${facet} cases in the retained assessed subset; null when none can be assessed.`,
    direction: "increase",
    unit: id.includes("python") ? "verified Python read cases"
      : id === "persisted-issues" ? "receipt-bound issues" : "verified cases",
    presentation: { name, legendLabel: name.slice(0, 24), transform: "identity" },
  })),
  signal: { metricId: "linked-python-read-cases", basis: "workflow-contribution" },
  validationExamples: {
    targetAttained: example("passed"),
    targetMissed: example("failed"),
    missing: { contractVersion, cases: [] },
    malformed: { contractVersion, cases: "not native cases" },
  },
};

export function scoreMetric(id, evidence) {
  const facet = facets.find(([metricId]) => metricId === id)?.[2];
  if (!facet || !evidence || evidence.contractVersion !== contractVersion
    || !Array.isArray(evidence.cases) || !evidence.cases.length) return null;
  const ids = new Set();
  let accepted = 0, assessed = 0;
  for (const row of evidence.cases) {
    if (!row || typeof row.id !== "string" || !row.id || ids.has(row.id)
      || !row.facets || typeof row.facets !== "object") return null;
    ids.add(row.id);
    const status = row.facets[facet];
    if (!["passed", "failed", "unknown"].includes(status)) return null;
    if (status !== "unknown") assessed++;
    if (status === "passed") accepted++;
  }
  return assessed ? accepted : null;
}

export async function collectBatch(requests) {
  if (!Array.isArray(requests)) throw new Error("Measurement requests must be an array");
  requests.forEach(validateRequest);
  const { collectNative } = await import("../../../../scripts/native-smoke-pydantic.mjs");
  const native = collectNative();
  return requests.map(request => {
    const withinCutoff = epochNs(request.windowEnd) <= epochNs(cutoff);
    const inside = at => epochNs(at) >= epochNs(request.windowStart) && epochNs(at) < epochNs(request.windowEnd);
    const cases = withinCutoff ? native.cases.filter(row =>
      epochNs(row.availableAt) <= epochNs(request.observedAt)
      && (inside(row.at) || Object.values(row.facetAt).some(inside))).map(row => ({
      ...row,
      facets: Object.fromEntries(Object.entries(row.facets).map(([key, status]) =>
        [key, row.facetAt[key] && !inside(row.facetAt[key]) ? "unknown" : status])),
    })) : [];
    const evidence = {
      contractVersion,
      windowStart: request.windowStart, windowEnd: request.windowEnd,
      observedAt: request.observedAt, measurementKind: "interval",
      coverageStatus: cases.length ? "partial" : "missing",
      maturityStatus: cases.length ? "mature" : "unavailable",
      eligibleCount: null,
      retainedAttemptCount: cases.length,
      assessedCount: cases.filter(row => Object.values(row.facets).some(status => status !== "unknown")).length,
      populationDigest: cases.length ? nativeDigest(cases.map(row => row.id)) : null,
      missingReason: withinCutoff
        ? native.missingReason
        : "Requested period exceeds the frozen evidence cutoff.",
      cases,
      costs: null,
    };
    return {
      evidence,
      provenance: native.provenance,
      commit: acceptance.referenceRevision,
    };
  });
}
