import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { censusDigest, readCensusJson } from "./operational-value-census-io.mjs";

export const dynamicWorkflowSlug = "smoke-copilot-dynamic-workflow";
export const dynamicEvidenceDirectory = "docs/operational-value/proof/copilot-dynamic-workflow";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const sha = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const identity = value => typeof value === "string" && value.length > 0;
const expected = {
  status: "PASS", marker: "GH_AW_DYNAMIC_WORKFLOW_SMOKE_OK",
  packageVersion: 1, supportFile: "support/.fixture.json", subagents: 1,
};

export function verifyDynamicProjection(receipt, binding) {
  if (receipt?.authority !== "protected-native-runtime" || !sha(receipt.sourceProfileSha256)
    || !sha(receipt.protectedReceiptSha256) || !sha(receipt.packageSha256)
    || !binding || receipt.sourceProfileSha256 !== binding.sourceProfileSha256
    || receipt.packageSha256 !== binding.packageSha256
    || !identity(receipt.workflowRunId) || receipt.workflowName !== dynamicWorkflowSlug
    || receipt.attempt !== 1 || receipt.status !== "completed"
    || receipt.consumedSubagents !== 1 || !Array.isArray(receipt.subagents)
    || receipt.subagents.length !== 1) return null;
  const child = receipt.subagents[0];
  if (!identity(child?.invocationId) || child.workflowRunId !== receipt.workflowRunId
    || child.name !== "smoke-marker" || child.status !== "completed"
    || child.cancelled !== false) return null;
  return {
    invocation: true,
    fullAcceptance: receipt.resultRunId === receipt.workflowRunId && receipt.result !== null
      && typeof receipt.result === "object" && !Array.isArray(receipt.result)
      && Object.keys(receipt.result).length === Object.keys(expected).length
      && Object.entries(expected).every(([key, value]) => receipt.result[key] === value) ? true : null,
  };
}

export function scoreDynamicWorkflow(id, evidence) {
  if (!["verified-invocations", "full-acceptance"].includes(id) || evidence?.valid !== true
    || !Array.isArray(evidence.assessments) || !evidence.assessments.length
    || new Set(evidence.assessments.map(row => row?.id)).size !== evidence.assessments.length
    || evidence.assessments.some(row => !identity(row?.id)
      || ![true, false, null].includes(row.invocation)
      || ![true, false, null].includes(row.fullAcceptance)
      || row.fullAcceptance === true && row.invocation !== true)) return null;
  const field = id === "verified-invocations" ? "invocation" : "fullAcceptance";
  const known = evidence.assessments.filter(row => row[field] !== null);
  return known.length ? known.filter(row => row[field] === true).length : null;
}

export function copilotDynamicWorkflowModule(contract) {
  if (hash(readFileSync(import.meta.filename)) !== contract.interpreterSha256) {
    throw new Error("Frozen Copilot dynamic-workflow interpreter changed");
  }
  const example = count => ({
    valid: true, assessments: Array.from({ length: count }, (_, i) => ({
      id: `example-${i}`, invocation: true, fullAcceptance: true,
    })),
  });
  const definition = {
    schemaVersion: 3, slug: dynamicWorkflowSlug, repository: contract.repository,
    workflowName: "Smoke Copilot Dynamic Workflow",
    sourcePath: `.github/workflows/${dynamicWorkflowSlug}.md`,
    intent: {
      goal: "Maintain availability and actual completion of the packaged Copilot CLI dynamic workflow and its one native subagent.",
      acceptance: "Independent protected runtime evidence binds the immutable packaged extension to the named invocation, completed lifecycle and one correlated completed smoke-marker subagent; full acceptance additionally binds the exact five-field durable result to that invocation.",
      temporalAnchor: "workflow-adoption",
    },
    adoption: contract.adoption, evaluation: { mode: "attainment-only" },
    evidence: {
      key: "copilot-packaged-dynamic-runtime-v1", repositories: [contract.repository],
      opportunity: "Every initial execution attempt of the named workflow, including reusable calls selected by immutable caller configuration and native child-job identity; reruns are not new opportunities.",
      filters: [
        "All potential reusable caller runs remain inventoried when actual branch selection cannot be reconstructed.",
        "Agent-written results, editable issues, logs, fixture echoes and successful jobs alone do not establish native invocation.",
        "Only an independent protected runtime receipt bound to the exact package/source profile establishes execution.",
        "A completed native invocation is a partial outcome; the exact durable fixture result is a separate acceptance dimension.",
        "No reconstructable independent pre-adoption execution evidence exists for this newly packaged fixture; this is not an invented zero baseline.",
      ],
      collection: "Offline replay of digest-checked exhaustive frozen direct/caller Actions inventories, initial-attempt job receipts, artifact and log availability, immutable source/import/package closure and source history. Acquisition never executes fetched code.",
      measurementKind: "interval", window: { durationDays: 7, cadenceDays: 7, maturationDays: 0 },
      sourceRevision: contract.sourceRevision, sourceGitBlob: contract.sourceGitBlob,
      interpreterSha256: contract.interpreterSha256, sourceProfileSha256: contract.sourceProfileSha256,
      packageSha256: contract.packageSha256,
      expectedResult: expected,
      missingEvidenceRule: "Unknown selection, missing protected provenance or missing exact result remains null, never an inferred failure or zero.",
    },
    model: {
      architecture: "Native execution and fixture acceptance are separate deterministic predicates; only independent source-bound runtime receipts can establish them.",
      recommendation: "Not measured until protected execution provenance is available; no keep bar or costs were established.",
      presentation: { label: "Verified packaged dynamic invocations", betterLabel: "More independently verified invocations" },
    },
    summary: { nativeLabel: "Verified packaged Copilot dynamic-workflow invocations" },
    metrics: [
      { id: "verified-invocations", role: "primary", name: "Verified packaged dynamic invocations",
        unit: "invocation proofs", direction: "increase",
        formula: "Count independently source-bound completed native workflow invocations with exactly one correlated completed smoke-marker subagent; unknown attempts remain unknown.",
        presentation: { name: "Verified native invocations", legendLabel: "Native invocations", transform: "identity" } },
      { id: "full-acceptance", role: "diagnostic", name: "Exact durable-result acceptance",
        unit: "accepted invocations", direction: "increase",
        formula: "Count verified invocations whose correlated durable result equals all five exact source-defined fields.",
        presentation: { name: "Exact result and invocation", legendLabel: "Full acceptance", transform: "identity" } },
    ],
    validationExamples: {
      targetAttained: example(2), targetMissed: example(1), missing: { valid: false },
      malformed: { valid: true, assessments: [{ id: "bad", invocation: "PASS", fullAcceptance: true }] },
    },
  };
  return {
    definition, scoreMetric: scoreDynamicWorkflow,
    collectBatch(requests) {
      const index = readCensusJson(`${dynamicEvidenceDirectory}/index.json`);
      if (index.contractSha256 !== censusDigest(contract) || index.acquisitionComplete !== true
        || !Array.isArray(index.partitions)) throw new Error("Dynamic-workflow evidence index mismatch");
      const rows = index.partitions.flatMap(part => {
        if (!/^observations-\d{3}\.json\.gz$/.test(part.file)) throw new Error("Unsafe dynamic evidence partition");
        const rows = readCensusJson(`${dynamicEvidenceDirectory}/${part.file}`);
        if (censusDigest(rows) !== part.sha256 || rows.length !== part.count) {
          throw new Error("Dynamic-workflow evidence partition changed");
        }
        return rows;
      });
      if (rows.length !== index.candidateAttempts) throw new Error("Incomplete dynamic-workflow candidate inventory");
      for (const part of index.sourceArchive) {
        if (!/^[a-f0-9]{40}$/.test(part.gitBlob)) throw new Error("Unsafe dynamic source identity");
        const source = readCensusJson(`${dynamicEvidenceDirectory}/sources/${part.gitBlob}.json.gz`);
        if (censusDigest(source) !== part.sha256) throw new Error("Dynamic source archive changed");
        const bytes = Buffer.from(source.content, "base64");
        if (createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== part.gitBlob) {
          throw new Error("Dynamic source blob identity mismatch");
        }
      }
      return requests.map(request => {
        if (request.repository && request.repository !== contract.repository
          || !Number.isFinite(Date.parse(request.windowStart)) || !Number.isFinite(Date.parse(request.windowEnd))
          || request.windowStart >= request.windowEnd) throw new Error("Invalid dynamic-workflow collection window");
        const selected = rows.filter(row => row.at >= request.windowStart && row.at < request.windowEnd);
        const assessments = selected.filter(row => row.selection !== "protected-caller-skipped").map(row => {
          const proof = row.protectedProjection
            && row.protectedProjection.sourceProfileSha256 === contract.sourceProfileSha256
            ? verifyDynamicProjection(row.protectedProjection, contract) : null;
          return { id: row.id, invocation: proof?.invocation ?? null, fullAcceptance: proof?.fullAcceptance ?? null };
        });
        const known = assessments.some(row => row.invocation !== null);
        return {
          evidence: {
            valid: known && request.windowEnd <= contract.until, assessments,
            coverageStatus: "missing", maturityStatus: "unavailable",
            missingReason: "No independent protected native invocation/package receipt survives. Known skipped caller branches are ineligible; remaining branch selection and exact durable results are unavailable.",
            candidateAttempts: selected.length, eligibleCount: null, zeroDirectRuns: index.directRuns === 0,
            confirmedIneligible: selected.filter(row => row.selection === "protected-caller-skipped").length,
            unresolvedSelection: selected.filter(row => row.selection === "unknown-reusable-branch").length,
            populationDigest: censusDigest(selected.map(row => row.id)),
            acquisitionComplete: index.acquisitionComplete, historicalCallerCoverage: index.historicalCallerCoverage,
            costs: "not-measured", attribution: "not-measured",
          },
          provenance: [
            { repository: contract.repository, kind: "immutable-workflow-source", ref: contract.sourceGitBlob },
            { repository: contract.repository, kind: "copilot-dynamic-runtime-evidence-index", ref: censusDigest(index) },
          ], commit: contract.sourceRevision,
        };
      });
    },
  };
}
