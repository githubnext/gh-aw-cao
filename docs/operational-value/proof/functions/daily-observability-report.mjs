import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readJsonArchive } from "../../../../.github/skills/add-operational-value/scripts/json-archive.mjs";

const repository = "github/gh-aw";
const revision = "c86377ec47b38f0b5af463277ee55d1d03d08da8";
const sourceBlob = "96a8de8af62e2e84d0a1f54c6e0cfdafc132daf1";
const sha256 = value => createHash("sha256").update(value).digest("hex");
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const text = value => typeof value === "string" && value.length > 0;
const timestamp = value => text(value) && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value));
const count = value => Number.isSafeInteger(value) && value >= 0;
const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const fullSha = value => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const fixture = accepted => ({
  contract: sourceBlob, eligible: 2, assessed: 2, accepted, present: accepted,
  coverageStatus: "complete", fullAcceptance: null, contribution: null,
});

export const definition = {
  schemaVersion: 3,
  slug: "daily-observability-report", repository,
  workflowName: "Daily Observability Report",
  sourcePath: ".github/workflows/daily-observability-report.md",
  intent: {
    goal: "Ensure MCP-enabled work has usable raw telemetry for debugging.",
    acceptance: "Independently inspect recursively discovered gateway.jsonl or rpc-messages.jsonl bytes, not report assertions.",
    temporalAnchor: "workflow-adoption",
  },
  adoption: {
    commit: "aa36291c042c40d6f46e86f0b8604ec1d671a77c",
    adoptedAt: "2026-01-17T21:13:11Z",
    baselineCommit: "ad364429f1c9100b8b35926b4e58084f5c18b8ce",
    baselineAt: "2026-01-17T20:22:18Z",
  },
  evaluation: { mode: "attainment-only" },
  profile: {
    revision, sourceBlob,
    validFrom: "2026-10-18T06:32:44Z",
    sourceSha256: "8f25e7051cd418b94e94d3bb5a7f783c274cce57fd3e5af47c682fb8758deea8",
    scope: "Only evidence explicitly bound to the reviewed current profile; historical source compatibility is not established.",
    adoptionSourceAvailable: true,
    historicalSourceCompatibility: false,
    baselineReconstruction: "Open: phenomenon pre-exists adoption; no comparable baseline established or exhaustion claimed.",
    nativeSchema: "Workflow Phase 3; gateway_logs_types.go EffectiveType uses nonempty legacy type before event.",
    codecSha256: "18045c03ca00fc5f8cccf2a02486255e03a0df22adddf0c426c9182fc6e2554b",
    sourceClosureSha256: "042c3d719fd1bbb878d2c3e8040c33d97147e18739c213f885aea3e3467ba29e",
    sourceSupplementSha256: "746934cce9aa175e209c9f8da4e99d97fa489bd90cfd1c26906458970b9e05ee",
  },
  evidence: {
    key: "current-profile-independent-mcp-telemetry",
    repositories: [repository],
    opportunity: "MCP-configured runs in an independently preserved source-capped seven-day cohort, not the repository fleet.",
    filters: [
      "At most 20 selected runs; normally at most two per workflow, third requires preserved repeated-critical-gap reason.",
      "Preserve candidate inventory and selection rationale: failed/cancelled, firewall-enabled, MCP-configured, then recent successes.",
      "Require immutable run configuration and exact source-profile binding; no eligibility from report text or successful status.",
      "Seven-day disjoint interval windows; shorter leading period remains interim, not a complete weekly comparison.",
    ],
    collection: "Read retained, digest-checked cohort/configuration projections and raw artifact bytes once for all windows; no network. Missing producer inputs are null, not absent logging.",
    measurementKind: "interval",
    window: { durationDays: 7, cadenceDays: 7, maturationDays: 0 },
  },
  model: {
    architecture: "Native capped-cohort telemetry prerequisite, separate from full debugging acceptance and contribution.",
    recommendation: "Not rated: no source-defined keep bar or measured matching costs.",
    presentation: { label: "Usable MCP telemetry", betterLabel: "Higher usable coverage" },
  },
  summary: { nativeLabel: "Percent of eligible sampled runs with structurally usable MCP telemetry" },
  metrics: [
    {
      id: "usable-mcp-coverage", name: "Usable MCP telemetry coverage", role: "primary",
      formula: "100 * accepted / eligible, only for completely assessed selected MCP cohort; zero eligible is null",
      direction: "increase", unit: "percent",
      presentation: { name: "Usable MCP telemetry", legendLabel: "Usable MCP coverage", transform: "identity" },
    },
    {
      id: "verified-usable-runs", name: "Independently verified usable MCP runs", role: "diagnostic",
      formula: "accepted in the assessed subset; preserves established partial native evidence when other runs are missing",
      direction: "increase", unit: "runs",
      presentation: { name: "Verified usable runs", legendLabel: "Verified usable runs", transform: "identity" },
    },
  ],
  safeguards: {
    fullAcceptance: "Separate and unmeasured: firewall access.log quality, all required observability dimensions and effective debugging.",
    contribution: "Unknown without independently demonstrated changed native logging plus verified workflow lineage; no repeated snapshot delivery credit.",
    costs: "Not measured; no weights, financial conversion, keep bar or causal claim.",
    rejectedProxies: ["report count", "discussion creation", "MCP status 200", "workflow success", "agent self-assessment"],
  },
  validationExamples: {
    targetAttained: fixture(2), targetMissed: fixture(0),
    missing: {}, malformed: { ...fixture(1), accepted: -1 },
  },
};

export function inspectTelemetry(name, content) {
  if (!["gateway.jsonl", "rpc-messages.jsonl"].includes(name) || typeof content !== "string") {
    throw new Error("Expected a supported telemetry basename and raw UTF-8 bytes");
  }
  const lines = content.split(/\r?\n/).filter(line => line.trim());
  const failures = [];
  let validEntries = 0;
  for (const [index, line] of lines.entries()) {
    let entry;
    try { entry = JSON.parse(line); } catch {
      failures.push({ line: index + 1, reason: "invalid-json" });
      continue;
    }
    let valid = object(entry) && timestamp(entry.timestamp);
    if (valid && name === "gateway.jsonl") {
      valid = ["debug", "info", "warn", "error"].includes(entry.level)
        && text(entry.type) && ["request", "tool_call", "rpc_call"].includes(entry.event)
        && text(entry.server_name) && (text(entry.tool_name) || text(entry.method))
        && typeof entry.duration === "number" && Number.isFinite(entry.duration) && entry.duration >= 0
        && ["success", "error"].includes(entry.status);
    } else if (valid) {
      const type = text(entry.type) ? entry.type
        : ({ rpc_request: "REQUEST", rpc_response: "RESPONSE", difc_filtered: "DIFC_FILTERED" })[entry.event];
      valid = text(entry.server_id);
      if (type === "DIFC_FILTERED") {
        valid &&= text(entry.tool_name) && text(entry.reason);
      } else {
        valid &&= object(entry.payload)
          && ((type === "REQUEST" && entry.direction === "OUT" && text(entry.payload.method))
            || (type === "RESPONSE" && entry.direction === "IN"
              && (Object.hasOwn(entry.payload, "result") || object(entry.payload.error))));
      }
    }
    if (valid) validEntries++;
    else failures.push({ line: index + 1, reason: "missing-or-invalid-required-fields" });
  }
  return {
    present: true, entries: lines.length, validEntries, failures,
    usable: lines.length > 0 && failures.length === 0,
    predicate: "Strict documented workflow structural prerequisite, not parser success or debugging effectiveness",
  };
}

export function scoreMetric(id, evidence) {
  if (!definition.metrics.some(metric => metric.id === id)) throw new Error(`Unknown metric: ${id}`);
  if (!object(evidence) || evidence.contract !== sourceBlob
    || !["eligible", "assessed", "accepted", "present"].every(key => count(evidence[key]))
    || evidence.eligible > 20 || evidence.assessed > evidence.eligible
    || evidence.accepted > evidence.present || evidence.present > evidence.assessed) return null;
  if (id === "verified-usable-runs") return evidence.assessed > 0 ? evidence.accepted : null;
  return evidence.coverageStatus === "complete" && evidence.eligible > 0 && evidence.assessed === evidence.eligible
    ? 100 * evidence.accepted / evidence.eligible : null;
}

export async function collectBatch(requests, context = {}) {
  if (!Array.isArray(requests)) throw new Error("Expected batch requests");
  const file = fileURLToPath(new URL("../daily-observability-report/native-input.json", import.meta.url));
  const input = context.input ?? (existsSync(file) ? readJsonArchive(file) : { schemaVersion: 1, snapshots: [] });
  if (input.schemaVersion !== 1 || !Array.isArray(input.snapshots)) throw new Error("Malformed native evidence archive");
  return requests.map(request => {
    if (![request.windowStart, request.windowEnd, request.observedAt].every(timestamp)
      || Date.parse(request.windowStart) >= Date.parse(request.windowEnd)
      || Date.parse(request.observedAt) < Date.parse(request.windowEnd)
      || Date.parse(request.windowEnd) - Date.parse(request.windowStart) > 7 * 86400000
      || request.repository && request.repository !== repository) throw new Error("Invalid bounded observation request");
    const matches = input.snapshots.filter(snapshot => snapshot.windowStart === request.windowStart
      && snapshot.windowEnd === request.windowEnd);
    if (matches.length > 1) throw new Error("Conflicting cohort evidence for one observation");
    const base = {
      contract: sourceBlob, measurementKind: "interval", windowStart: request.windowStart,
      windowEnd: request.windowEnd, fullAcceptance: null, contribution: null, costs: "not measured",
    };
    const provenance = [{ repository, kind: "immutable-intent-source", ref: `git:${revision}:${sourceBlob}` }];
    if (!matches.length) return {
      evidence: { ...base, eligible: null, assessed: null, accepted: null, present: null,
        coverageStatus: "missing", missingReason: "No source-bound complete cohort inventory, immutable eligibility configuration and raw artifact bytes retained; historical source compatibility unverified." },
      provenance,
    };
    const snapshot = matches[0];
    if (Date.parse(request.windowEnd) < Date.parse(definition.profile.validFrom)) {
      throw new Error("Current source predicates cannot be backdated into an unverified historical source era");
    }
    if (snapshot.repository !== repository || snapshot.profileRevision !== revision
      || snapshot.profileSourceBlob !== sourceBlob || !digest(snapshot.inventorySha256)
      || !text(snapshot.inventoryRef) || snapshot.selectionComplete !== true
      || !Array.isArray(snapshot.runs) || snapshot.runs.length > 20) {
      throw new Error("Unbound or incomplete source-capped cohort");
    }
    let eligible = 0, assessed = 0, accepted = 0, present = 0;
    const ids = new Set(), workflows = new Map(), checks = [];
    for (const run of snapshot.runs) {
      if (!Number.isSafeInteger(run.id) || run.id <= 0 || ids.has(run.id) || !text(run.workflow)
        || !timestamp(run.createdAt) || Date.parse(run.createdAt) < Date.parse(request.windowStart)
        || Date.parse(run.createdAt) >= Date.parse(request.windowEnd)
        || !fullSha(run.headSha) || !digest(run.configurationSha256) || !text(run.configurationRef)
        || typeof run.mcpConfigured !== "boolean" || !text(run.selectionReason)) {
        throw new Error("Invalid immutable eligibility projection");
      }
      ids.add(run.id);
      const n = (workflows.get(run.workflow) ?? 0) + 1;
      workflows.set(run.workflow, n);
      if (n > 3 || n === 3 && !text(run.repeatedCriticalGapReason)) throw new Error("Cohort exceeds source workflow cap");
      if (!run.mcpConfigured) continue;
      eligible++;
      if (run.artifactsComplete !== true) continue;
      if (!Array.isArray(run.files) || !digest(run.artifactManifestSha256) || !text(run.artifactManifestRef)) {
        throw new Error("Missing independent recursive artifact inventory");
      }
      const paths = new Set();
      const inspected = [];
      for (const file of run.files) {
        if (!text(file.path) || file.path.startsWith("/") || file.path.split("/").some(part => ["..", ".", ""].includes(part))
          || paths.has(file.path)) throw new Error("Unsafe or duplicate artifact member path");
        paths.add(file.path);
        const name = file.path.split("/").at(-1);
        if (!["gateway.jsonl", "rpc-messages.jsonl"].includes(name)) continue;
        if (typeof file.content !== "string" || !digest(file.sha256) || sha256(file.content) !== file.sha256) {
          throw new Error("Telemetry artifact bytes missing or digest mismatch");
        }
        inspected.push({ path: file.path, sha256: file.sha256, ...inspectTelemetry(name, file.content) });
      }
      assessed++;
      if (inspected.length) present++;
      if (inspected.some(file => file.usable)) accepted++;
      checks.push({ runId: run.id, inspected });
      provenance.push({ repository, kind: "preserved-raw-artifact-manifest", ref: `${run.artifactManifestRef}#sha256=${run.artifactManifestSha256}` });
    }
    const interim = Date.parse(request.windowEnd) - Date.parse(request.windowStart) < 7 * 86400000;
    return {
      evidence: {
        ...base, eligible, assessed, accepted, present, checks,
        eligibleCount: eligible, populationDigest: sha256(JSON.stringify([...ids].sort((a, b) => a - b))),
        coverageStatus: assessed === eligible ? "complete" : "partial",
        ...(assessed < eligible ? { missingReason: "Some eligible run artifacts were not independently inventoried" } : {}),
        maturityStatus: interim ? "interim" : "mature", dubious: interim,
      },
      provenance: [...provenance, { repository, kind: "preserved-cohort-inventory", ref: `${snapshot.inventoryRef}#sha256=${snapshot.inventorySha256}` }],
    };
  });
}
