import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseDocument, visit } from "yaml";
import { censusDigest, readCensusJson } from "./operational-value-census-io.mjs";

export const requiredExampleReadScopes = ["contents", "issues", "pull-requests"];
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

export function readCompiledAgentPermissions(content) {
  if (typeof content !== "string" || Buffer.byteLength(content) > 4 * 1024 * 1024) {
    return { known: false, reason: "Compiled workflow absent or over budget." };
  }
  const document = parseDocument(content, { strict: true, uniqueKeys: true });
  let alias = false;
  visit(document, { Alias() { alias = true; } });
  if (document.errors.length || document.warnings.length || alias) {
    return { known: false, reason: "Compiled YAML is invalid, ambiguous or uses unsupported aliases." };
  }
  const value = document.toJS({ maxAliasCount: 0 });
  if (!object(value) || !object(value.jobs) || !object(value.jobs.agent) || value.jobs.agent.uses) {
    return { known: false, reason: "No independently inspectable compiled agent job." };
  }
  const agent = value.jobs.agent;
  const permissions = Object.hasOwn(agent, "permissions") ? agent.permissions : value.permissions;
  if (!object(permissions) || Object.entries(permissions).some(([key, mode]) =>
    !/^[a-z]+(?:-[a-z]+)*$/.test(key) || !["none", "read", "write"].includes(mode))) {
    return { known: false, reason: "Explicit permission map unavailable; repository defaults and macros are not inferred." };
  }
  return { known: true, permissions, inherited: !Object.hasOwn(agent, "permissions") };
}

export function permissionIntentEra(source) {
  if (typeof source !== "string") return "unknown";
  const headings = source.split("\n").filter(line => /^# /.test(line));
  if (headings.length !== 1) return "unknown";
  if (headings[0] === "# Example: Properly Provisioned Permissions") return "read-only-demo";
  if (headings[0] === "# Example: Under-provisioned Permissions Warning") return "warning-demo";
  return "unknown";
}

export function scanAgentReadPermissions(evidence) {
  if (evidence?.valid !== true || !object(evidence.permissions)
    || Object.entries(evidence.permissions).some(([key, mode]) =>
      !/^[a-z]+(?:-[a-z]+)*$/.test(key) || !["none", "read", "write"].includes(mode))) return null;
  const missing = requiredExampleReadScopes.filter(scope => evidence.permissions[scope] !== "read").length;
  const writes = Object.values(evidence.permissions).filter(mode => mode === "write").length;
  return { "read-scope-mismatches": missing, "agent-write-grants": writes, eligible: requiredExampleReadScopes.length };
}

export function scoreAgentReadPermissions(id, evidence) {
  if (!["read-scope-mismatches", "agent-write-grants"].includes(id)) throw new Error("Unknown native permission metric");
  return scanAgentReadPermissions(evidence)?.[id] ?? null;
}

export function nativePermissionModule(contract) {
  if (contract.interpreterSha256 !== hash(readFileSync(import.meta.filename))
    || censusDigest(contract.requiredScopes) !== censusDigest(requiredExampleReadScopes)) {
    throw new Error("Frozen native permission predicate changed");
  }
  const example = permissions => ({ valid: true, permissions });
  const metric = (id, role, name, label, formula) => ({ id, role, name, formula,
    unit: "permission grants", direction: "decrease",
    presentation: { name, legendLabel: label, transform: "identity" } });
  return { definition: { schemaVersion: 3, slug: contract.workflowId, repository: contract.repository,
    workflowName: "Example: Properly Provisioned Permissions", sourcePath: contract.sourcePath,
    intent: { goal: "Provision the example agent's contents, issues and pull-requests scopes at read level.",
      acceptance: "Inspect the actual immutable compiled agent-job permission map. Each of the three declared toolset read requirements must be exactly read; write grants are a separate safeguard. This is a configuration facet, not compiler-warning or live access verification.",
      temporalAnchor: "workflow-adoption" },
    adoption: contract.adoption, evaluation: { mode: "attainment-only" },
    evidence: { key: "compiled-agent-read-permissions-v1", repositories: [contract.repository],
      sourcePolicySha256: censusDigest(contract),
      opportunity: "The frozen example's three read-scope obligations in each immutable compiled agent job.",
      filters: ["Read compiled YAML, not a source-frontmatter promise or successful workflow run.",
        "An explicit agent-job map replaces the workflow-level map; only an absent job map inherits the workflow map.",
        "Missing entries in an explicit map are none. Missing maps, aliases, macros and unsupported job shapes remain unknown.",
        "Retain warning-demo-era values as retrospective current-policy diagnostics, never as failures of that intentional warning example.",
        "Only the known read-only-demo intent era without agent write grants is comparable for this configuration facet.",
        "Do not flag safe-output or conclusion-job write grants as agent permissions.",
        "MCP read-only enforcement, token credentials, compiler warnings, live authorization, costs and workflow causation are not measured."],
      collection: "Digest-checked public immutable source and compiled workflow blobs at adoption and weekly/cutoff endpoints.",
      measurementKind: "snapshot", window: { durationDays: 7, cadenceDays: 7, maturationDays: 0 } },
    model: { architecture: "Strict YAML parsing of retained compiled agent permission maps, with explicit intent-era comparability.",
      recommendation: "Inspect scope mismatches and agent write grants; separately verify compilation and real scoped access.",
      presentation: { label: "Compiled agent read-scope provisioning", betterLabel: "Fewer read-scope mismatches" } },
    summary: { nativeLabel: "Required read-scope mismatches" },
    metrics: [
      metric("read-scope-mismatches", "primary", "Required read-scope mismatches", "Read-scope mismatches",
        "Count contents, issues and pull-requests grants whose effective compiled agent-job level is not exactly read."),
      metric("agent-write-grants", "diagnostic", "Compiled agent write grants", "Agent write grants",
        "Count write-valued entries in the agent's effective explicit permission map, not other jobs."),
    ],
    validationExamples: { targetAttained: example({ contents: "read", issues: "read", "pull-requests": "read" }),
      targetMissed: example({ contents: "write", issues: "read" }), missing: { valid: false },
      malformed: example({ contents: true }) } },
  scoreMetric: scoreAgentReadPermissions, collectBatch(requests) {
    const index = readCensusJson(`${contract.directory}/index.json`);
    const facts = readCensusJson(`${contract.directory}/facts.json.gz`);
    if (!index.complete || index.contractSha256 !== censusDigest(contract) || index.factsSha256 !== censusDigest(facts)
      || index.repository !== contract.repository || index.sourceRevision !== contract.sourceRevision
      || index.until !== contract.until) throw new Error("Native permission evidence changed");
    return requests.map(request => {
      if (request.repository && request.repository !== contract.repository) throw new Error("Native permission repository mismatch");
      const state = facts.states.find(state => state.windowEnd === request.windowEnd);
      const evidence = { valid: state?.native?.known === true, permissions: state?.native?.permissions ?? null };
      const scan = scanAgentReadPermissions(evidence);
      const comparable = scan !== null && state.intentEra === "read-only-demo" && scan["agent-write-grants"] === 0;
      return { evidence: { ...evidence, intentEra: state?.intentEra ?? "unknown",
        coverageStatus: comparable ? "complete" : scan ? "partial" : "unknown", maturityStatus: "matured",
        eligibleCount: scan?.eligible ?? null,
        missingReason: comparable ? null : scan ? "Different/unknown intent era or agent write safeguard; native quantities are not comparable acceptance."
          : state?.native?.reason ?? "Compiled permission evidence unavailable.",
        fullGoalAcceptance: "not-measured", compilerWarnings: "not-measured", runtimeAccess: "not-measured",
        mcpReadOnlyEnforcement: "not-measured", workflowCausation: "not-measured", costs: "not-measured" },
      provenance: [{ repository: contract.repository, kind: "immutable-workflow-source", ref: contract.sourceGitBlob },
        { repository: contract.repository, kind: "native-permission-index", ref: censusDigest(index) }],
      commit: state?.commit ?? contract.sourceRevision };
    });
  } };
}
