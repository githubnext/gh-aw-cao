import { mkdir, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { setActionsGlobals } from "./actions-context.mjs";
import { actionsLog as log } from "./actions-log.mjs";
import { compilerVersionFromLock } from "./version.mjs";

const PACKAGE_OWNERSHIP_DIRECTORY = ".github/aw/packages";

function unquote(value = "") {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function scalar(source, key) {
  return unquote(source.match(new RegExp(`^${key}:[ \\t]*(.+)$`, "m"))?.[1] || "");
}

function inlineList(source, key) {
  const inline = source.match(new RegExp(`^[ \\t]+${key}:[ \\t]*\\[([^\\]]*)\\]`, "m"))?.[1];
  if (inline !== undefined) return inline.split(",").map((item) => unquote(item)).filter(Boolean);
  const block = source.match(new RegExp(`^[ \\t]+${key}:[ \\t]*\\n((?:^[ \\t]+-[ \\t]+.*\\n?)*)`, "m"))?.[1] || "";
  return block.split("\n")
    .map((line) => line.match(/^\s*-\s+([^#]+)$/)?.[1]?.trim())
    .filter(Boolean)
    .map((item) => unquote(item));
}

function controlPackage(source) {
  return source.match(/uses:\s+shared\/control\.md[\s\S]*?package:\s+([a-z0-9][a-z0-9-]*)/)?.[1] || "";
}

function createIssueLabels(source) {
  const block = source.match(/^[ \t]*create-issue:[ \t]*\n((?:^[ \t]+.*\n?)*)/m)?.[1] || "";
  return inlineList(block, "labels");
}

function manifestIncludes(source) {
  const includes = [];
  const block = source.match(/^includes:\s*\n((?:^[ \t]+.*\n?)*)/m)?.[1] || "";
  for (const line of block.split("\n")) {
    const direct = line.match(/^\s*-\s+([^:][^#]*)$/)?.[1]?.trim();
    const mapped = line.match(/^\s+-\s+source:\s+(.+)$/)?.[1]?.trim();
    const value = direct || mapped;
    if (value) includes.push(unquote(value));
  }
  return includes;
}

function findFiles(directory, filename) {
  const matches = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "_site") continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) matches.push(...findFiles(entryPath, filename));
    else if (entry.name === filename) matches.push(entryPath);
  }
  return matches;
}

function relative(root, filePath) {
  return path.relative(root, filePath).split(path.sep).join("/");
}

function packageRecordId(record) {
  return String(record?.package || "").split("/").filter(Boolean).at(-1) || "";
}

function installedPackageRecords(root) {
  const directory = path.join(root, PACKAGE_OWNERSHIP_DIRECTORY);
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"))
    .flatMap((entry) => {
      try {
        const record = JSON.parse(readFileSync(path.join(directory, entry.name), "utf8"));
        const installed = {
          id: packageRecordId(record),
          package: String(record?.package || "").trim(),
          source: String(record?.source || "").trim(),
          resolvedCommit: String(record?.resolvedCommit || "").trim(),
          installer: String(record?.installer || "").trim(),
        };
        return installed.id && installed.package ? [installed] : [];
      } catch {
        return [];
      }
    });
}

function ownershipByPackageId(records) {
  const grouped = new Map();
  for (const record of records) {
    const matches = grouped.get(record.id) || [];
    matches.push(record);
    grouped.set(record.id, matches);
  }
  return new Map([...grouped].flatMap(([id, matches]) => matches.length === 1 ? [[id, matches[0]]] : []));
}

export function sourceRevision(source) {
  return scalar(source, "source").match(/@([0-9a-f]{40})$/i)?.[1] || "";
}

export function discoverInventory(root = path.resolve(process.env.REPORT_ROOT || ".")) {
  const workflowDirectory = path.join(root, ".github/workflows");
  const policyPath = path.join(workflowDirectory, "cao.json");
  const manifests = findFiles(root, "aw.yml").map((manifestPath) => {
    const source = readFileSync(manifestPath, "utf8");
    const readmePath = path.join(path.dirname(manifestPath), "README.md");
    return {
      path: relative(root, manifestPath),
      name: scalar(source, "name"),
      description: scalar(source, "description"),
      minVersion: scalar(source, "min-version"),
      experimental: scalar(source, "experimental") === "true",
      readmePath: existsSync(readmePath) ? relative(root, readmePath) : "",
      readme: existsSync(readmePath) ? readFileSync(readmePath, "utf8") : "",
      includes: manifestIncludes(source),
    };
  });
  const packageByWorkflow = new Map();
  for (const manifest of manifests.sort((left, right) => left.path.split("/").length - right.path.split("/").length)) {
    for (const include of manifest.includes) {
      if (include.startsWith(".github/workflows/") && include.endsWith(".md")) packageByWorkflow.set(include, manifest);
    }
  }

  const workflows = readdirSync(workflowDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => {
      const sourcePath = `.github/workflows/${entry.name}`;
      const lockPath = path.join(workflowDirectory, `${entry.name.slice(0, -3)}.lock.yml`);
      const source = readFileSync(path.join(workflowDirectory, entry.name), "utf8");
      const stem = entry.name.slice(0, -3);
      const role = source.match(/uses:\s+shared\/control\.md[\s\S]*?role:\s+(orchestrator|worker)/)?.[1] || "standalone";
      const maxAiCredits = Number(scalar(source, "max-ai-credits"));
      return {
        id: stem,
        name: scalar(source, "name") || stem,
        description: scalar(source, "description"),
        emoji: scalar(source, "emoji"),
        trackerId: scalar(source, "tracker-id"),
        role,
        controlPackage: role === "standalone" ? "" : controlPackage(source),
        maxAiCredits: Number.isFinite(maxAiCredits) && maxAiCredits > 0 ? maxAiCredits : null,
        sourcePath,
        source: scalar(source, "source"),
        version: sourceRevision(source),
        lockPath: `.github/workflows/${stem}.lock.yml`,
        compiled: existsSync(lockPath),
        ghAwVersion: existsSync(lockPath) ? compilerVersionFromLock(readFileSync(lockPath, "utf8")) : null,
        workers: role === "orchestrator" ? inlineList(source, "workflows") : [],
        package: packageByWorkflow.get(sourcePath) || null,
        issueLabels: createIssueLabels(source),
      };
    });
  const workflowById = new Map(workflows.map((workflow) => [workflow.id, workflow]));
  const assignedWorkers = new Set(workflows.flatMap((workflow) => workflow.workers));
  const bundles = workflows.filter((workflow) => workflow.role === "orchestrator").map((orchestrator) => ({
    id: orchestrator.id,
    name: orchestrator.package?.name || orchestrator.name,
    description: orchestrator.package?.description || orchestrator.description,
    minVersion: orchestrator.package?.minVersion || "",
    experimental: orchestrator.package?.experimental === true,
    readmePath: orchestrator.package?.readmePath || "",
    readme: orchestrator.package?.readme || "",
    workflow: orchestrator.sourcePath,
    source: orchestrator.source,
    version: orchestrator.version,
    controlPackage: orchestrator.controlPackage,
    maxAiCredits: orchestrator.maxAiCredits,
    compiled: orchestrator.compiled,
    issueLabels: orchestrator.issueLabels,
    workers: orchestrator.workers.map((workerId) => workflowById.get(workerId)).filter(Boolean),
    missingWorkers: orchestrator.workers.filter((workerId) => !workflowById.has(workerId)),
  }));
  const packageNames = new Map(bundles.map((bundle) => [bundle.controlPackage || bundle.id, bundle.name]));
  const installedById = ownershipByPackageId(installedPackageRecords(root));
  let policy = {};
  try {
    policy = JSON.parse(readFileSync(policyPath, "utf8"));
  } catch {
    policy = {};
  }
  const packages = Object.keys(policy["control-plane"]?.packages || {}).sort().map((id) => ({
    id,
    name: packageNames.get(id) || id,
    ...(installedById.get(id) || {}),
  }));
  const standalone = workflows.filter((workflow) => workflow.role === "standalone" && !assignedWorkers.has(workflow.id));
  const lockOnly = readdirSync(workflowDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".lock.yml"))
    .map((entry) => entry.name.slice(0, -9))
    .filter((stem) => !workflowById.has(stem));
  return { schemaVersion: 1, generatedAt: new Date().toISOString(), manifests, workflows, bundles, packages, standalone, lockOnly };
}

export async function main(actions = {}) {
  setActionsGlobals(actions);
  log.group`Extract control-plane inventory`;
  try {
    const outputPath = path.resolve(process.env.REPORT_INVENTORY || "_inventory/control-plane.json");
    const inventory = discoverInventory();
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, `${JSON.stringify(inventory, null, 2)}\n`);
    log.info`Discovered ${inventory.bundles.length} packages and ${inventory.standalone.length} standalone workflows in ${outputPath}`;
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
