import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { actionsLog as log } from "../../activity/actions-log.mjs";
import { firstText } from "./text-utils.mjs";

const sourceNames = [
  "organizations",
  "repositories",
  "workflows",
  "runs",
  "admissions",
  "admission-checks",
  "run-performance",
  "job-performance",
  "safe-output-performance",
  "experiments",
  "experiment-assignments",
  "graders",
  "grader-observations",
  "evals",
  "eval-observations",
  "usage",
  "mcp-calls",
  "mcp-servers",
  "security-observations",
  "detection-observations",
  "firewall-observations",
  "firewall-policy-rules",
  "coverage-diagnostics",
  "repository-coverage",
  "outcomes",
  "findings",
  "operational-values",
  "github-api-rate-limits",
  "github-api-collector-health",
  "github-api-call-stacks",
  "work-items",
  "attention-signals",
  "agent-assignments",
  "evidence-records",
  "configuration-summary",
  "configuration-policy",
  "configuration-actions",
];
const AIC_TO_USD = 0.01;
export const GITHUB_RATE_LIMIT_THRESHOLDS = Object.freeze({
  staleAfterMinutes: 60,
  warningRemainingPercent: 20,
  warningRunwayRatio: 1.25,
  minimumBurnIntervals: 2,
});
const EMPTY_RATE_LIMIT_ERROR = "GitHub API returned no valid rate-limit resources.";

function repositoryParts(repository = "") {
  const [organization = "", name = ""] = repository.split("/");
  return { organization, repository: name };
}

export function parseRolloutMode(value) {
  const text = String(value ?? "").trim();
  if (!text) return "unknown";
  const normalized = text.toLowerCase();
  if (normalized === "review" || normalized === "live") return normalized;
  const match = normalized.match(/(?:^|[^a-z0-9])((review|live))\s*$/i);
  return match?.[1]?.toLowerCase() || "unknown";
}

function rolloutMode(value) {
  return parseRolloutMode(value);
}

function runConclusion(value) {
  const normalized = String(value || "unknown").replaceAll("_", "-");
  return [
    "success", "failure", "cancelled", "timed-out", "action-required",
    "neutral", "skipped", "stale", "startup-failure",
  ].includes(normalized) ? normalized : "unknown";
}

function link(relation, href, label) {
  return typeof href === "string" && href.startsWith("https://")
    ? { relation, href, label }
    : undefined;
}

function workflowRunUrl(repository, runId) {
  const parts = String(repository || "").split("/");
  const id = String(runId ?? "");
  return parts.length === 2 && parts.every(Boolean) && /^\d+$/.test(id)
    ? `https://github.com/${parts[0]}/${parts[1]}/actions/runs/${id}`
    : undefined;
}

function sourceMetadata(name, generatedAt, available, complete, freshness = available ? "fresh" : "unknown", asOf = generatedAt) {
  return {
    "source-id": `central-agentic-ops-${name}`,
    "source-kind": "github",
    "as-of": asOf,
    "retrieved-at": generatedAt,
    completeness: complete ? "complete" : "partial",
    freshness,
    availability: available ? "available" : "unavailable",
  };
}

function source(name, rows, generatedAt, available = true, complete = true, freshness, asOf) {
  return {
    source: name,
    rows,
    metadata: sourceMetadata(name, generatedAt, available, complete, freshness, asOf),
  };
}

function finite(value) {
  return Number.isFinite(value) ? Number(value) : null;
}

function rounded(value, places = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** places;
  return Math.round(Number(value) * factor) / factor;
}

function credential(entry) {
  if (entry?.credentialId) return entry.credentialId;
  const parts = [entry?.credentialRole, entry?.tokenType].filter((value) => value && value !== "unknown");
  return parts.join(":") || "unknown";
}

function telemetryAsOf(entries, fallback) {
  const timestamps = entries.map((entry) => Date.parse(entry?.observedAt)).filter(Number.isFinite);
  return timestamps.length > 0 ? new Date(Math.max(...timestamps)).toISOString() : fallback;
}

function telemetryFreshness(entries, generatedAt) {
  const asOf = Date.parse(telemetryAsOf(entries, generatedAt));
  const generated = Date.parse(generatedAt);
  if (!Number.isFinite(asOf) || !Number.isFinite(generated)) return "unknown";
  return generated - asOf > GITHUB_RATE_LIMIT_THRESHOLDS.staleAfterMinutes * 60_000 ? "stale" : "fresh";
}

function riskStatus(row, sourceComplete, sourceFreshness) {
  if (!sourceComplete || sourceFreshness !== "fresh") return "unknown";
  if (row.remaining === 0) return "critical";
  if (row["projected-remaining-at-reset"] !== null && row["projected-remaining-at-reset"] <= 0) return "critical";
  if (
    row["remaining-percent"] <= GITHUB_RATE_LIMIT_THRESHOLDS.warningRemainingPercent
    || (row["runway-ratio"] !== null && row["runway-ratio"] <= GITHUB_RATE_LIMIT_THRESHOLDS.warningRunwayRatio)
  ) return "warning";
  return row["burn-rate-per-minute"] === null ? "unknown" : "healthy";
}

function hasValidRateLimitResources(entry) {
  if (!Number.isFinite(Date.parse(entry?.observedAt))) return false;
  return Object.values(entry?.rateLimit || {}).some((rate) => {
    const reset = Date.parse(rate?.resetAt);
    const limit = finite(rate?.limit);
    const remaining = finite(rate?.remaining);
    return Number.isFinite(reset) && limit !== null && limit > 0 && remaining !== null;
  });
}

function rateLimitDiagnostic(entry) {
  return entry?.rateLimitError || (hasValidRateLimitResources(entry) ? "" : EMPTY_RATE_LIMIT_ERROR);
}

export function githubTelemetryRows(entries = [], generatedAt = new Date().toISOString()) {
  const complete = entries.length > 0 && entries.every((entry) => !rateLimitDiagnostic(entry));
  const freshness = telemetryFreshness(entries, generatedAt);
  const segments = new Map();
  const sortedEntries = [...entries].sort((left, right) => Date.parse(left?.observedAt) - Date.parse(right?.observedAt));
  const rows = sortedEntries.flatMap((entry) => {
    const credentialName = credential(entry);
    const segment = segments.get(credentialName) || 1;
    if (rateLimitDiagnostic(entry)) segments.set(credentialName, segment + 1);
    return Object.entries(entry?.rateLimit || {}).flatMap(([resource, rate]) => {
    const observed = Date.parse(entry.observedAt);
    const reset = Date.parse(rate?.resetAt);
    const limit = finite(rate?.limit);
    const remaining = finite(rate?.remaining);
    if (!Number.isFinite(observed) || !Number.isFinite(reset) || limit === null || limit <= 0 || remaining === null) return [];
    const executionId = entry.pairId || "unknown";
    const bucket = `${resource} · ${credentialName}`;
    return [{
      "observation-id": `${executionId}:${entry.phase || "unknown"}:${credentialName}:${resource}:${entry.observedAt}`,
      "operation-execution-id": executionId,
      "observed-at": entry.observedAt,
      phase: entry.phase || "unknown",
      operation: entry.operation || "unknown",
      outcome: entry.outcome || "unknown",
      credential: credentialName,
      "credential-type": entry.tokenType || "unknown",
      resource,
      bucket,
      "maximum-lane": `${bucket} · max ${limit}`,
      "history-series": segment === 1 ? bucket : `${bucket} · segment ${segment}`,
      "has-history": false,
      limit,
      used: finite(rate?.used) ?? Math.max(0, limit - remaining),
      remaining,
      "remaining-percent": rounded((remaining / limit) * 100, 1),
      "reset-at": rate.resetAt,
      "minutes-to-reset": rounded(Math.max(0, (reset - observed) / 60_000)),
      "consumed-since-previous": null,
      "burn-rate-per-minute": null,
      "projected-remaining-at-reset": null,
      "projected-exhaustion-at": null,
      "runway-ratio": null,
      "risk-status": "unknown",
      "risk-order": 3,
      "is-current": false,
      "attribution-status": "unavailable",
      "operation-consumed": null,
    }];
    });
  });

  rows.sort((left, right) => Date.parse(left["observed-at"]) - Date.parse(right["observed-at"]));
  const windows = new Map();
  for (const row of rows) {
    const key = `${row.credential}\u0000${row.resource}\u0000${row["reset-at"]}`;
    const history = windows.get(key) || [];
    const previous = history.at(-1);
    if (previous) {
      const elapsed = (Date.parse(row["observed-at"]) - Date.parse(previous["observed-at"])) / 60_000;
      const consumed = previous.remaining - row.remaining;
      if (elapsed > 0 && consumed >= 0) row["consumed-since-previous"] = consumed;
    }
    history.push(row);
    windows.set(key, history);
  }

  const pairs = new Map();
  for (const row of rows) {
    if (row["operation-execution-id"] === "unknown") continue;
    const key = `${row["operation-execution-id"]}\u0000${row.credential}\u0000${row.resource}\u0000${row["reset-at"]}`;
    const pair = pairs.get(key) || {};
    pair[row.phase] = row;
    pairs.set(key, pair);
  }
  for (const pair of pairs.values()) {
    const before = pair.before;
    const after = pair.after;
    if (!before || !after || Date.parse(before["observed-at"]) > Date.parse(after["observed-at"])) continue;
    const consumed = before.remaining - after.remaining;
    if (consumed < 0) continue;
    after["operation-consumed"] = consumed;
    after["attribution-status"] = "available";
  }

  for (const history of windows.values()) {
    for (let index = 0; index < history.length; index += 1) {
      const row = history[index];
      const intervals = history.slice(1, index + 1).filter((candidate) => candidate["consumed-since-previous"] !== null);
      if (complete && freshness === "fresh" && intervals.length >= GITHUB_RATE_LIMIT_THRESHOLDS.minimumBurnIntervals) {
        const first = history[0];
        const elapsed = (Date.parse(row["observed-at"]) - Date.parse(first["observed-at"])) / 60_000;
        const consumed = intervals.reduce((total, candidate) => total + candidate["consumed-since-previous"], 0);
        const burn = elapsed > 0 ? consumed / elapsed : null;
        if (burn !== null && burn > 0) {
          row["burn-rate-per-minute"] = rounded(burn, 3);
          row["projected-remaining-at-reset"] = rounded(row.remaining - burn * row["minutes-to-reset"]);
          const minutesToExhaustion = row.remaining / burn;
          row["projected-exhaustion-at"] = new Date(Date.parse(row["observed-at"]) + minutesToExhaustion * 60_000).toISOString();
          row["runway-ratio"] = row["minutes-to-reset"] > 0
            ? rounded(minutesToExhaustion / row["minutes-to-reset"])
            : null;
        }
      }
      row["risk-status"] = riskStatus(row, complete, freshness);
      row["risk-order"] = { critical: 0, warning: 1, healthy: 2, unknown: 3 }[row["risk-status"]];
    }
  }

  const latest = new Map();
  for (const row of rows) latest.set(`${row.credential}\u0000${row.resource}`, row);
  for (const row of latest.values()) row["is-current"] = true;
  const historyInstants = new Map();
  for (const row of rows) {
    const key = `${row.phase}\u0000${row["history-series"]}`;
    const instants = historyInstants.get(key) || new Set();
    instants.add(row["observed-at"]);
    historyInstants.set(key, instants);
  }
  for (const row of rows) row["has-history"] = historyInstants.get(`${row.phase}\u0000${row["history-series"]}`).size >= 2;
  return rows;
}

export function githubCollectorRows(entries = []) {
  return entries.map((entry) => ({
    "observed-at": entry.observedAt,
    "operation-execution-id": entry.pairId || "unknown",
    phase: entry.phase || "unknown",
    operation: entry.operation || "unknown",
    outcome: entry.outcome || "unknown",
    credential: credential(entry),
    "cache-hydrated": entry.activityCache?.hydrated === true,
    "cache-bytes": entry.activityCache?.bytes ?? 0,
    "cache-entries": entry.activityCache?.entryCount ?? 0,
    "cache-folders": entry.activityCache?.folderCount ?? 0,
    "rate-limit-error": rateLimitDiagnostic(entry),
  }));
}

export function githubStackTraceRows(entries = []) {
  return entries.flatMap((entry) => {
    const executionId = entry.pairId || "unknown";
    const traceId = `${executionId}:${entry.phase || "unknown"}:${entry.observedAt || "unknown"}`;
    const frames = Array.isArray(entry.stackTrace) ? entry.stackTrace.filter((frame) => typeof frame === "string" && frame.trim()) : [];
    const orderedFrames = typeof frames.toReversed === "function" ? frames.toReversed() : [...frames].reverse();
    return orderedFrames.map((frame, index) => ({
      "observed-at": entry.observedAt,
      "operation-execution-id": executionId,
      phase: entry.phase || "unknown",
      operation: entry.operation || "unknown",
      outcome: entry.outcome || "unknown",
      credential: credential(entry),
      "stack-frame-id": `${traceId}:${index}`,
      "stack-parent-id": index > 0 ? `${traceId}:${index - 1}` : "",
      "stack-depth": index,
      "stack-frame": frame.trim(),
    }));
  });
}

function coverageDiagnosticRows(deployed, usage, controlSettings, report) {
  const diagnostics = [];
  if (report.error) diagnostics.push({
    kind: report.errorStatus === 403 ? "github-api-rate-limit-403" : "durable-output-unavailable",
    title: "Durable output collection unavailable",
    effect: report.errorStatus === 403
      ? "Durable output evidence is partial because GitHub rate-limited collection."
      : "Durable output evidence is unavailable for this dashboard build.",
    "technical-detail": report.error,
    endpoint: report.errorEndpoint || "",
    "rate-limit-reset": report.rateLimitResetAt || "",
    "snapshot-age-seconds": report.snapshotAgeSeconds ?? "",
  });
  if (report.stale) diagnostics.push({
    title: "Durable output snapshot is stale",
    effect: `Retained the last successful snapshot from ${report.snapshotGeneratedAt || "an unknown time"}.`,
    "snapshot-age-seconds": report.snapshotAgeSeconds ?? "",
  });
  if (controlSettings.policy_resolution?.status === "unavailable") diagnostics.push({
    title: "Control policy resolution unavailable",
    effect: controlSettings.policy_resolution.reason || "The dashboard is limited to fail-closed control-repository data.",
  });
  if (!deployed.includePrivate) diagnostics.push({
    title: "Private repository discovery is off",
    effect: "Private repositories are excluded from workflow inventory and run-health totals.",
  });
  if (!deployed.runHealth?.available) diagnostics.push({
    title: "Run telemetry is unavailable",
    effect: "Run status and failure counts cannot be determined.",
  });
  else if (!deployed.runHealth.complete) diagnostics.push({
    title: "Run telemetry is partial",
    effect: "Run status totals cover only the Actions data returned within the configured audit limit.",
  });
  if (!usage.available) diagnostics.push({
    title: "AIC telemetry is unavailable",
    effect: "AI Credit totals cannot be calculated from the retained usage artifacts.",
  });
  else if (!usage.complete) diagnostics.push({
    title: "AIC telemetry is partial",
    effect: "AI Credit totals exclude runs whose usage artifacts could not be collected.",
  });
  return diagnostics;
}

function repositoryCoverageRows(deployed) {
  const discovered = new Map();
  for (const item of [...(deployed.workflows || []), ...(deployed.bundles || [])]) {
    const repository = String(item.repository || "");
    if (!repository) continue;
    discovered.set(repository, ["public", "private", "internal"].includes(item.visibility)
      ? item.visibility
      : "unknown");
  }
  const discoveredCounts = { public: 0, private: 0, internal: 0, unknown: 0 };
  for (const visibility of discovered.values()) discoveredCounts[visibility] += 1;
  const organization = deployed.organizationRepositories || {};
  const count = (value) => Number.isFinite(value) ? String(value) : "Unknown";
  return [
    { label: "Discovery scope", value: deployed.repositoryScope === "allowlist" ? "Configured allowlist" : "Organization" },
    { label: "Repositories in scope", value: count(deployed.repositoryCount) },
    { label: "Discovered public", value: String(discoveredCounts.public) },
    { label: "Discovered private", value: String(discoveredCounts.private) },
    { label: "Discovered internal", value: String(discoveredCounts.internal) },
    { label: "Unknown visibility", value: String(discoveredCounts.unknown) },
    { label: "Organization total", value: count(organization.total) },
    { label: "Organization public", value: count(organization.public) },
    { label: "Organization private", value: count(organization.private) },
    { label: "Organization internal", value: count(organization.internal) },
  ];
}

function packageAliasMap(inventory = {}) {
  const aliases = new Map();
  for (const bundle of inventory.bundles || []) {
    const canonicalId = String(bundle.id || "").trim();
    const legacyId = String(bundle.controlPackage || "").trim();
    if (canonicalId && legacyId && legacyId !== canonicalId) aliases.set(legacyId, canonicalId);
  }
  return aliases;
}

function packageMemberships(deployed, packageAliases = new Map()) {
  const memberships = new Map();
  for (const bundle of deployed.bundles || []) {
    for (const workflow of bundle.workflows || []) {
      const key = `${bundle.repository}:${workflow.lockPath}`;
      const discoveredId = bundle.path?.replace(/\/aw\.yml$|^aw\.yml$/g, "") || bundle.name;
      const membership = {
        id: packageAliases.get(discoveredId) || discoveredId,
        name: bundle.name,
      };
      const workflowMemberships = memberships.get(key) || [];
      if (!workflowMemberships.some((candidate) => candidate.id === membership.id)) {
        workflowMemberships.push(membership);
        workflowMemberships.sort((left, right) => left.name.localeCompare(right.name));
        memberships.set(key, workflowMemberships);
      }
    }
  }
  return memberships;
}

function workflowAdmission(controlSettings, packageName, role, workflowId) {
  if (!Object.hasOwn(controlSettings, "packages")) return null;
  if (controlSettings.policy_resolution?.status === "unavailable") {
    return { status: "unavailable", reason: controlSettings.policy_resolution.reason || "policy-resolution-unavailable" };
  }
  const packagePolicy = controlSettings.packages?.[packageName];
  if (!packagePolicy) return { status: "blocked", reason: "package-undeclared" };
  if (packagePolicy.enabled === false) return { status: "blocked", reason: "package-disabled" };
  if (role === "worker") {
    const workerPolicy = packagePolicy.worker_policies?.[workflowId];
    if (!workerPolicy) return { status: "blocked", reason: "worker-undeclared" };
    if (workerPolicy.enabled === false) return { status: "blocked", reason: "worker-disabled" };
  }
  return { status: "authorized", reason: "authorized" };
}

function inventoryWorkflowDetails(inventory = {}, controlSettings = {}) {
  const details = new Map();
  for (const workflow of inventory.workflows || []) {
    for (const workflowPath of [workflow.sourcePath, workflow.lockPath].filter(Boolean)) {
      details.set(workflowPath, {
        maxAiCredits: workflow.maxAiCredits,
        inventoryReady: workflow.compiled,
      });
    }
  }
  for (const bundle of inventory.bundles || []) {
    const policyId = String(
      bundle.controlPackage
      || bundle.id
      || String(bundle.path || "").replace(/\/aw\.yml$|^aw\.yml$/g, "")
    ).trim();
    const packagePolicy = controlSettings.packages?.[policyId]
      || controlSettings.packages?.[bundle.id];
    const configuredMode = rolloutMode(packagePolicy?.mode);
    const rolloutPercent = Number(packagePolicy?.["rollout-percent"] ?? packagePolicy?.rollout_percent);
    const targetPolicies = new Map(Object.entries(packagePolicy?.targets ?? packagePolicy?.target_policies ?? {})
      .map(([repository, targetPolicy]) => [repository.toLowerCase(), { repository, targetPolicy }]));
    const targetRepositories = new Map();
    for (const repository of controlSettings.allowed_repositories ?? []) {
      const name = String(repository).trim();
      if (name) targetRepositories.set(name.toLowerCase(), name);
    }
    for (const [repository, { repository: name }] of targetPolicies) targetRepositories.set(repository, name);
    const packageTargets = [...targetRepositories.entries()]
      .map(([key, repository]) => ({
        repository,
        mode: rolloutMode(targetPolicies.get(key)?.targetPolicy?.mode ?? configuredMode),
        explicit: targetPolicies.has(key),
      }))
      .filter((target) => target.mode !== "unknown" && target.repository);
    const packageId = String(bundle.id || bundle.controlPackage || "").trim();
    const packageName = String(bundle.name || packageId).trim();
    const packageMembership = packageId ? { id: packageId, name: packageName || packageId } : undefined;
    const packageIcon = packagePolicy?.icon || "package";
    const workers = bundle.workers || [];
    const ready = bundle.compiled === true
      && (bundle.missingWorkers || []).length === 0
      && workers.every((worker) => worker.compiled !== false);
    const inventoryWarnings = (bundle.compiled === true ? 0 : 1) + (bundle.missingWorkers || []).length;
    const packageAllowance = [bundle.maxAiCredits, ...workers.map((worker) => worker.maxAiCredits)]
      .filter((value) => Number.isFinite(value) && value > 0)
      .reduce((total, value) => total + value, 0);
    const packageWorkflows = [
      { sourcePath: bundle.workflow, lockPath: bundle.workflow?.replace(/\.md$/, ".lock.yml"), maxAiCredits: bundle.maxAiCredits, role: "orchestrator", id: bundle.id },
      ...workers.map((worker) => ({ ...worker, role: "worker" })),
    ];
    for (const workflow of packageWorkflows) {
      const admission = workflowAdmission(controlSettings, bundle.controlPackage, workflow.role, workflow.id);
      for (const workflowPath of [workflow.sourcePath, workflow.lockPath].filter(Boolean)) {
        details.set(workflowPath, {
          ...details.get(workflowPath),
          maxAiCredits: workflow.maxAiCredits ?? details.get(workflowPath)?.maxAiCredits,
          inventoryReady: ready,
          packageInventoryWarnings: inventoryWarnings,
          packageAllowance: packageAllowance > 0 ? packageAllowance : null,
          packageWorkerCount: workers.length,
          ...(Number.isFinite(rolloutPercent) ? { packageRolloutPercent: rolloutPercent } : {}),
          ...(packageTargets.length > 0 ? { packageTargets } : {}),
          ...(packageMembership ? { packageMembership } : {}),
          packageIcon,
          ...(configuredMode !== "unknown" ? { configuredMode } : {}),
          ...(admission ? { admissionStatus: admission.status, admissionReason: admission.reason } : {}),
        });
      }
    }
  }
  return details;
}

function workflowRows(deployed, generatedAt, inventory, controlSettings) {
  const memberships = packageMemberships(deployed, packageAliasMap(inventory));
  const inventoryDetails = inventoryWorkflowDetails(inventory, controlSettings);
  return (deployed.workflows || []).map((workflow) => {
    const names = repositoryParts(workflow.repository);
    const details = inventoryDetails.get(workflow.path);
    const discoveredMemberships = memberships.get(`${workflow.repository}:${workflow.path}`) || [];
    const workflowMemberships = details?.packageMembership
      ? [details.packageMembership]
      : discoveredMemberships;
    const membership = workflowMemberships.at(-1);
    const packageIcon = details?.packageIcon
      || controlSettings.packages?.[membership?.id]?.icon
      || "package";
    const recentMode = rolloutMode(workflow.runHealth?.runRecords?.[0]?.displayTitle);
    const workflowRepository = String(workflow.repository ?? "").toLowerCase();
    const packageTargets = (details?.packageTargets ?? [])
      .filter((target) => target.explicit || target.repository.toLowerCase() !== workflowRepository)
      .map(({ repository, mode }) => ({ repository, mode }));
    return {
     ...names,
     ...(membership ? { package: membership.id, "package-name": membership.name } : {}),
     ...(membership ? { "package-icon": packageIcon } : {}),
     ...(workflowMemberships.length > 0 ? { "package-memberships": workflowMemberships } : {}),
     ...(Number.isFinite(details?.maxAiCredits) ? { "max-ai-credits": details.maxAiCredits } : {}),
     ...(Number.isFinite(details?.packageAllowance) ? { "package-aic-allowance": details.packageAllowance } : {}),
     ...(Number.isFinite(details?.packageWorkerCount) ? { "package-worker-count": details.packageWorkerCount } : {}),
     ...(Number.isFinite(details?.packageInventoryWarnings) ? { "package-inventory-warnings": details.packageInventoryWarnings } : {}),
    ...(Number.isFinite(details?.packageRolloutPercent) ? { "package-rollout-percent": details.packageRolloutPercent } : {}),
    ...(packageTargets.length > 0 ? { "package-targets": packageTargets } : {}),
     ...(typeof details?.inventoryReady === "boolean" ? { "inventory-ready": details.inventoryReady } : {}),
     ...(details?.admissionStatus ? { "admission-status": details.admissionStatus } : {}),
     ...(details?.admissionReason ? { "admission-reason": details.admissionReason } : {}),
     "workflow-role": workflow.role || (membership ? "worker" : "standalone"),
      workflow: workflow.path?.replace(/\.lock\.yml$/, ".md") || "",
      "workflow-name": workflow.name || workflow.path || "Unknown workflow",
      "workflow-active": workflow.state === "active"
        ? "true"
        : String(workflow.state).startsWith("disabled") ? "false" : "unknown",
      "gh-aw-version": workflow.ghAwVersion || "unknown",
      "gh-aw-current-version": workflow.currentGhAwVersion || deployed.latestGhAwVersion || "unknown",
      "gh-aw-version-label": workflow.ghAwVersion
        ? `${workflow.ghAwVersion}${workflow.ghAwVersion === (workflow.currentGhAwVersion || deployed.latestGhAwVersion) ? " (current)" : ""}`
        : "unknown",
      "gh-aw-update-state": workflow.updateState || "unknown",
      "gh-aw-metadata": workflow.ghAwMetadata || null,
      "gh-aw-manifest": workflow.ghAwManifest || null,
      "rollout-mode": details?.packageTargets?.find(
        (target) => target.repository.toLowerCase() === workflowRepository,
      )?.mode || details?.configuredMode || recentMode,
      "observed-at": workflow.updatedAt || generatedAt,
    };
  });
}

function runRows(deployed, usage) {
  const rows = new Map();
  const dataByRun = new Map([...(usage.securityRuns || []), ...(usage.runs || [])].map((run) => [
    `${String(run.repository || "").toLowerCase()}:${run.runId}`,
    run.data ?? null,
  ]));
  const metadataByRun = new Map([...(usage.securityRuns || []), ...(usage.runs || [])].map((run) => [
    `${String(run.repository || "").toLowerCase()}:${run.runId}`,
    run,
  ]));
  for (const workflow of deployed.workflows || []) {
    const names = repositoryParts(workflow.repository);
    for (const run of workflow.runHealth?.runRecords || []) {
      const key = `${workflow.repository}:${run.runId}`;
      const usageRun = metadataByRun.get(key.toLowerCase()) || {};
      rows.set(key, {
        ...names,
        workflow: workflow.path?.replace(/\.lock\.yml$/, ".md") || "",
        run: String(run.runId),
        event: run.event || "unknown",
        "run-title": run.displayTitle || `Run ${run.runId}`,
        "started-at": run.startedAt || run.createdAt,
        "ended-at": run.status === "completed" ? run.updatedAt : undefined,
        "run-status": run.status === "in_progress" ? "in-progress" : run.status || "unknown",
        "run-conclusion": runConclusion(run.conclusion),
        ...(run.admissionStatus ? { "admission-status": run.admissionStatus } : {}),
        ...(run.admissionReason ? { "admission-reason": run.admissionReason } : {}),
        ...(run.failureJob ? { "failure-job": run.failureJob } : {}),
        ...(run.failureMessage ? { "failure-message": run.failureMessage } : {}),
        ...(run.failureStep ? { "failure-step": run.failureStep } : {}),
        ...(run.resource ? { resource: run.resource } : {}),
        ...(run.resourceResetAt ? { "resource-reset-at": run.resourceResetAt } : {}),
        ...(Number.isFinite(run.resourceWaitHours) ? { "resource-wait-hours": run.resourceWaitHours } : {}),
        "rollout-mode": rolloutMode(run.displayTitle),
        engine: firstText(run.engine, run.agenticEngine, run.agentic_engine, usageRun.engine, usageRun.agenticEngine, usageRun.agentic_engine) || "unknown",
        "engine-version": firstText(run.engineVersion, run.engine_version, run.agenticEngineVersion, run.agentic_engine_version, usageRun.engineVersion, usageRun.engine_version, usageRun.agenticEngineVersion, usageRun.agentic_engine_version) || "unknown",
        "requested-model": firstText(run.requestedModel, run.requested_model, run.model, usageRun.requestedModel, usageRun.requested_model, usageRun.model) || "unknown",
        "resolved-model": firstText(run.resolvedModel, run.resolved_model, run.model, usageRun.resolvedModel, usageRun.resolved_model, usageRun.model) || "unknown",
        data: dataByRun.get(key.toLowerCase()) ?? null,
        "logs-payload": usageRun.logsPayload ?? null,
        "run-link": link("run", `https://github.com/${workflow.repository}/actions/runs/${run.runId}`, `View run ${run.runId}`),
      });
    }
  }
  return [...rows.values()];
}

function admissionRows(deployed) {
  const admissions = [];
  const checks = [];
  for (const workflow of deployed.workflows || []) {
    const names = repositoryParts(workflow.repository);
    for (const run of workflow.runHealth?.runRecords || []) {
      const admission = run.admission;
      if (!admission) continue;
      const row = {
        ...names,
        workflow: workflow.path?.replace(/\.lock\.yml$/, ".md") || "",
        run: String(run.runId),
        "observed-at": admission.observedAt,
        package: admission.package || "unknown",
        "workflow-role": admission.role || workflow.role || "unknown",
        worker: admission.worker || "",
        "target-repository": admission.targetRepository || "",
        "admission-status": admission.authorized ? "authorized" : "denied",
        "admission-reason": admission.reason,
        "failed-check": admission.failedCheck || "",
        "github-api-status": admission.githubApiCapacity?.status || "unknown",
        "github-api-remaining": finite(admission.githubApiCapacity?.remaining),
        "github-api-required": finite(admission.githubApiCapacity?.required),
        "github-api-reset-at": admission.githubApiCapacity?.resetAt || "",
        "runner-disk-status": admission.runnerDiskCapacity?.status || "unknown",
        "runner-disk-available-mb": finite(admission.runnerDiskCapacity?.available),
        "runner-disk-required-mb": finite(admission.runnerDiskCapacity?.required),
        "run-link": link("run", workflowRunUrl(workflow.repository, run.runId), `Run ${run.runId}`),
      };
      admissions.push(row);
      for (const [index, check] of (admission.checks || []).entries()) {
        checks.push({
          ...row,
          check: check.check,
          "check-order": index + 1,
          "check-status": check.status,
        });
      }
    }
  }
  return { admissions, checks };
}

function usageRows(usage) {
  return (usage.runs || []).map((run, index) => ({
    ...repositoryParts(run.repository),
    workflow: run.workflowPath?.replace(/\.lock\.yml$/, ".md") || run.workflowName || "",
    run: String(run.runId),
    invocation: `${run.repository}:${run.runId}:${index}`,
    engine: firstText(run.engine, run.agenticEngine, run.agentic_engine) || "unknown",
    "engine-version": firstText(run.engineVersion, run.engine_version, run.agenticEngineVersion, run.agentic_engine_version) || "unknown",
    "requested-model": firstText(run.requestedModel, run.requested_model, run.model) || "unknown",
    "resolved-model": firstText(run.resolvedModel, run.resolved_model, run.model) || "unknown",
    "sandbox-runtime": firstText(run.agentRuntime, run.agent_runtime) || "unknown",
    "rollout-mode": run.mode || "unknown",
    "input-tokens": finite(run.tokenUsage?.inputTokens),
    "output-tokens": finite(run.tokenUsage?.outputTokens),
    "cache-read-tokens": finite(run.tokenUsage?.cacheReadTokens),
    "cache-write-tokens": finite(run.tokenUsage?.cacheWriteTokens),
    "reasoning-tokens": finite(run.tokenUsage?.reasoningTokens),
    aic: run.aic,
    "estimated-usd": run.aic !== null && run.aic !== undefined && run.aic !== "" && Number.isFinite(Number(run.aic))
      ? Number(run.aic) * AIC_TO_USD
      : null,
    "observed-at": run.createdAt || usage.generatedAt,
    "run-link": link("run", workflowRunUrl(run.repository, run.runId), `Run ${run.runId}`),
  }));
}

function collectedLogRuns(usage) {
  const runs = new Map();
  for (const run of [...(usage.runs || []), ...(usage.securityRuns || [])]) {
    const key = `${String(run.repository || "").toLowerCase()}:${run.runId}`;
    runs.set(key, { ...(runs.get(key) || {}), ...run });
  }
  return [...runs.values()];
}

function experimentTelemetryRows(usage) {
  const definitions = new Map();
  const assignments = [];
  for (const run of collectedLogRuns(usage)) {
    const assigned = run.experiments?.assignments;
    if (!assigned || typeof assigned !== "object" || Array.isArray(assigned)) continue;
    for (const [experiment, variant] of Object.entries(assigned)) {
      const names = repositoryParts(run.repository);
      const workflow = run.workflowPath?.replace(/\.lock\.yml$/, ".md") || run.workflowName || "";
      const observedAt = run.createdAt || usage.generatedAt;
      definitions.set(`${run.repository}:${workflow}:${experiment}`, {
        ...names,
        workflow,
        experiment,
        "experiment-name": experiment,
        "control-variant": "",
        "candidate-variant": "",
        "primary-metric": "",
        "primary-source": "gh-aw-logs",
        state: "collecting",
        readiness: "collecting",
        decision: "collecting",
        "normalized-effect": null,
        "evidence-strength": "Observed assignments",
        "last-observation": observedAt,
        "observed-at": observedAt,
      });
      assignments.push({
        ...names,
        workflow,
        run: String(run.runId),
        experiment,
        variant: String(variant),
        "assignment-at": observedAt,
        included: "true",
        "exclusion-reason": "",
        "observed-at": observedAt,
        "assignment-link": link("run", workflowRunUrl(run.repository, run.runId), `Run ${run.runId}`),
      });
    }
  }
  return { definitions: [...definitions.values()], assignments };
}

function graderTelemetryRows(usage) {
  const definitions = new Map();
  const observations = [];
  for (const run of collectedLogRuns(usage)) {
    for (const result of run.graders?.results || []) {
      const grader = firstText(result?.id);
      if (!grader) continue;
      const names = repositoryParts(run.repository);
      const workflow = run.workflowPath?.replace(/\.lock\.yml$/, ".md") || run.workflowName || "";
      const observedAt = run.createdAt || usage.generatedAt;
      definitions.set(grader, {
        grader,
        "grader-name": firstText(result.name) || grader,
        role: "metric",
        direction: firstText(result.direction) || "unknown",
        unit: firstText(result.unit) || "",
        threshold: finite(result.threshold),
        "observed-at": observedAt,
      });
      observations.push({
        ...names,
        workflow,
        run: String(run.runId),
        grader,
        value: finite(result.value),
        status: firstText(result.status) || "unavailable",
        included: "true",
        "exclusion-reason": "",
        role: "metric",
        direction: firstText(result.direction) || "unknown",
        unit: firstText(result.unit) || "",
        threshold: finite(result.threshold),
        "rollout-mode": run.mode || "unknown",
        "maturity-status": "observed",
        "observed-at": observedAt,
        "run-link": link("run", workflowRunUrl(run.repository, run.runId), `Run ${run.runId}`),
      });
    }
  }
  return { definitions: [...definitions.values()], observations };
}

function evalTelemetryRows(usage) {
  const definitions = new Map();
  const observations = [];
  for (const run of collectedLogRuns(usage)) {
    for (const result of run.evals || []) {
      const evalId = firstText(result?.id);
      if (!evalId) continue;
      const names = repositoryParts(run.repository);
      const workflow = run.workflowPath?.replace(/\.lock\.yml$/, ".md") || run.workflowName || "";
      const observedAt = firstText(result.timestamp, run.createdAt, usage.generatedAt);
      definitions.set(evalId, {
        eval: evalId,
        "eval-name": evalId,
        "eval-question": "",
        "requested-model": run.requestedModel || "unknown",
        role: "metric",
        direction: "maximize",
        "observed-at": observedAt,
      });
      observations.push({
        ...names,
        workflow,
        run: String(run.runId),
        eval: evalId,
        "eval-result": firstText(result.answer).toUpperCase() || "UNKNOWN",
        status: firstText(result.answer).toUpperCase() === "YES"
          ? "pass"
          : firstText(result.answer).toUpperCase() === "NO" ? "fail" : "unavailable",
        included: "true",
        "exclusion-reason": "",
        role: "metric",
        direction: "maximize",
        "requested-model": run.requestedModel || "unknown",
        "resolved-model": run.resolvedModel || "unknown",
        "rollout-mode": run.mode || "unknown",
        "observed-at": observedAt,
        "evidence-link": link("run", workflowRunUrl(run.repository, run.runId), `Run ${run.runId}`),
      });
    }
  }
  return { definitions: [...definitions.values()], observations };
}

function durationSeconds(start, end) {
  const duration = Date.parse(String(end || "")) - Date.parse(String(start || ""));
  return Number.isFinite(duration) && duration >= 0 ? duration / 1000 : null;
}

function performanceRows(deployed, usage) {
  const metadataByRun = new Map((usage.runs || []).map((run) => [
    `${String(run.repository || "").toLowerCase()}:${run.runId}`,
    {
      engine: firstText(run.engine, run.agenticEngine, run.agentic_engine) || "unknown",
      "sandbox-runtime": firstText(run.agentRuntime, run.agent_runtime) || "unknown",
      model: firstText(run.resolvedModel, run.resolved_model, run.requestedModel, run.requested_model, run.model) || "unknown",
    },
  ]));
  const runs = [];
  const jobs = [];
  for (const workflow of deployed.workflows || []) {
    const repository = String(workflow.repository || "");
    const names = repositoryParts(repository);
    for (const run of workflow.runHealth?.runRecords || []) {
      const runDuration = durationSeconds(run.startedAt || run.createdAt, run.status === "completed" ? run.updatedAt : null);
      const metadata = metadataByRun.get(`${repository.toLowerCase()}:${run.runId}`) || {
        engine: "unknown",
        "sandbox-runtime": "unknown",
        model: "unknown",
      };
      const common = {
        ...names,
        workflow: workflow.path?.replace(/\.lock\.yml$/, ".md") || "",
        run: String(run.runId),
        "started-at": run.startedAt || run.createdAt,
        "run-conclusion": runConclusion(run.conclusion),
        "rollout-mode": rolloutMode(run.displayTitle),
        ...metadata,
        "run-link": link("run", workflowRunUrl(repository, run.runId), `View run ${run.runId}`),
      };
      if (runDuration !== null) {
        runs.push({ ...common, "run-duration-seconds": runDuration });
      }
      for (const job of run.jobs || []) {
        const jobDuration = durationSeconds(job.startedAt, job.completedAt);
        const labels = Array.isArray(job.labels) ? job.labels.filter(Boolean) : [];
        jobs.push({
          ...common,
          job: job.name || "Unknown job",
          "job-status": job.status || "unknown",
          "job-conclusion": runConclusion(job.conclusion),
          runner: labels.join(", ") || job.runnerName || "unknown",
          "runner-name": job.runnerName || "unknown",
          "runner-group": job.runnerGroupName || "unknown",
          "job-duration-seconds": jobDuration,
        });
      }
    }
  }
  return { runs, jobs };
}

function positiveCount(value) {
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? count : 0;
}

function safeOutputPerformanceRows(usage) {
  const runs = Array.isArray(usage.securityRuns) ? usage.securityRuns : [];
  const categories = [
    ["output", "Output", "success", "safeItemsCount"],
    ["noop", "No-op", "neutral", "noopCount"],
    ["missing_data", "Missing data", "warning", "missingDataCount"],
    ["missing_tool", "Missing tool", "warning", "missingToolCount"],
    ["report_incomplete", "Report incomplete", "warning", "reportIncompleteCount"],
  ];
  return runs.flatMap((run) => {
    const common = {
      ...repositoryParts(run.repository),
      workflow: run.workflowPath?.replace(/\.lock\.yml$/, ".md") || run.workflowName || "",
      run: String(run.runId),
      "run-conclusion": runConclusion(run.conclusion),
      "rollout-mode": rolloutMode(run.mode),
      "observed-at": run.createdAt || usage.generatedAt,
      "run-link": link("run", workflowRunUrl(run.repository, run.runId), `View run ${run.runId}`),
    };
    return categories.flatMap(([kind, label, status, field]) => {
      const count = positiveCount(run[field]);
      return count > 0 ? [{
        ...common,
        "safe-output-kind": kind,
        "safe-output-label": label,
        "safe-output-status": status,
        "safe-output-count": count,
      }] : [];
    });
  });
}

function securityObservation(run, feature, analysis, signal, status, count, subject = "") {
  return {
    ...repositoryParts(run.repository),
    workflow: run.workflowPath?.replace(/\.lock\.yml$/, ".md") || run.workflowName || "",
    run: String(run.runId),
    "security-observation": JSON.stringify([run.repository, run.runId, feature, analysis, signal, subject]),
    "security-feature": feature,
    "security-analysis": analysis,
    "security-signal": signal,
    "security-status": status,
    "security-subject": subject,
    "security-count": count,
    "observed-at": run.createdAt,
    "run-link": link("run", workflowRunUrl(run.repository, run.runId), `Run ${run.runId}`),
  };
}

function unavailableSecurityObservation(run, feature) {
  return securityObservation(run, feature, "summary", "Telemetry unavailable", "unavailable", 1);
}

function accessControlRows(run) {
  const access = run.security?.accessControl;
  if (!access?.available) return [unavailableSecurityObservation(run, "access-control")];
  const rows = [];
  const fileDenials = Object.entries(access.fileDenials || {})
    .map(([kind, count]) => [kind, positiveCount(count)])
    .filter(([, count]) => count > 0);
  const toolDenials = Object.entries(access.toolDenials || {})
    .map(([kind, count]) => [kind, positiveCount(count)])
    .filter(([, count]) => count > 0);
  const guardPolicy = access.guardPolicy || {};
  const guardDenials = {
    "Repository scope": positiveCount(guardPolicy.repo_scope_blocked),
    "General access": positiveCount(guardPolicy.access_denied),
    "Blocked user": positiveCount(guardPolicy.blocked_user_denied),
    "Insufficient permission": positiveCount(guardPolicy.permission_denied),
    "Private repository": positiveCount(guardPolicy.private_repo_denied),
  };
  const fileTotal = fileDenials.reduce((total, [, count]) => total + count, 0);
  const toolTotal = toolDenials.reduce((total, [, count]) => total + count, 0)
    + Object.values(guardDenials).reduce((total, count) => total + count, 0);
  rows.push(
    securityObservation(run, "access-control", "summary", "File access denied", "denied", fileTotal),
    securityObservation(run, "access-control", "summary", "Tool access denied", "denied", toolTotal),
  );
  for (const [kind, count] of fileDenials) {
    rows.push(securityObservation(run, "access-control", "detail", `${kind} denied`, "denied", count, "Filesystem"));
  }
  for (const [kind, count] of toolDenials) {
    rows.push(securityObservation(run, "access-control", "detail", `${kind} denied`, "denied", count, "Agent tool"));
  }
  for (const [signal, count] of Object.entries(guardDenials).filter(([, count]) => count > 0)) {
    rows.push(securityObservation(run, "access-control", "detail", signal, "denied", count, "MCP guard"));
  }
  if (fileTotal + toolTotal === 0) {
    rows.push(securityObservation(run, "access-control", "detail", "No denials observed", "clear", 0));
  }
  return rows;
}

function firewallRows(run) {
  const firewall = run.security?.firewall;
  if (!firewall?.available) return [unavailableSecurityObservation(run, "firewall")];
  const analysis = firewall.analysis || {};
  const rows = [
    securityObservation(run, "firewall", "summary", "Allowed requests", "allowed", positiveCount(analysis.allowed_requests)),
    securityObservation(run, "firewall", "summary", "Blocked requests", "blocked", positiveCount(analysis.blocked_requests)),
  ];
  for (const [domain, counts] of Object.entries(analysis.requests_by_domain || {})) {
    const allowed = positiveCount(counts?.allowed);
    const blocked = positiveCount(counts?.blocked);
    if (allowed > 0) rows.push(securityObservation(run, "firewall", "detail", "Allowed request", "allowed", allowed, domain));
    if (blocked > 0) rows.push(securityObservation(run, "firewall", "detail", "Blocked request", "blocked", blocked, domain));
  }
  return rows;
}

function parseDestination(value) {
  const text = String(value || "").trim();
  if (!text || text === "(unknown)") return { domain: "unknown", host: "unknown", port: null, protocol: "unknown" };
  const explicitPort = text.match(/^(?:https?:\/\/)?(?:\[[^\]]+\]|[^/:]+):(\d+)(?:\/|$)/)?.[1];
  try {
    const parsed = new URL(text.includes("://") ? text : `https://${text}`);
    const port = explicitPort ? Number(explicitPort) : parsed.port ? Number(parsed.port) : null;
    return {
      domain: parsed.hostname.toLowerCase(),
      host: parsed.hostname.toLowerCase(),
      port,
      protocol: parsed.protocol === "http:" ? "http" : port === 443 || parsed.protocol === "https:" ? "https" : "unknown",
    };
  } catch {
    return { domain: text.toLowerCase(), host: text.toLowerCase(), port: null, protocol: "unknown" };
  }
}

function firewallCoverage(usage) {
  const requestedStart = Date.parse(usage.firewallRequestedHorizonStart);
  const requestedEnd = Date.parse(usage.firewallRequestedHorizonEnd);
  const observedStart = Date.parse(usage.firewallEvidenceHorizonStart);
  const observedEnd = Date.parse(usage.firewallEvidenceHorizonEnd);
  const requestedDuration = requestedEnd - requestedStart;
  const observedDuration = Math.max(0, Math.min(requestedEnd, observedEnd) - Math.max(requestedStart, observedStart));
  return requestedDuration > 0 && Number.isFinite(observedDuration)
    ? rounded((observedDuration / requestedDuration) * 100, 1)
    : null;
}

export function firewallRuleFor(manifest, observation) {
  const rules = Array.isArray(manifest?.rules) ? [...manifest.rules].sort((a, b) => Number(a.order) - Number(b.order)) : [];
  return rules.find((rule) => {
    const rawAction = String(rule?.action || "").toLowerCase();
    const action = rawAction === "allow" ? "allowed" : rawAction === "deny" ? "denied" : rawAction;
    const protocol = String(rule?.protocol || "both").toLowerCase();
    if (action !== observation.decision || (protocol !== "both" && protocol !== observation.protocol)) return false;
    if (String(rule?.aclName || "").toLowerCase() === "all") return true;
    return (rule?.domains || []).some((pattern) => {
      const normalized = String(pattern).toLowerCase();
      return normalized.startsWith(".")
        ? observation.domain === normalized.slice(1) || observation.domain.endsWith(normalized)
        : observation.domain === normalized;
    });
  });
}

function firewallRunBase(run, usage) {
  const firewall = run.security?.firewall || {};
  const evidenceStart = firewall.firewallEvidenceHorizonStart || usage.firewallEvidenceHorizonStart;
  const evidenceEnd = firewall.firewallEvidenceHorizonEnd || usage.firewallEvidenceHorizonEnd;
  return {
    ...repositoryParts(run.repository),
    workflow: run.workflowPath?.replace(/\.lock\.yml$/, ".md") || run.workflowName || "",
    run: String(run.runId),
    "run-conclusion": runConclusion(run.conclusion),
    "rollout-mode": rolloutMode(run.mode),
    "observed-at": evidenceEnd || run.createdAt || usage.generatedAt,
    "firewall-expected": firewall.firewallExpected === true ? "yes" : firewall.firewallExpected === false ? "no" : "unknown",
    "firewall-enabled": firewall.firewallEnabled === true ? "enabled" : firewall.firewallEnabled === false ? "disabled" : "unknown",
    "firewall-evidence-available": firewall.firewallEvidenceAvailable === true ? "available" : "unavailable",
    "evidence-state": firewall.firewallEvidenceState || "unknown",
    "evidence-completeness": firewall.firewallEvidenceCompleteness || "unknown",
    "evidence-freshness": firewall.firewallEvidenceFreshness || "unknown",
    "evidence-error": firewall.firewallEvidenceError || "",
    "evidence-source": firewall.firewallEvidenceSource || "none",
    "evidence-reference": firewall.firewallEvidenceReference || "",
    "evidence-horizon-start": evidenceStart,
    "evidence-horizon-end": evidenceEnd,
    "requested-horizon-start": usage.firewallRequestedHorizonStart,
    "requested-horizon-end": usage.firewallRequestedHorizonEnd,
    "evidence-coverage-percent": firewallCoverage(usage),
    "last-successful-collection-at": usage.firewallLastSuccessfulCollectionAt,
    "gh-aw-firewall-version": firewall.awfVersion || "unknown",
    "policy-manifest-available": firewall.policyManifest ? "available" : "unavailable",
    "policy-source": firewall.policyManifest ? "firewall-artifact" : "unavailable",
    "policy-manifest-identity": firewall.policyManifest
      ? `v${firewall.policyManifest.version ?? "unknown"}:${firewall.policyManifest.generatedAt || "unknown"}`
      : "unavailable",
    "run-link": link("run", workflowRunUrl(run.repository, run.runId), `Run ${run.runId}`),
    "evidence-link": link("evidence", workflowRunUrl(run.repository, run.runId), `Firewall evidence for run ${run.runId}`),
  };
}

function rawFirewallObservationRows(usage) {
  return (usage.securityRuns || []).flatMap((run) => {
    const firewall = run.security?.firewall || {};
    const base = firewallRunBase(run, usage);
    const collected = Array.isArray(firewall.observations) ? firewall.observations : [];
    const observations = collected.length > 0
      ? collected
      : Object.entries(firewall.analysis?.requests_by_domain || {}).flatMap(([destination, counts]) => {
        const parsed = parseDestination(destination);
        return [
          ...(positiveCount(counts?.allowed) > 0 ? [{ ...parsed, decision: "allowed", requestCount: positiveCount(counts.allowed), observedAt: base["observed-at"] }] : []),
          ...(positiveCount(counts?.blocked) > 0 ? [{ ...parsed, decision: "denied", requestCount: positiveCount(counts.blocked), observedAt: base["observed-at"] }] : []),
        ];
      });
    const reviewState = base["firewall-enabled"] === "disabled"
      ? "enforcement-disabled"
      : ["partial", "unavailable", "malformed", "unknown"].includes(base["evidence-state"])
        ? "evidence-missing"
        : null;
    const grouped = new Map();
    for (const observation of observations) {
      const destination = parseDestination(observation.host || observation.domain);
      const domain = observation.domain || destination.domain;
      const host = observation.host || destination.host;
      const port = finite(observation.port) ?? destination.port;
      const protocol = observation.protocol || destination.protocol;
      const decision = observation.decision === "blocked" ? "denied" : observation.decision || "unknown";
      const key = `${domain}\u0000${host}\u0000${port ?? ""}\u0000${protocol}\u0000${decision}`;
      const row = grouped.get(key) || {
        ...base,
        domain,
        host,
        port,
        protocol,
        decision,
        "request-count": 0,
        "first-seen-at": observation.observedAt || base["observed-at"],
        "last-seen-at": observation.observedAt || base["observed-at"],
        "review-state": reviewState,
      };
      row["request-count"] += positiveCount(observation.requestCount ?? 1);
      if (Date.parse(observation.observedAt) < Date.parse(row["first-seen-at"])) row["first-seen-at"] = observation.observedAt;
      if (Date.parse(observation.observedAt) > Date.parse(row["last-seen-at"])) row["last-seen-at"] = observation.observedAt;
      const rule = firewallRuleFor(firewall.policyManifest, { domain, protocol, decision });
      row["policy-rule-id"] = rule?.id || "unavailable";
      row["policy-rule-order"] = finite(rule?.order);
      row["policy-rule-action"] = rule?.action || "unavailable";
      row["policy-rule-protocol"] = rule?.protocol || "unavailable";
      row["policy-domain-pattern"] = Array.isArray(rule?.domains) ? rule.domains.join(", ") : "unavailable";
      row["policy-rule-description"] = rule?.description || "unavailable";
      grouped.set(key, row);
    }
    if (grouped.size === 0) {
      const reviewState = base["firewall-enabled"] === "disabled"
        ? "enforcement-disabled"
        : base["evidence-state"] === "no-traffic" ? "stable"
          : ["unavailable", "malformed", "unknown"].includes(base["evidence-state"]) ? "evidence-missing" : "unknown";
      return [{
        ...base,
        domain: "unknown",
        host: "unknown",
        port: null,
        protocol: "unknown",
        decision: "unknown",
        "request-count": null,
        "policy-rule-id": "unavailable",
        "policy-rule-order": null,
        "policy-rule-action": "unavailable",
        "policy-rule-protocol": "unavailable",
        "policy-domain-pattern": "unavailable",
        "policy-rule-description": "unavailable",
        "first-seen-at": null,
        "last-seen-at": null,
        "review-state": reviewState,
        "review-priority": {
          "enforcement-disabled": 1,
          "evidence-missing": 2,
          unknown: 8,
          stable: 9,
        }[reviewState] ?? 8,
      }];
    }
    return [...grouped.values()];
  });
}

function firewallObservationRows(usage) {
  const rows = rawFirewallObservationRows(usage);
  const scopes = Object.groupBy(rows, (row) => `${row.organization}/${row.repository}\u0000${row.workflow}`);
  const result = [];
  for (const scopedRows of Object.values(scopes)) {
    const runs = Object.values(Object.groupBy(scopedRows, (row) => row.run))
      .sort((left, right) => Date.parse(left[0]["observed-at"]) - Date.parse(right[0]["observed-at"]));
    let previous = null;
    for (const current of runs) {
      const previousByDomain = new Map((previous || []).filter((row) => row.domain !== "unknown").map((row) => [`${row.domain}:${row.port ?? ""}:${row.protocol}`, row]));
      const currentKeys = new Set();
      for (const row of current) {
        const key = `${row.domain}:${row.port ?? ""}:${row.protocol}`;
        currentKeys.add(key);
        const baseline = previousByDomain.get(key);
        row["baseline-request-count"] = baseline?.["request-count"] ?? null;
        row["request-volume-change"] = baseline && Number.isFinite(row["request-count"])
          ? row["request-count"] - baseline["request-count"]
          : null;
        row["previous-decision"] = baseline?.decision || "unknown";
        row["current-decision"] = row.decision;
        row["is-new-destination"] = Boolean(previous && row.domain !== "unknown" && !baseline);
        row["is-removed-destination"] = false;
        row["decision-changed"] = Boolean(baseline && baseline.decision !== row.decision);
        if (row["review-state"] || row["evidence-completeness"] !== "complete") row["drift-state"] = "unknown";
        else if (!previous) row["drift-state"] = "unknown";
        else if (!baseline) row["drift-state"] = row.decision === "allowed" ? "newly-allowed" : row.decision === "denied" ? "newly-denied" : "unknown";
        else if (row["decision-changed"]) row["drift-state"] = "decision-changed";
        else if (Math.abs(row["request-volume-change"] || 0) >= Math.max(5, baseline["request-count"] * 0.5)) row["drift-state"] = "volume-change";
        else row["drift-state"] = "stable";
        row["review-state"] ||= row.decision === "denied"
          && row["drift-state"] === "stable"
          && row["run-conclusion"] === "failure"
          ? "repeated-denial"
          : ["newly-allowed", "newly-denied", "decision-changed", "volume-change"].includes(row["drift-state"])
            ? row["drift-state"]
            : "stable";
        row["review-priority"] = {
          "enforcement-disabled": 1,
          "evidence-missing": 2,
          "newly-allowed": 3,
          "decision-changed": 4,
          "newly-denied": 5,
          "volume-change": 6,
          "repeated-denial": 7,
          unknown: 8,
          stable: 9,
        }[row["review-state"]] ?? 8;
        result.push(row);
      }
      if (previous) {
        for (const [key, row] of previousByDomain) {
          if (currentKeys.has(key)) continue;
          result.push({
            ...row,
            run: current[0].run,
            "observed-at": current[0]["observed-at"],
            "run-link": current[0]["run-link"],
            "evidence-link": current[0]["evidence-link"],
            decision: "unknown",
            "current-decision": "unknown",
            "previous-decision": row.decision,
            "request-count": null,
            "baseline-request-count": row["request-count"],
            "request-volume-change": null,
            "is-new-destination": false,
            "is-removed-destination": true,
            "decision-changed": false,
            "drift-state": "removed",
            "review-state": "stable",
            "review-priority": 9,
          });
        }
      }
      previous = current[0]?.["evidence-completeness"] === "complete"
        ? current.filter((row) => row.domain !== "unknown")
        : null;
    }
  }
  const reviewLabels = {
    "enforcement-disabled": "Enforcement disabled",
    "evidence-missing": "Evidence missing",
    "newly-allowed": "Newly allowed",
    "newly-denied": "New denial",
    "decision-changed": "Decision changed",
    "volume-change": "Request volume changed",
    "repeated-denial": "Repeated denial",
    stable: "Stable",
    unknown: "Unknown",
  };
  return result.map((row, index) => ({
    ...row,
    "firewall-observation": `${row.organization}/${row.repository}:${row.workflow}:${row.run}:${row.domain}:${row.port ?? ""}:${row.protocol}:${row.decision}:${index}`,
    "enforcement-label": row["firewall-enabled"] === "enabled" ? "Enabled"
      : row["firewall-enabled"] === "disabled" ? "Enforcement disabled" : "Unknown",
    "evidence-label": row["evidence-state"] === "no-traffic" ? "No observed traffic"
      : row["evidence-state"] === "disabled" ? "Enforcement disabled"
        : ["unavailable", "malformed", "unknown"].includes(row["evidence-state"]) ? "Evidence missing"
          : row["evidence-state"] === "partial" ? "Partial evidence" : "Evidence available",
    "decision-label": row.decision === "allowed" ? "Allowed by policy"
      : row.decision === "denied" ? "Denied by policy" : "Unknown",
    "drift-label": reviewLabels[row["drift-state"]] || "Unknown",
    "review-label": reviewLabels[row["review-state"]] || "Unknown",
  }));
}

function firewallPolicyRuleRows(usage) {
  return (usage.securityRuns || []).flatMap((run) => {
    const firewall = run.security?.firewall || {};
    const base = firewallRunBase(run, usage);
    const hitByRule = new Map((firewall.policyAnalysis?.rule_hits || []).map((entry) => [entry?.rule?.id, positiveCount(entry?.hits)]));
    if (!Array.isArray(firewall.policyAnalysis?.rule_hits) && Array.isArray(firewall.observations)) {
      for (const observation of firewall.observations) {
        const destination = parseDestination(observation.host || observation.domain);
        const normalized = {
          domain: observation.domain || destination.domain,
          protocol: observation.protocol || destination.protocol,
          decision: observation.decision === "blocked" ? "denied" : observation.decision || "unknown",
        };
        const rule = firewallRuleFor(firewall.policyManifest, normalized);
        if (rule?.id) hitByRule.set(rule.id, (hitByRule.get(rule.id) || 0) + positiveCount(observation.requestCount ?? 1));
      }
    }
    return (firewall.policyManifest?.rules || []).flatMap((rule) => (rule.domains?.length ? rule.domains : ["all"]).map((domain) => ({
      ...base,
      "rule-id": rule.id || "unknown",
      "rule-order": finite(rule.order),
      action: rule.action || "unknown",
      protocol: rule.protocol || "unknown",
      "domain-pattern": domain,
      description: rule.description || "",
      "hit-count": hitByRule.get(rule.id) ?? 0,
      "ssl-bump-enabled": firewall.policyManifest.sslBumpEnabled === true ? "enabled" : "disabled",
      "dlp-enabled": firewall.policyManifest.dlpEnabled === true ? "enabled" : "disabled",
      "host-access-enabled": firewall.policyManifest.hostAccessEnabled === true ? "enabled" : "disabled",
    })));
  });
}
function integrityRows(run) {
  const integrity = run.security?.integrity;
  if (!integrity?.available) return [unavailableSecurityObservation(run, "integrity-filtering")];
  const summary = integrity.summary || {};
  const filtered = positiveCount(summary.total_filtered);
  const passed = Math.max(0, positiveCount(integrity.totalToolCalls) - filtered);
  const rows = [
    securityObservation(run, "integrity-filtering", "summary", "Passed interactions", "passed", passed),
    securityObservation(run, "integrity-filtering", "summary", "Filtered interactions", "filtered", filtered),
  ];
  for (const [tool, count] of Object.entries(summary.filtered_tool_counts || {})) {
    rows.push(securityObservation(run, "integrity-filtering", "detail", "Filtered tool", "filtered", positiveCount(count), tool));
  }
  for (const [reason, count] of Object.entries(summary.filtered_reason_counts || {})) {
    rows.push(securityObservation(run, "integrity-filtering", "detail", "Filter reason", "filtered", positiveCount(count), reason));
  }
  if (filtered === 0) {
    rows.push(securityObservation(run, "integrity-filtering", "detail", "No interactions filtered", "clear", 0));
  }
  return rows;
}

function threatDetectionRows(run) {
  const detection = run.security?.threatDetection;
  if (!detection?.available) return [unavailableSecurityObservation(run, "threat-detection")];
  const verdict = detection.verdict || {};
  const categories = [
    ["Prompt injection", verdict.promptInjection],
    ["Secret leak", verdict.secretLeak],
    ["Malicious patch", verdict.maliciousPatch],
  ];
  const rows = categories.flatMap(([signal, detected]) => [
    securityObservation(run, "threat-detection", "summary", signal, detected ? "detected" : "clear", 1),
    securityObservation(run, "threat-detection", "detail", signal, detected ? "detected" : "clear", 1),
  ]);
  for (const warning of verdict.warnings || []) {
    rows.push(securityObservation(
      run,
      "threat-detection",
      "detail",
      "Inspection warning",
      "warning",
      1,
      [warning.field, warning.code].filter(Boolean).join(": "),
    ));
  }
  return rows;
}

function securityObservationRows(usage) {
  return (usage.securityRuns || []).flatMap((run) => [
    ...accessControlRows(run),
    ...firewallRows(run),
    ...integrityRows(run),
    ...threatDetectionRows(run),
  ]);
}

const DETECTION_FAILURE_CONCLUSIONS = new Set([
  "failure", "cancelled", "timed-out", "action-required", "stale", "startup-failure",
]);

export function deriveDetectionState({ verdictAvailable, threatsDetected, warningCount, jobConclusion, telemetryAvailable = true }) {
  // Precedence preserves security outcomes independently from job mechanics:
  // threat > tooling failure > degraded > clean > skipped > unknown.
  if (verdictAvailable && threatsDetected) return "threat";
  if (!verdictAvailable && DETECTION_FAILURE_CONCLUSIONS.has(jobConclusion)) return "tooling-failure";
  if (verdictAvailable && warningCount > 0) return "degraded";
  if (verdictAvailable) return "clean";
  if (jobConclusion === "skipped") return "skipped";
  if (telemetryAvailable && jobConclusion === "success") return "tooling-failure";
  return "unknown";
}

function detectionSignal(state, verdict, warningText) {
  if (state === "threat") {
    return [
      verdict.promptInjection && "Prompt injection",
      verdict.secretLeak && "Secret leak",
      verdict.maliciousPatch && "Malicious patch",
    ].filter(Boolean).join(", ");
  }
  if (state === "degraded") return warningText || "Inspection warning";
  if (state === "tooling-failure") return "No usable verdict";
  if (state === "skipped") return "Detection skipped";
  if (state === "clean") return "Usable verdict; no threats";
  return "Detection telemetry unavailable";
}

export function detectionObservationRows(usage, jobs = []) {
  const securityRuns = Array.isArray(usage.securityRuns) ? usage.securityRuns : [];
  const observationKey = (repository, run) => `${String(repository || "").trim().toLowerCase()}:${String(run)}`;
  const securityByRun = new Map(securityRuns.map((run) => [
    observationKey(run.repository, run.runId),
    run,
  ]));
  const detectionJobs = jobs.filter((job) => String(job.job || "").toLowerCase() === "detection");
  const jobByRun = new Map(detectionJobs.map((job) => [
    observationKey([job.organization, job.repository].filter(Boolean).join("/"), job.run),
    job,
  ]));
  const keys = new Set([...securityByRun.keys(), ...jobByRun.keys()]);
  return [...keys].map((key) => {
    const run = securityByRun.get(key);
    const job = jobByRun.get(key);
    const verdictAvailable = run?.security?.threatDetection?.available === true;
    const verdict = run?.security?.threatDetection?.verdict || {};
    const warnings = Array.isArray(verdict.warnings) ? verdict.warnings : [];
    const threatsDetected = verdictAvailable && Boolean(
      verdict.promptInjection || verdict.secretLeak || verdict.maliciousPatch,
    );
    const jobConclusion = job?.["job-conclusion"] || "unknown";
    const normalizedJobConclusion = runConclusion(jobConclusion);
    const state = deriveDetectionState({
      verdictAvailable,
      threatsDetected,
      warningCount: warnings.length,
      jobConclusion: normalizedJobConclusion,
      telemetryAvailable: usage.securityAvailable === true,
    });
    const warningText = warnings
      .map((warning) => [warning.field, warning.code].filter(Boolean).join(": "))
      .filter(Boolean)
      .join(", ");
    const repository = run?.repository || [job?.organization, job?.repository].filter(Boolean).join("/");
    const runId = String(run?.runId ?? job?.run ?? "");
    return {
      ...repositoryParts(repository),
      workflow: run?.workflowPath?.replace(/\.lock\.yml$/, ".md") || run?.workflowName || job?.workflow || "",
      run: runId,
      "observed-at": run?.createdAt || job?.["started-at"] || usage.generatedAt,
      "run-link": job?.["run-link"] || link("run", workflowRunUrl(repository, runId), `View run ${runId}`),
      "rollout-mode": rolloutMode(run?.mode || job?.["rollout-mode"]),
      "detection-expected": job ? "true" : "unknown",
      "detection-applicable": normalizedJobConclusion === "skipped" ? "false" : job ? "true" : "unknown",
      "detection-executed": normalizedJobConclusion === "skipped" ? "false" : (job || verdictAvailable) ? "true" : "unknown",
      "verdict-available": verdictAvailable ? "true" : "false",
      "usable-verdict-percent": verdictAvailable ? 100 : 0,
      "detection-state": state,
      "detection-state-label": state.split("-").map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`).join(" "),
      "detection-count": 1,
      "prompt-injection-detected": verdict.promptInjection === true ? "true" : "false",
      "secret-leak-detected": verdict.secretLeak === true ? "true" : "false",
      "malicious-patch-detected": verdict.maliciousPatch === true ? "true" : "false",
      "inspection-warning-count": warnings.length,
      "inspection-warning": warningText,
      "detection-signal": detectionSignal(state, verdict, warningText),
      "attention-priority": {
        threat: 1,
        "tooling-failure": 2,
        degraded: 3,
        unknown: 4,
        skipped: 5,
        clean: 6,
      }[state],
      "job-status": job?.["job-status"] || "unknown",
      "job-conclusion": normalizedJobConclusion,
      "job-duration-seconds": job?.["job-duration-seconds"] ?? null,
      runner: job?.runner || "unknown",
      engine: run?.engine || job?.engine || "unknown",
      "requested-model": run?.requestedModel || "unknown",
      "resolved-model": run?.resolvedModel || job?.model || "unknown",
    };
  });
}

function mcpBase(run) {
  return {
    ...repositoryParts(run.repository),
    workflow: run.workflowPath?.replace(/\.lock\.yml$/, ".md") || run.workflowName || "",
    run: String(run.runId ?? ""),
    "rollout-mode": rolloutMode(run.mode),
    "engine-version": firstText(run.engineVersion) || "unknown",
    "gh-aw-version": firstText(run.security?.mcp?.cliVersion) || "unknown",
    "observed-at": run.createdAt,
    "run-link": link("run", workflowRunUrl(run.repository, run.runId), `Run ${run.runId}`),
  };
}

function mcpStatus(value) {
  const normalized = String(value || "").toLowerCase();
  if (normalized === "success" || normalized === "ok") return "success";
  return normalized ? "failure" : "missing";
}

function mcpCallRows(usage) {
  return (usage.securityRuns || []).flatMap((run) => {
    const mcp = run.security?.mcp;
    const base = mcpBase(run);
    if (!mcp?.available) {
      return [];
    }
    const versions = new Map((mcp.servers || []).map((server) => [server.serverName, server]));
    const calls = (mcp.calls || []).map((call, index) => {
      const server = versions.get(call.serverName);
      return {
        ...base,
        "mcp-observation": `${run.repository}:${run.runId}:call:${index}`,
        "mcp-server": call.serverName || "unknown",
        "mcp-server-version": server?.serverVersion || "unknown",
        "mcp-protocol-version": server?.protocolVersion || "unknown",
        "mcp-tool": call.toolName || "unknown",
        "mcp-status": mcpStatus(call.status),
        "response-bytes": finite(call.outputSize),
        "observed-at": call.timestamp || base["observed-at"],
      };
    });
    const failures = (mcp.failures || []).map((failure, index) => ({
      ...base,
      "mcp-observation": `${run.repository}:${run.runId}:failure:${index}`,
      "mcp-server": failure.serverName || "unknown",
      "mcp-server-version": versions.get(failure.serverName)?.serverVersion || "unknown",
      "mcp-protocol-version": versions.get(failure.serverName)?.protocolVersion || "unknown",
      "mcp-tool": "server",
      "mcp-status": "failure",
      "response-bytes": null,
    }));
    return [...calls, ...failures];
  });
}

function mcpServerRows(usage) {
  return (usage.securityRuns || []).flatMap((run) => {
    const mcp = run.security?.mcp;
    const base = mcpBase(run);
    if (!mcp?.available) {
      return [{
        ...base,
        "mcp-server-observation": `${run.repository}:${run.runId}:missing`,
        "mcp-server": "unknown",
        "mcp-server-version": "unknown",
        "mcp-protocol-version": "unknown",
        "mcp-status": "missing",
        "tool-calls": 0,
        "failed-calls": 0,
        "total-response-bytes": 0,
        "max-response-bytes": 0,
      }];
    }
    const servers = new Map((mcp.servers || []).map((server) => [server.serverName, { ...server }]));
    const reportedServers = new Set(servers.keys());
    for (const call of mcp.calls || []) {
      const server = servers.get(call.serverName) || {
        serverName: call.serverName || "unknown",
        serverVersion: "",
        protocolVersion: "",
        toolCallCount: 0,
        errorCount: 0,
        totalOutputSize: 0,
        maxOutputSize: 0,
      };
      if (!reportedServers.has(call.serverName)) {
        server.toolCallCount += 1;
        if (mcpStatus(call.status) === "failure") server.errorCount += 1;
        server.totalOutputSize += positiveCount(call.outputSize);
        server.maxOutputSize = Math.max(server.maxOutputSize, positiveCount(call.outputSize));
        servers.set(call.serverName, server);
      }
    }
    for (const failure of mcp.failures || []) {
      const server = servers.get(failure.serverName) || {
        serverName: failure.serverName,
        serverVersion: "",
        protocolVersion: "",
        toolCallCount: 0,
        errorCount: 0,
        totalOutputSize: 0,
        maxOutputSize: 0,
      };
      const alreadyAggregatedFailure = reportedServers.has(failure.serverName)
        && positiveCount(server.errorCount) > 0;
      if (!alreadyAggregatedFailure) server.errorCount += 1;
      servers.set(failure.serverName, server);
    }
    return [...servers.values()].map((server) => ({
      ...base,
      "mcp-server-observation": `${run.repository}:${run.runId}:${server.serverName}`,
      "mcp-server": server.serverName || "unknown",
      "mcp-server-version": server.serverVersion || "unknown",
      "mcp-protocol-version": server.protocolVersion || "unknown",
      "mcp-status": server.errorCount > 0 ? "failure" : "success",
      "tool-calls": positiveCount(server.toolCallCount),
      "failed-calls": positiveCount(server.errorCount),
      "total-response-bytes": positiveCount(server.totalOutputSize),
      "max-response-bytes": positiveCount(server.maxOutputSize),
    }));
  });
}

function recordLink(record, relation) {
  const expectedKind = relation === "issue" ? "issue" : "pull-request";
  return record.kind === expectedKind ? link(relation, record.url, `View ${relation.replaceAll("-", " ")}`) : undefined;
}

function recordWorkflowRoleResolver(workflows) {
  const roleByRuntimeWorkflow = new Map(workflows.map((row) => [
    `${row.organization}/${row.repository}:${row.workflow}`.toLowerCase(),
    row["workflow-role"],
  ]));
  return (record) => {
    const workflow = record.workflowPath?.replace(/\.lock\.yml$/, ".md") || "";
    const scoped = `${record.runtimeRepository || ""}:${workflow}`.toLowerCase();
    return roleByRuntimeWorkflow.get(scoped) || "unknown";
  };
}

function findingRows(records, workflowRoleFor = () => "unknown") {
  return records.map((record) => ({
    ...repositoryParts(record.repository),
    workflow: record.workflowPath?.replace(/\.lock\.yml$/, ".md") || record.workflow || "",
    "workflow-role": workflowRoleFor(record),
    run: String(record.runUrl?.match(/\/runs\/(\d+)/)?.[1] || ""),
    "safe-output": record.id,
    finding: record.id,
    "finding-kind": record.warning ? "authored-warning" : "record",
    "finding-severity": record.warning ? "medium" : "informational",
    "finding-status": record.state === "open" ? "open" : record.state === "closed" ? "resolved" : "unknown",
    "finding-summary": record.summary || record.title,
    "observed-at": record.updatedAt || record.createdAt,
    engine: firstText(record.engine, record.agenticEngine) || "unknown",
    "engine-version": firstText(record.engineVersion, record.agenticEngineVersion) || "unknown",
    "requested-model": firstText(record.requestedModel, record.requested_model) || "unknown",
    "resolved-model": firstText(record.resolvedModel, record.resolved_model, record.requestedModel, record.requested_model) || "unknown",
    "issue-link": recordLink(record, "issue"),
    "pull-request-link": recordLink(record, "pull-request"),
    "run-link": link("run", record.runUrl, "View workflow run"),
    "external-link": {
      ...link("external", record.url, "View output"),
      "dashboard-href": `#page-outcome-detail?outcome=${encodeURIComponent(record.id)}`,
      "dashboard-label": `View ${record.title || record.id}`,
    },
  }));
}

function outcomeRows(records, workflowRoleFor = () => "unknown") {
  return records.map((record) => ({
    ...repositoryParts(record.repository),
    "runtime-repository": record.runtimeRepository || record.repository,
    ...(record.bundle ? { package: record.bundle } : {}),
    workflow: record.workflowPath?.replace(/\.lock\.yml$/, ".md") || record.workflow || "",
    "workflow-role": workflowRoleFor(record),
    "workflow-name": record.workflow || record.workflowPath?.replace(/\.lock\.yml$/, ".md") || "Unknown workflow",
    run: String(record.runUrl?.match(/\/runs\/(\d+)/)?.[1] || ""),
    "safe-output": record.id,
    "outcome-number": record.number,
    "outcome-title": record.title || record.id,
    "outcome-summary": record.summary || "",
    "outcome-body-html": record.bodyHtml || "",
    "outcome-category": record.kind || "unknown",
    "outcome-status": record.state || "unknown",
    "outcome-state": record.state === "closed"
      ? "lifecycle-close"
      : record.kind === "noop" ? "ignored" : "pending",
    "evidence-strength": record.kind === "review-bundle" ? "proposal" : "durable",
    "outcome-warning": record.warning ? "Warning" : "None",
    "run-conclusion": runConclusion(record.conclusion),
    "rollout-mode": rolloutMode(record.mode),
    engine: firstText(record.engine, record.agenticEngine) || "unknown",
    "engine-version": firstText(record.engineVersion, record.agenticEngineVersion) || "unknown",
    "requested-model": firstText(record.requestedModel, record.requested_model) || "unknown",
    "resolved-model": firstText(record.resolvedModel, record.resolved_model, record.requestedModel, record.requested_model) || "unknown",
    "published-at": record.createdAt,
    "observed-at": record.updatedAt || record.createdAt,
    "issue-link": recordLink(record, "issue"),
    "pull-request-link": recordLink(record, "pull-request"),
    "run-link": link("run", record.runUrl, "View workflow run"),
    "external-link": link("external", record.url, "View output"),
  }));
}

function workItemKey(organization, repository, workflow) {
  return `${organization}/${repository}:${workflow}`.toLowerCase();
}

function workItemLifecycle(latestRun) {
  if (!latestRun) return "unknown";
  if (latestRun["admission-status"] === "denied" || latestRun["admission-status"] === "blocked") return "blocked";
  if (["failure", "timed-out", "startup-failure", "action-required"].includes(latestRun["run-conclusion"])) return "blocked";
  if (latestRun["run-status"] === "queued") return "waiting";
  if (latestRun["run-status"] === "in-progress") return "active";
  if (["success", "cancelled", "skipped", "neutral", "stale"].includes(latestRun["run-conclusion"])) return "completed";
  return "unknown";
}

function workItemNextAction(lifecycleState) {
  return {
    blocked: "Resolve the admission or run failure blocking this work",
    waiting: "Await the next scheduled run",
    active: "Monitor the in-progress run",
    completed: "Review the produced outcome",
  }[lifecycleState] || "Investigate missing run telemetry";
}

function workItemNextActor(lifecycleState) {
  return {
    blocked: "maintainer",
    waiting: "scheduler",
    active: "agent",
    completed: "reviewer",
  }[lifecycleState] || "unknown";
}

function workItemConsequenceTier(workflowRole) {
  if (workflowRole === "orchestrator") return "high";
  if (workflowRole === "worker") return "medium";
  return "low";
}

function outcomeVerificationState(outcomeState) {
  if (outcomeState === "accepted" || outcomeState === "lifecycle-close") return "accepted";
  if (outcomeState === "rejected") return "rejected";
  return "pending";
}

function latestByWorkItemKey(rows, keyFor, sortField) {
  const grouped = new Map();
  for (const row of rows) {
    const key = keyFor(row);
    if (!key) continue;
    const list = grouped.get(key) || [];
    list.push(row);
    grouped.set(key, list);
  }
  for (const list of grouped.values()) {
    list.sort((a, b) => Date.parse(b[sortField] || 0) - Date.parse(a[sortField] || 0));
  }
  return grouped;
}

function workItemRows(workflows, runs, outcomes) {
  const runsByWorkItem = latestByWorkItemKey(
    runs,
    (run) => workItemKey(run.organization, run.repository, run.workflow),
    "started-at",
  );
  const outcomesByWorkItem = latestByWorkItemKey(
    outcomes,
    (outcome) => workItemKey(
      ...((outcome["runtime-repository"] || `${outcome.organization}/${outcome.repository}`).split("/")),
      outcome.workflow,
    ),
    "observed-at",
  );
  return workflows.map((workflow) => {
    const key = workItemKey(workflow.organization, workflow.repository, workflow.workflow);
    const latestRun = runsByWorkItem.get(key)?.[0];
    const latestOutcome = outcomesByWorkItem.get(key)?.[0];
    const lifecycleState = workItemLifecycle(latestRun);
    return {
      "work-item-id": key,
      objective: workflow["workflow-name"] || workflow.workflow,
      organization: workflow.organization,
      repository: workflow.repository,
      scope: `${workflow.organization}/${workflow.repository}`,
      domain: workflow["package-name"] || "standalone",
      "work-type": workflow["workflow-role"] || "unknown",
      "lifecycle-state": lifecycleState,
      phase: latestRun?.["run-status"] || "unknown",
      reason: latestRun?.["admission-reason"] || latestRun?.["failure-message"] || "No blocking condition observed",
      "reason-evidence-class": latestRun ? "observed" : "inferred",
      "next-action": workItemNextAction(lifecycleState),
      "next-actor": workItemNextActor(lifecycleState),
      "waiting-on": lifecycleState === "waiting" || lifecycleState === "blocked"
        ? (latestRun?.resource || "scheduled run")
        : "",
      "waiting-since": latestRun?.["resource-reset-at"] || latestRun?.["started-at"] || "",
      owner: workflow["package-name"] || workflow.organization,
      "consequence-tier": workItemConsequenceTier(workflow["workflow-role"]),
      "verification-state": outcomeVerificationState(latestOutcome?.["outcome-state"]),
      "outcome-state": latestOutcome?.["outcome-state"] || "pending",
      "observed-at": latestRun?.["started-at"] || workflow["observed-at"],
      "evidence-link": latestOutcome?.["external-link"] || latestRun?.["run-link"],
      "run-link": latestRun?.["run-link"],
    };
  });
}

function attentionSignalRows(workItems, generatedAt) {
  const now = Date.parse(generatedAt) || Date.now();
  return workItems
    .filter((item) => item["lifecycle-state"] === "blocked" || item["lifecycle-state"] === "waiting")
    .map((item) => {
      const since = Date.parse(item["waiting-since"]);
      const ageSeconds = Number.isFinite(since) ? Math.max(0, Math.round((now - since) / 1000)) : 0;
      return {
        "attention-signal-id": `${item["work-item-id"]}:${item["lifecycle-state"]}`,
        "signal-type": item["lifecycle-state"],
        "work-item-id": item["work-item-id"],
        objective: item.objective,
        scope: item.scope,
        reason: item.reason,
        action: item["next-action"],
        "expected-actor": item["next-actor"],
        "age-seconds": ageSeconds,
        "consequence-tier": item["consequence-tier"],
        priority: item["lifecycle-state"] === "blocked" ? (item["consequence-tier"] === "high" ? 0 : 1) : 2,
        "observed-at": item["observed-at"],
        "evidence-link": item["evidence-link"],
        "repository-link": link("repository", `https://github.com/${item.organization}/${item.repository}`, `View ${item.organization}/${item.repository} on GitHub`),
        "run-link": item["run-link"],
      };
    })
    .sort((a, b) => a.priority - b.priority || b["age-seconds"] - a["age-seconds"]);
}

function agentAssignmentRows(workflows, runs, workItems) {
  const runsByWorkItem = latestByWorkItemKey(
    runs,
    (run) => workItemKey(run.organization, run.repository, run.workflow),
    "started-at",
  );
  const workItemsByKey = new Map(workItems.map((item) => [item["work-item-id"], item]));
  const assignmentStateFor = {
    active: "active",
    waiting: "pending",
    blocked: "blocked",
    completed: "completed",
    unknown: "unknown",
  };
  const rows = [];
  const activeCountByWorkItem = new Map();
  for (const workflow of workflows) {
    const key = workItemKey(workflow.organization, workflow.repository, workflow.workflow);
    const latestRun = runsByWorkItem.get(key)?.[0];
    const engine = latestRun?.engine && latestRun.engine !== "unknown" ? latestRun.engine : null;
    const model = latestRun?.["resolved-model"] && latestRun["resolved-model"] !== "unknown"
      ? latestRun["resolved-model"]
      : latestRun?.["requested-model"] && latestRun["requested-model"] !== "unknown"
        ? latestRun["requested-model"]
        : null;
    if (!engine && !model) continue;
    const workItem = workItemsByKey.get(key);
    const lifecycleState = workItem?.["lifecycle-state"] || "unknown";
    const assignmentState = assignmentStateFor[lifecycleState] || "unknown";
    if (assignmentState === "active" || assignmentState === "pending") {
      activeCountByWorkItem.set(key, (activeCountByWorkItem.get(key) || 0) + 1);
    }
    rows.push({
      key,
      row: {
        "assignment-id": `${key}:${engine || "unknown-engine"}:${model || "unknown-model"}`,
        "agent-id": `${engine || "unknown-engine"}:${model || "unknown-model"}`,
        "agent-name": [engine, model].filter(Boolean).join(" · ") || "Unknown agent",
        "agent-state": assignmentState,
        "work-item-id": workItem?.["work-item-id"] || key,
        objective: workItem?.objective || workflow["workflow-name"] || workflow.workflow,
        "assignment-state": assignmentState,
        "handoff-state": lifecycleState === "completed" ? "completed" : lifecycleState === "waiting" ? "pending" : "in-progress",
        "dependency-state": workItem?.["waiting-on"] ? "waiting" : "resolved",
        "conflict-state": "none",
        "observed-at": latestRun?.["started-at"] || workItem?.["observed-at"],
        "evidence-link": workItem?.["evidence-link"],
        "repository-link": link("repository", `https://github.com/${workflow.organization}/${workflow.repository}`, `View ${workflow.organization}/${workflow.repository} on GitHub`),
        "run-link": latestRun?.["run-link"],
      },
    });
  }
  return rows.map(({ key, row }) => ({
    ...row,
    "conflict-state": (activeCountByWorkItem.get(key) || 0) > 1 ? "contended" : "none",
  }));
}

function evidenceRecordRows(outcomes, findings, workItems) {
  const workItemsByKey = new Map(workItems.map((item) => [item["work-item-id"], item]));
  const resolveWorkItem = (organization, repository, workflow) => workItemsByKey.get(workItemKey(organization, repository, workflow));
  const outcomeRecords = outcomes.map((outcome) => {
    const [organization, repository] = (outcome["runtime-repository"] || `${outcome.organization}/${outcome.repository}`).split("/");
    const workItem = resolveWorkItem(organization, repository, outcome.workflow);
    return {
      "evidence-id": outcome["safe-output"],
      "evidence-class": "outcome",
      "evidence-kind": outcome["outcome-category"] || "unknown",
      "work-item-id": workItem?.["work-item-id"] || workItemKey(organization, repository, outcome.workflow),
      objective: workItem?.objective || outcome["workflow-name"] || "Unknown objective",
      claim: outcome["outcome-title"] || outcome["outcome-summary"] || "",
      "verification-state": outcomeVerificationState(outcome["outcome-state"]),
      "provenance-state": outcome["evidence-strength"] === "durable" ? "durable" : "proposal",
      "source-revision": outcome.run || "",
      "observed-at": outcome["observed-at"],
      "evidence-link": outcome["external-link"],
      "repository-link": link("repository", `https://github.com/${organization}/${repository}`, `View ${organization}/${repository} on GitHub`),
      "run-link": outcome["run-link"],
    };
  });
  const findingRecords = findings.map((finding) => {
    const organization = finding.organization;
    const repository = finding.repository;
    const workItem = resolveWorkItem(organization, repository, finding.workflow);
    return {
      "evidence-id": finding.finding,
      "evidence-class": "finding",
      "evidence-kind": finding["finding-kind"] || "unknown",
      "work-item-id": workItem?.["work-item-id"] || workItemKey(organization, repository, finding.workflow),
      objective: workItem?.objective || "Unknown objective",
      claim: finding["finding-summary"] || "",
      "verification-state": finding["finding-status"] === "resolved" ? "accepted"
        : finding["finding-status"] === "dismissed" ? "rejected" : "pending",
      "provenance-state": "durable",
      "source-revision": finding.run || "",
      "observed-at": finding["observed-at"],
      "evidence-link": finding["external-link"],
      "repository-link": link("repository", `https://github.com/${organization}/${repository}`, `View ${organization}/${repository} on GitHub`),
      "run-link": finding["run-link"],
    };
  });
  return [...outcomeRecords, ...findingRecords];
}

function operationalValueRows(values) {
  const definitions = new Map((values.definitions || []).map((definition) => [
    `${definition.repository}:${definition.workflowId}:${definition.evaluatorDigest || ""}`,
    definition,
  ]));
  return (values.records || []).filter((record) => record.observation).map((record) => {
    const target = record.observation.case?.targetRepo || record.observation.subject?.repository || record.repository;
    const repository = repositoryParts(target);
    const runAttempt = Number(record.runAttempt || record.run?.attempt || 1);
    const observationId = record.observationId || ([
      record.repository,
      record.workflowId,
      record.runId,
      runAttempt,
      record.evaluatorDigest,
    ].every((part) => part !== undefined && part !== null && String(part) !== "")
      ? `${record.repository}:${record.workflowId}:${record.runId}:${runAttempt}:${record.evaluatorDigest}`
      : undefined);
    const definition = definitions.get(`${record.repository}:${record.workflowId}:${record.evaluatorDigest || ""}`);
    return {
      ...repository,
      "repository-name": repository.repository,
      workflow: record.workflowPath?.replace(/\.lock\.yml$/, ".md") || record.workflowId || "",
      run: String(record.runId),
      "run-attempt": runAttempt,
      "observation-id": observationId,
      experiment: record.observation.experiment || "",
      "operational-case": record.observation.opportunityKey || record.workflowId || "unknown",
      "evaluator-digest": record.evaluatorDigest || "",
      "rollout-mode": "unknown",
      "operational-value": record.value,
      "operational-value-definition": record.workflowId || "operational-value",
      "requested-evidence-at": record.observation.subject?.createdAt || record.observation.evidenceAt,
      "evidence-cutoff": record.observation.evidenceCutoff || record.observation.evidenceAt,
      "maturity-at": record.observation.maturesAt || record.observation.evidenceAt,
      "maturity-status": record.observation.mature ? "matured" : "interim",
      "baseline-value": record.baselineValue,
      "delta-from-baseline": record.deltaFromBaseline,
      "observed-at": record.observation.evidenceAt,
      "accepted-evidence-provenance": record.observation.provenance || [],
      diagnostics: record.diagnostics || {},
      "diagnostic-definitions": definition?.diagnosticMetrics || [],
      "evidence-link": link("evidence", record.runUrl, `View run ${record.runId}`),
      "run-link": link("run", record.runUrl, `Run ${record.runId}`),
    };
  });
}

function operationalValueSource(name, rows, values, generatedAt, available) {
  const complete = values.complete === true;
  const retrievedAt = values.generatedAt || generatedAt;
  const result = source(name, rows, retrievedAt, available, complete);
  const coverageStart = values.window?.startAt || values.windowStart;
  const coverageEnd = values.window?.endAt;
  result.metadata["as-of"] = coverageEnd || retrievedAt;
  if (coverageStart) result.metadata["coverage-start"] = coverageStart;
  if (coverageEnd) result.metadata["coverage-end"] = coverageEnd;
  return result;
}

function operationalValueGraderRows(values) {
  return (values.records || []).map((record) => {
    const target = record.observation?.case?.targetRepo
      || record.observation?.subject?.repository
      || record.repository;
    return {
      ...repositoryParts(target),
      workflow: record.workflowPath?.replace(/\.lock\.yml$/, ".md") || record.workflowId || "",
      run: record.runId == null ? "Unavailable" : String(record.runId),
      grader: record.workflowId || "Unknown workflow",
      status: record.status || "unavailable",
      value: record.value,
      "maturity-status": !record.observation
        ? "unavailable"
        : record.observation.mature ? "matured" : "interim",
      "baseline-value": record.baselineValue,
      "delta-from-baseline": record.deltaFromBaseline,
      "evaluator-digest": record.evaluatorDigest || "",
      "observed-at": record.observation?.evidenceAt || record.run?.createdAt,
      "run-link": link(
        "run",
        record.runUrl || workflowRunUrl(record.repository, record.runId),
        `Run ${record.runId}`,
      ),
    };
  });
}

function configurationData(controlSettings) {
  const document = controlSettings.policy_document;
  const resolution = controlSettings.policy_resolution ?? {};
  const diagnostics = [];
  const actions = [];
  if (resolution.status !== "available") {
    diagnostics.push({
      severity: "error",
      path: ".github/workflows/cao.json",
      title: "Policy validation failed",
      detail: resolution.reason || "The control policy could not be resolved.",
    });
  } else {
    diagnostics.push({
      severity: "valid",
      path: ".github/workflows/cao.json",
      title: "Policy is valid",
      detail: "The runtime policy resolver accepted this revision.",
    });
  }

  const control = document?.["control-plane"];
  if (control && typeof control === "object" && !Array.isArray(control)) {
    const scope = control.scope;
    if (!Array.isArray(scope?.["allowed-repositories"])) {
      diagnostics.push({
        severity: "warning",
        path: "control-plane.scope.allowed-repositories",
        title: "Repository scope is owner-wide",
        detail: "Without an explicit repository allowlist, every repository under an allowed owner may be discovered.",
      });
    }
    const packages = control.packages && typeof control.packages === "object" ? control.packages : {};
    if (Object.keys(packages).length === 0) {
      diagnostics.push({
        severity: "warning",
        path: "control-plane.packages",
        title: "No packages are configured",
        detail: "Operations remain inactive until a package and its workers are declared.",
      });
    }
    const defaultMode = control.defaults?.mode ?? "review";
    for (const [packageName, policy] of Object.entries(packages)) {
      if (!policy || typeof policy !== "object" || Array.isArray(policy) || policy.enabled === false) continue;
      const mode = policy.mode ?? defaultMode;
      if (mode === "review") {
        const path = `control-plane.packages.${packageName}.mode`;
        diagnostics.push({
          severity: "guidance",
          path,
          title: `${packageName} is review-only`,
          detail: "Review mode produces proposals in the control repository and cannot mutate targets.",
        });
        actions.push({
          action: `Promote ${packageName} to live`,
          path,
          current: "review",
          recommended: "live",
          prompt: `Update .github/workflows/cao.json so ${path} is "live". Preserve all existing scope and rollout limits, verify target-owned authority for ${packageName}, and validate the policy before committing.`,
        });
      }
      if (mode === "live") {
        diagnostics.push({
          severity: "guidance",
          path: `control-plane.packages.${packageName}`,
          title: `${packageName} live mode requires target authority`,
          detail: "Each live target must authorize this control repository on its protected default branch.",
        });
      }
      for (const [workerName, worker] of Object.entries(policy.workers ?? {})) {
        if (worker?.enabled !== false) continue;
        const path = `control-plane.packages.${packageName}.workers.${workerName}.enabled`;
        actions.push({
          action: `Enable ${workerName}`,
          path,
          current: "false",
          recommended: "true",
          prompt: `Update .github/workflows/cao.json so ${path} is true. Preserve the worker workflow slug and all package limits, then validate the policy before committing.`,
        });
      }
    }
  }

  if (!document || typeof document !== "object" || Array.isArray(document)) {
    diagnostics.push({
      severity: "warning",
      path: ".github/workflows/cao.json",
      title: "Structured policy unavailable",
      detail: "Fix the JSON syntax or restore the policy file to inspect individual entries.",
    });
  }

  const summary = Object.entries(
    diagnostics.reduce((counts, item) => {
      const label = item.severity === "error"
        ? "Errors"
        : item.severity === "warning"
          ? "Warnings"
          : item.severity === "guidance"
            ? "Guidance"
            : item.severity === "valid" ? "Valid" : "Other";
      counts[label] = (counts[label] ?? 0) + 1;
      return counts;
    }, {}),
  ).map(([status, count]) => ({ status, count }));

  return {
    summary,
    policy: [{
      path: ".github/workflows/cao.json",
      document,
      raw: controlSettings.policy_source || "",
      diagnostics,
    }],
    actions,
  };
}

export function buildDashboardLanguageSources({ deployed, usage, operationalValues, report, inventory = {}, controlSettings = {}, githubTelemetry = [] }) {
  const generatedAt = report.generatedAt || deployed.generatedAt || new Date().toISOString();
  const workflows = workflowRows(deployed, generatedAt, inventory, controlSettings);
  const runs = runRows(deployed, usage);
  const admission = admissionRows(deployed);
  const performance = performanceRows(deployed, usage);
  const detectionObservations = detectionObservationRows(usage, performance.jobs);
  const safeOutputPerformance = safeOutputPerformanceRows(usage);
  const records = report.records || [];
  const workflowRoleForRecord = recordWorkflowRoleResolver(workflows);
  const findings = findingRows(records, workflowRoleForRecord);
  const outcomes = outcomeRows(records, workflowRoleForRecord);
  const reportAvailable = Array.isArray(report.records) && (report.error ? report.records.length > 0 : true);
  const reportComplete = !report.error;
  const runComplete = deployed.runHealth?.complete === true;
  const workItemsAvailable = workflows.length > 0;
  const workItemsComplete = workItemsAvailable && runComplete;
  const workItems = workItemRows(workflows, runs, outcomes);
  const attentionSignals = attentionSignalRows(workItems, generatedAt);
  const agentAssignments = agentAssignmentRows(workflows, runs, workItems);
  const evidenceAvailable = workItemsAvailable || outcomes.length > 0 || findings.length > 0;
  const evidenceRecords = evidenceRecordRows(outcomes, findings, workItems);
  const values = operationalValueRows(operationalValues);
  const experiments = experimentTelemetryRows(usage);
  const graders = graderTelemetryRows(usage);
  const evals = evalTelemetryRows(usage);
  const graderObservations = [
    ...operationalValueGraderRows(operationalValues),
    ...graders.observations,
  ];
  const repositories = new Map();
  for (const row of [...workflows, ...runs, ...findings, ...values]) {
    if (!row.organization || !row.repository) continue;
    repositories.set(`${row.organization}/${row.repository}`, {
      organization: row.organization,
      repository: row.repository,
      "repository-name": row.repository,
      "rollout-mode": row["rollout-mode"] || "unknown",
      "observed-at": row["observed-at"] || generatedAt,
    });
  }
  const organizations = [...new Set([...repositories.values()].map((row) => row.organization))].map((organization) => ({
    organization,
    "organization-name": organization,
    "observed-at": generatedAt,
  }));
  const discoveryAvailable = deployed.discovery?.complete !== false;
  const workflowsAvailable = discoveryAvailable || workflows.length > 0;
  const runAvailable = deployed.runHealth?.available === true || runs.length > 0;
  const usageAvailable = usage.available === true;
  const usageComplete = usage.complete === true;
  const valueAvailable = operationalValues.records !== undefined;
  const configuration = configurationData(controlSettings);

  const sources = Object.fromEntries(sourceNames.map((name) => [name, source(name, [], generatedAt, false, false)]));
  sources.organizations = source("organizations", organizations, generatedAt, discoveryAvailable, deployed.discovery?.complete === true);
  sources.repositories = source("repositories", [...repositories.values()], generatedAt, discoveryAvailable, deployed.discovery?.complete === true);
  sources.workflows = source("workflows", workflows, generatedAt, workflowsAvailable, deployed.discovery?.complete === true);
  sources.runs = source("runs", runs, generatedAt, runAvailable, runComplete);
  const admissionExpected = (deployed.workflows || [])
    .filter((workflow) => workflow.role === "orchestrator" || workflow.role === "worker")
    .flatMap((workflow) => workflow.runHealth?.runRecords || []);
  const admissionAvailable = deployed.runHealth?.admissionEvidence?.available !== false;
  const admissionComplete = runComplete
    && deployed.runHealth?.admissionEvidence?.complete !== false
    && admissionExpected.every((run) => Boolean(run.admission));
  sources.admissions = source(
    "admissions",
    admission.admissions,
    generatedAt,
    admissionAvailable,
    admissionComplete,
  );
  sources["admission-checks"] = source(
    "admission-checks",
    admission.checks,
    generatedAt,
    admissionAvailable,
    admissionComplete,
  );
  sources["run-performance"] = source(
    "run-performance",
    performance.runs,
    generatedAt,
    runAvailable,
    runComplete && usageComplete,
  );
  sources["job-performance"] = source(
    "job-performance",
    performance.jobs,
    generatedAt,
    runAvailable,
    runComplete && usageComplete,
  );
  sources["safe-output-performance"] = source(
    "safe-output-performance",
    safeOutputPerformance,
    generatedAt,
    usageAvailable && usage.securityAvailable === true,
    usageComplete && usage.securityComplete === true,
  );
  if (Number.isFinite(deployed.runHealth?.windowHours) && deployed.runHealth.windowHours > 0) {
    sources.runs.metadata["coverage-end"] = generatedAt;
    sources.runs.metadata["coverage-start"] = new Date(
      Date.parse(generatedAt) - deployed.runHealth.windowHours * 3_600_000,
    ).toISOString();
    for (const name of ["admissions", "admission-checks", "run-performance", "job-performance"]) {
      sources[name].metadata["coverage-end"] = generatedAt;
      sources[name].metadata["coverage-start"] = sources.runs.metadata["coverage-start"];
    }
  }
  sources.usage = source("usage", usageRows(usage), generatedAt, usageAvailable, usageComplete);
  sources.experiments = source(
    "experiments",
    experiments.definitions,
    generatedAt,
    usageAvailable,
    usageComplete,
  );
  sources["experiment-assignments"] = source(
    "experiment-assignments",
    experiments.assignments,
    generatedAt,
    usageAvailable,
    usageComplete,
  );
  sources.graders = source("graders", graders.definitions, generatedAt, usageAvailable, usageComplete);
  sources.evals = source("evals", evals.definitions, generatedAt, usageAvailable, usageComplete);
  sources["eval-observations"] = source(
    "eval-observations",
    evals.observations,
    generatedAt,
    usageAvailable,
    usageComplete,
  );
  sources["mcp-calls"] = source(
    "mcp-calls",
    mcpCallRows(usage),
    generatedAt,
    usage.mcpAvailable === true,
    usage.mcpComplete === true,
  );
  sources["mcp-servers"] = source(
    "mcp-servers",
    mcpServerRows(usage),
    generatedAt,
    usage.mcpAvailable === true,
    usage.mcpComplete === true,
  );
  sources["security-observations"] = source(
    "security-observations",
    securityObservationRows(usage),
    generatedAt,
    usage.securityAvailable === true,
    usage.securityComplete === true,
  );
  sources["detection-observations"] = source(
    "detection-observations",
    detectionObservations,
    generatedAt,
    usage.securityAvailable === true || detectionObservations.length > 0,
    usage.securityAvailable === true && usage.securityComplete === true && runComplete,
  );
  const firewallObservations = firewallObservationRows(usage);
  const firewallRuns = usage.securityRuns || [];
  const firewallComplete = firewallRuns.length > 0 && firewallRuns.every((run) => (
    ["complete"].includes(run.security?.firewall?.firewallEvidenceCompleteness)
  ));
  sources["firewall-observations"] = source(
    "firewall-observations",
    firewallObservations,
    generatedAt,
    firewallRuns.length > 0,
    firewallComplete,
    firewallRuns.some((run) => run.security?.firewall?.firewallEvidenceFreshness === "stale") ? "stale"
      : firewallRuns.some((run) => run.security?.firewall?.firewallEvidenceFreshness === "fresh") ? "fresh" : "unknown",
    usage.firewallEvidenceHorizonEnd || generatedAt,
  );
  sources["firewall-policy-rules"] = source(
    "firewall-policy-rules",
    firewallPolicyRuleRows(usage),
    generatedAt,
    firewallRuns.some((run) => run.security?.firewall?.policyManifest),
    firewallRuns.length > 0 && firewallRuns.every((run) => (
      run.security?.firewall?.firewallEnabled === false || Boolean(run.security?.firewall?.policyManifest)
    )),
  );
  for (const name of ["firewall-observations", "firewall-policy-rules"]) {
    if (usage.firewallEvidenceHorizonStart) sources[name].metadata["coverage-start"] = usage.firewallEvidenceHorizonStart;
    if (usage.firewallEvidenceHorizonEnd) sources[name].metadata["coverage-end"] = usage.firewallEvidenceHorizonEnd;
  }
  if (Number.isFinite(usage.windowHours) && usage.windowHours > 0) {
    sources.usage.metadata["coverage-end"] = generatedAt;
    sources.usage.metadata["coverage-start"] = new Date(
      Date.parse(generatedAt) - usage.windowHours * 3_600_000,
    ).toISOString();
    // Usage and security telemetry come from the same gh aw logs collection window.
    sources["safe-output-performance"].metadata["coverage-end"] = generatedAt;
    sources["safe-output-performance"].metadata["coverage-start"] = sources.usage.metadata["coverage-start"];
    sources["security-observations"].metadata["coverage-end"] = generatedAt;
    sources["security-observations"].metadata["coverage-start"] = sources.usage.metadata["coverage-start"];
    sources["detection-observations"].metadata["coverage-end"] = generatedAt;
    sources["detection-observations"].metadata["coverage-start"] = sources.usage.metadata["coverage-start"];
  }
  sources["coverage-diagnostics"] = source(
    "coverage-diagnostics",
    coverageDiagnosticRows(deployed, usage, controlSettings, report),
    generatedAt,
  );
  sources["configuration-summary"] = source("configuration-summary", configuration.summary, generatedAt);
  sources["configuration-policy"] = source("configuration-policy", configuration.policy, generatedAt);
  sources["configuration-actions"] = source("configuration-actions", configuration.actions, generatedAt);
  sources["repository-coverage"] = source(
    "repository-coverage",
    repositoryCoverageRows(deployed),
    generatedAt,
    discoveryAvailable,
    deployed.discovery?.complete === true,
  );
  sources.outcomes = source("outcomes", outcomes, generatedAt, reportAvailable, reportComplete);
  sources.findings = source("findings", findings, generatedAt, reportAvailable, reportComplete);
  if (report.stale) {
    sources.outcomes.metadata.freshness = "stale";
    sources.findings.metadata.freshness = "stale";
  }
  sources["work-items"] = source("work-items", workItems, generatedAt, workItemsAvailable, workItemsComplete);
  sources["attention-signals"] = source("attention-signals", attentionSignals, generatedAt, workItemsAvailable, workItemsComplete);
  sources["agent-assignments"] = source("agent-assignments", agentAssignments, generatedAt, workItemsAvailable, workItemsComplete && usageComplete);
  sources["evidence-records"] = source(
    "evidence-records",
    evidenceRecords,
    generatedAt,
    evidenceAvailable,
    evidenceAvailable && workItemsComplete && reportComplete,
  );
  sources["grader-observations"] = source(
    "grader-observations",
    graderObservations,
    generatedAt,
    valueAvailable || usageAvailable,
    operationalValues.complete === true && usageComplete,
  );
  sources["operational-values"] = operationalValueSource("operational-values", values, operationalValues, generatedAt, valueAvailable);
  const githubAsOf = telemetryAsOf(githubTelemetry, generatedAt);
  const githubFreshness = telemetryFreshness(githubTelemetry, generatedAt);
  const githubRateLimitRows = githubTelemetryRows(githubTelemetry, generatedAt);
  const githubComplete = githubTelemetry.length > 0 && githubTelemetry.every((entry) => !rateLimitDiagnostic(entry));
  sources["github-api-rate-limits"] = source(
    "github-api-rate-limits",
    githubRateLimitRows,
    generatedAt,
    githubRateLimitRows.length > 0,
    githubComplete,
    githubFreshness,
    githubAsOf,
  );
  sources["github-api-collector-health"] = source(
    "github-api-collector-health",
    githubCollectorRows(githubTelemetry),
    generatedAt,
    githubTelemetry.length > 0,
    githubComplete,
    githubFreshness,
    githubAsOf,
  );
  sources["github-api-call-stacks"] = source(
    "github-api-call-stacks",
    githubStackTraceRows(githubTelemetry),
    generatedAt,
    githubTelemetry.length > 0,
    githubComplete,
    githubFreshness,
    githubAsOf,
  );
  return sources;
}

async function readJsonLines(filePath) {
  if (!filePath) return [];
  try {
    return (await readFile(filePath, "utf8")).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function main() {
  const deployedPath = process.env.REPORT_DEPLOYED_WORKFLOWS;
  const usagePath = process.env.REPORT_AIC_USAGE;
  const operationalValuesPath = process.env.REPORT_OPERATIONAL_VALUES;
  const reportPath = process.env.REPORT_RECORDS;
  const inventoryPath = process.env.REPORT_INVENTORY;
  const controlSettingsPath = process.env.REPORT_CONTROL_SETTINGS;
  const githubTelemetryPath = process.env.REPORT_GITHUB_TELEMETRY;
  const outputPath = process.env.REPORT_DASHBOARD_SOURCES;
  if (!deployedPath || !usagePath || !operationalValuesPath || !reportPath || !inventoryPath || !controlSettingsPath || !outputPath) {
    throw new Error("REPORT_DEPLOYED_WORKFLOWS, REPORT_AIC_USAGE, REPORT_OPERATIONAL_VALUES, REPORT_RECORDS, REPORT_INVENTORY, REPORT_CONTROL_SETTINGS, and REPORT_DASHBOARD_SOURCES are required");
  }
  log.group`Build Dashboard Language sources`;
  try {
    const [deployed, usage, operationalValues, report, inventory, controlSettings, githubTelemetry] = await Promise.all(
      [deployedPath, usagePath, operationalValuesPath, reportPath, inventoryPath, controlSettingsPath]
        .map(async (file) => JSON.parse(await readFile(file, "utf8")))
        .concat(readJsonLines(githubTelemetryPath)),
    );
    const sources = buildDashboardLanguageSources({ deployed, usage, operationalValues, report, inventory, controlSettings, githubTelemetry });
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(sources, null, 2)}\n`);
    log.info`Wrote ${Object.keys(sources).length} dashboard sources to ${outputPath}`;
  } finally {
    log.endGroup();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    log.error`${error.stack || error.message || error}`;
    process.exitCode = 1;
  });
}
