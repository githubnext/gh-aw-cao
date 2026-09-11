import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { actionsLog as log } from "./actions-log.mjs";

function rolloutMode(value) {
  return ["review", "live"].includes(value) ? value : "unknown";
}

function metadata(name, generatedAt) {
  return {
    "source-id": `central-agentic-ops-${name}`,
    "source-kind": "github",
    "as-of": generatedAt,
    "retrieved-at": generatedAt,
    completeness: "complete",
    freshness: "fresh",
    availability: "available",
  };
}

function source(name, rows, generatedAt) {
  return { source: name, rows, metadata: metadata(name, generatedAt) };
}

function packageRows(inventory, controlSettings, generatedAt) {
  const bundles = new Map((inventory.bundles || []).map((bundle) => [
    String(bundle.controlPackage || bundle.id || "").trim(),
    bundle,
  ]).filter(([id]) => id));
  const ids = new Set([...bundles.keys(), ...Object.keys(controlSettings.packages || {})]);
  return [...ids].sort().map((id) => {
    const bundle = bundles.get(id)
      || [...bundles.values()].find((candidate) => candidate.id === id)
      || {};
    const policy = controlSettings.packages?.[id] || {};
    const workers = Object.entries(policy.worker_policies || {}).map(([workflow, worker]) => ({
      id: worker.worker || workflow,
      workflow,
      enabled: worker.enabled !== false,
      "max-mode": worker.max_mode || null,
    }));
    const targets = Object.entries(policy.target_policies || {}).map(([repository, target]) => ({
      repository,
      mode: rolloutMode(target?.mode),
    }));
    const inventoryWorkers = bundle.workers || [];
    const inventoryWarnings = (bundle.compiled === true ? 0 : 1) + (bundle.missingWorkers || []).length;
    const aiCreditAllowance = [bundle.maxAiCredits, ...inventoryWorkers.map((worker) => worker.maxAiCredits)]
      .filter((value) => Number.isFinite(value) && value > 0)
      .reduce((total, value) => total + value, 0);
    return {
      package: id,
      "package-name": bundle.name || id,
      "package-description": bundle.description || "",
      "package-icon": policy.icon || "package",
      "package-mode": rolloutMode(policy.mode),
      "package-enabled": policy.enabled !== false,
      "package-max-repositories": policy["max-repositories"] ?? null,
      "package-rollout-percent": policy["rollout-percent"] ?? null,
      "package-monthly-ai-credit-budget": policy["monthly-ai-credit-budget"] ?? null,
      "package-aic-allowance": aiCreditAllowance || null,
      "package-worker-count": workers.length || inventoryWorkers.length,
      "package-inventory-warnings": inventoryWarnings,
      "package-workers": workers,
      "package-targets": targets,
      "package-min-version": bundle.minVersion || "",
      "package-experimental": bundle.experimental === true,
      "package-readme-path": bundle.readmePath || "",
      "package-readme": bundle.readme || "",
      "observed-at": generatedAt,
    };
  });
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

function workflowPackageDetails(inventory, controlSettings) {
  const details = new Map();
  for (const workflow of inventory.workflows || []) {
    details.set(workflow.sourcePath, {
      maxAiCredits: workflow.maxAiCredits,
      inventoryReady: workflow.compiled,
    });
  }
  for (const bundle of inventory.bundles || []) {
    const packageId = String(bundle.controlPackage || bundle.id || "").trim();
    const policy = controlSettings.packages?.[packageId] || {};
    const configuredMode = rolloutMode(policy.mode);
    const rolloutPercent = Number(policy["rollout-percent"] ?? policy.rollout_percent);
    const targetPolicies = new Map(Object.entries(policy.targets ?? policy.target_policies ?? {})
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
    const workers = bundle.workers || [];
    const allowance = [bundle.maxAiCredits, ...workers.map((worker) => worker.maxAiCredits)]
      .filter((value) => Number.isFinite(value) && value > 0)
      .reduce((total, value) => total + value, 0);
    const inventoryWarnings = (bundle.compiled === true ? 0 : 1) + (bundle.missingWorkers || []).length;
    const ready = bundle.compiled === true
      && (bundle.missingWorkers || []).length === 0
      && workers.every((worker) => worker.compiled !== false);
    for (const workflow of [
      { id: bundle.id, sourcePath: bundle.workflow, role: "orchestrator" },
      ...workers.map((worker) => ({ ...worker, role: "worker" })),
    ]) {
      if (!workflow.sourcePath) continue;
      const admission = workflowAdmission(controlSettings, packageId, workflow.role, workflow.id);
      details.set(workflow.sourcePath, {
        ...details.get(workflow.sourcePath),
        package: packageId,
        packageName: bundle.name || packageId,
        packageDescription: bundle.description,
        packageIcon: policy.icon || "package",
        packageReadmePath: bundle.readmePath,
        packageReadme: bundle.readme,
        role: workflow.role,
        configuredMode,
        packageTargets,
        allowance: allowance || null,
        workerCount: workers.length,
        inventoryWarnings,
        inventoryReady: ready,
        ...(Number.isFinite(rolloutPercent) ? { rolloutPercent } : {}),
        ...(admission ? { admissionStatus: admission.status, admissionReason: admission.reason } : {}),
      });
    }
  }
  return details;
}

function workflowRows(inventory, controlSettings, repository, generatedAt) {
  const [organization, repositoryName] = repository.split("/");
  const packageDetails = workflowPackageDetails(inventory, controlSettings);
  return (inventory.workflows || []).map((workflow) => {
    const details = packageDetails.get(workflow.sourcePath);
    const repositoryKey = repository.toLowerCase();
    const targets = (details?.packageTargets || [])
      .filter((target) => target.explicit || target.repository.toLowerCase() !== repositoryKey)
      .map(({ repository: targetRepository, mode }) => ({ repository: targetRepository, mode }));
    return {
      organization,
      repository: repositoryName,
      ...(details ? {
        package: details.package,
        "package-name": details.packageName,
        "package-icon": details.packageIcon,
        "package-aic-allowance": details.allowance,
        "package-worker-count": details.workerCount,
        "package-inventory-warnings": details.inventoryWarnings,
      } : {}),
      ...(Number.isFinite(details?.maxAiCredits) ? { "max-ai-credits": details.maxAiCredits } : {}),
      ...(details?.packageDescription ? { "package-description": details.packageDescription } : {}),
      ...(details?.packageReadmePath ? { "package-readme-path": details.packageReadmePath } : {}),
      ...(details?.packageReadme ? { "package-readme": details.packageReadme } : {}),
      ...(Number.isFinite(details?.rolloutPercent) ? { "package-rollout-percent": details.rolloutPercent } : {}),
      ...(targets.length > 0 ? { "package-targets": targets } : {}),
      ...(typeof details?.inventoryReady === "boolean" ? { "inventory-ready": details.inventoryReady } : {}),
      ...(details?.admissionStatus ? { "admission-status": details.admissionStatus } : {}),
      ...(details?.admissionReason ? { "admission-reason": details.admissionReason } : {}),
      workflow: workflow.sourcePath,
      "workflow-name": workflow.name,
      "workflow-role": details?.role || workflow.role || "standalone",
      "workflow-active": workflow.compiled === true ? "true" : "unknown",
      "rollout-mode": details?.packageTargets?.find(
        (target) => target.repository.toLowerCase() === repositoryKey,
      )?.mode || details?.configuredMode || "unknown",
      "observed-at": generatedAt,
    };
  });
}

export function buildInventoryDashboardSources({
  inventory = {},
  controlSettings = {},
  repository = "",
  generatedAt = inventory.generatedAt || new Date().toISOString(),
}) {
  const [organization, repositoryName] = repository.split("/");
  return {
    packages: source("packages", packageRows(inventory, controlSettings, generatedAt), generatedAt),
    repositories: source("repositories", [{
      organization,
      repository: repositoryName,
      "repository-name": repositoryName,
      "observed-at": generatedAt,
    }], generatedAt),
    workflows: source(
      "workflows",
      workflowRows(inventory, controlSettings, repository, generatedAt),
      generatedAt,
    ),
  };
}

export async function main() {
  const inventoryPath = process.env.REPORT_INVENTORY;
  const controlSettingsPath = process.env.REPORT_CONTROL_SETTINGS;
  const outputPath = process.env.REPORT_INVENTORY_SOURCES;
  const repository = process.env.GITHUB_REPOSITORY;
  if (!inventoryPath || !controlSettingsPath || !outputPath || !repository) {
    throw new Error("REPORT_INVENTORY, REPORT_CONTROL_SETTINGS, REPORT_INVENTORY_SOURCES, and GITHUB_REPOSITORY are required");
  }

  log.group`Build dashboard inventory sources`;
  try {
    const [inventory, controlSettings] = await Promise.all([
      readFile(inventoryPath, "utf8").then(JSON.parse),
      readFile(controlSettingsPath, "utf8").then(JSON.parse),
    ]);
    const sources = buildInventoryDashboardSources({ inventory, controlSettings, repository });
    await writeFile(path.resolve(outputPath), `${JSON.stringify(sources, null, 2)}\n`);
    log.info`Wrote ${sources.packages.rows.length} packages and ${sources.workflows.rows.length} workflows`;
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
