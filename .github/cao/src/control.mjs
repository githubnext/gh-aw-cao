#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  PolicyError,
  controlSettings,
  effectivePolicy,
  parsePolicy,
} from "./policy.mjs";

const AGENT_DIRECTORY = "/tmp/gh-aw/agent";
const OUTPUT_PATH = join(AGENT_DIRECTORY, "control-precompute.json");
const POLICY_PATH = ".github/workflows/cao.json";
const REPOSITORY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/;
const SHA_PATTERN = /^[0-9a-fA-F]{40,64}$/;
const MINIMUM_GITHUB_API_REQUESTS = 100;
const ORCHESTRATOR_FREE_DISK_MEGABYTES = 2048;
const WORKER_FREE_DISK_MEGABYTES = 6144;
const GITHUB_RUNNER_SPECIFICATION_DOCS = "https://docs.github.com/en/actions/using-github-hosted-runners/using-github-hosted-runners/about-github-hosted-runners";
const GITHUB_API_CACHE_DURATION = "60s";
const GITHUB_RATE_LIMIT_DOCS = "https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api";
const GITHUB_REST_BEST_PRACTICES = "https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api";
const GITHUB_APP_ACTIONS_DOCS = "https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/making-authenticated-api-requests-with-a-github-app-in-a-github-actions-workflow";
const GITHUB_PAT_DOCS = "https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens";
const GITHUB_ACTIONS_SECRETS_DOCS = "https://docs.github.com/en/actions/security-for-github-actions/security-guides/using-secrets-in-github-actions";
const ADMISSION_CHECKS = [
  ["Runtime revision", "The control and policy modules are read from the exact `github.workflow_sha` commit."],
  ["Policy document", "The checked-in policy is parsed and validated for supported keys, types, ranges, unique names, and expressions."],
  ["Control plane", "The `control-plane` declaration is present."],
  ["Workflow identity", "The package, role, and (for workers) exact worker identity are authorized."],
  ["Package", "The requested package is declared and enabled."],
  ["Worker", "For worker runs, the requested worker is declared and enabled."],
  ["Target input", "Any supplied `target_repo` uses the exact `owner/repository` form."],
  ["Mode input", "Any supplied `safe_output_mode` does not exceed the checked-in mode ceiling."],
  ["Run limits", "Any supplied `max_repos` and `rollout_percent` do not exceed checked-in limits."],
  ["GitHub API capacity", "The exact credential selected for control precompute has enough primary REST API capacity before activation."],
  ["Runner disk capacity", "The runner reports enough free disk space for checkouts, tooling, and temporary files before activation."],
];

class ControlError extends Error {}

function environment(name, fallback = "") {
  return process.env[name] ?? fallback;
}

function parseInteger(value, fallback) {
  const candidate = value === "" ? fallback : value;
  if (typeof candidate !== "string") return candidate;
  const parsed = Number(candidate);
  return Number.isSafeInteger(parsed) ? parsed : candidate;
}

function log(message) {
  console.log(`[CAO] ${message}`);
}

function actionsCommand(command, message = "") {
  const escaped = message
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
  console.log(`::${command}::${escaped}`);
}

function withLogGroup(title, operation) {
  const actions = environment("GITHUB_ACTIONS") === "true";
  if (actions) actionsCommand("group", title);
  else log(title);
  try {
    return operation();
  } finally {
    if (actions) actionsCommand("endgroup");
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const message = result.stderr.trim() || result.stdout.trim() || `${command} exited with status ${result.status}`;
    throw new ControlError(message);
  }
  return result.stdout;
}

function ghApi(endpoint, { fields = {}, jq = "" } = {}) {
  const args = ["api", "--cache", GITHUB_API_CACHE_DURATION];
  if (Object.keys(fields).length > 0) args.push("--method", "GET");
  args.push(endpoint);
  for (const [key, value] of Object.entries(fields)) args.push("-f", `${key}=${value}`);
  if (jq) args.push("--jq", jq);
  return run("gh", args);
}

function decodeRepositoryFile(repository, path, sha) {
  const encoded = ghApi(`repos/${repository}/contents/${path}`, {
    fields: { ref: sha },
    jq: ".content",
  });
  return Buffer.from(encoded.replace(/\s/g, ""), "base64").toString("utf8");
}

function parseJsonOutput(source) {
  const trimmed = source.trim();
  if (!trimmed) return [];
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  }
}

function writeActionsOutputs(values) {
  const outputPath = environment("GITHUB_OUTPUT");
  if (!outputPath) return;
  const lines = Object.entries(values).map(([key, value]) => `${key}=${String(value).replace(/[\r\n]/g, " ")}`);
  writeFileSync(outputPath, `${lines.join("\n")}\n`, { flag: "a" });
}

function retryWait(resetEpochSeconds) {
  const seconds = Math.max(0, resetEpochSeconds - Math.floor(Date.now() / 1000));
  return {
    seconds,
    minutes: Math.ceil(seconds / 60),
    hours: Math.ceil(seconds / 36) / 100,
  };
}

function capacityGuidance(capacity) {
  if (!capacity || capacity.status === "available") return "";
  if (capacity.status === "unavailable") {
    return `
> [!CAUTION]
> GitHub REST API capacity could not be verified. Activation stopped before repository discovery.

### What to do now

1. Check the credential and the [REST API rate-limit guidance](${GITHUB_RATE_LIMIT_DOCS}); do not repeatedly retry a 403 or 429 response.
2. For durable cross-repository automation, configure a least-privilege GitHub App using [GitHub's Actions authentication guide](${GITHUB_APP_ACTIONS_DOCS}).
3. If an App cannot be installed and the exact scope is eligible, use a fine-grained PAT with minimal repository access, permissions, and expiration. Follow [GitHub's PAT guidance](${GITHUB_PAT_DOCS}) and store it as an [Actions secret](${GITHUB_ACTIONS_SECRETS_DOCS}) named \`GH_AW_GITHUB_TOKEN\`.

See also [GitHub REST API best practices](${GITHUB_REST_BEST_PRACTICES}).
`;
  }
  const wait = retryWait(capacity.reset);
  return `
> [!CAUTION]
> GitHub REST API capacity is too low for this run: ${capacity.remaining} of ${capacity.limit} core requests remain; at least ${capacity.required} are required.

### What to do now

1. Do not rerun before **${capacity.resetAt}**. That is approximately **${wait.minutes} minutes (${wait.hours.toFixed(2)} hours)** from this admission check. The next scheduled run after that time is a new attempt.
2. For durable cross-repository automation, configure a least-privilege GitHub App using [GitHub's Actions authentication guide](${GITHUB_APP_ACTIONS_DOCS}). GitHub documents higher, installation-scoped limits for Apps in the [REST API rate-limit guide](${GITHUB_RATE_LIMIT_DOCS}).
3. If an App cannot be installed and the exact scope is eligible, use a fine-grained PAT with minimal repository access, permissions, and expiration. Follow [GitHub's PAT guidance](${GITHUB_PAT_DOCS}) and store it as an [Actions secret](${GITHUB_ACTIONS_SECRETS_DOCS}) named \`GH_AW_GITHUB_TOKEN\`.

GitHub says not to retry primary-limit failures until \`x-ratelimit-reset\`; continuing while limited can result in integration blocking. See [GitHub REST API best practices](${GITHUB_REST_BEST_PRACTICES}).
`;
}

function diskGuidance(capacity) {
  if (!capacity || capacity.status === "available") return "";
  if (capacity.status === "unavailable") {
    return `
> [!CAUTION]
> Runner free disk space could not be determined for \`${capacity.path}\`. Activation stopped before repository discovery.

### What to do now

1. Confirm the runner exposes the workspace and temporary directories used by this job, then rerun on a healthy runner.
2. Compare the runner image against the [GitHub-hosted runner specifications](${GITHUB_RUNNER_SPECIFICATION_DOCS}); a self-hosted runner must provide at least the same free disk space.
`;
  }
  return `
> [!CAUTION]
> Runner free disk space is too low for this run: ${capacity.available} MB free on \`${capacity.path}\`; at least ${capacity.required} MB are required.

### What to do now

1. Free disk space on the runner, or move the operation to a larger runner. See the [GitHub-hosted runner specifications](${GITHUB_RUNNER_SPECIFICATION_DOCS}).
2. On a self-hosted runner, remove stale workspaces, caches, and container images left by earlier or concurrent jobs before rerunning.
3. Narrow the run so fewer repositories are checked out at once by lowering \`max_repos\` or the checked-in \`max-repositories\`.
`;
}

function failedAdmissionCheckIndex(reason) {
  if (!reason) return -1;
  if (reason.startsWith("cannot read")) return 0; // Runtime revision
  if (reason === "control policy validation failed") return 1; // Policy document
  if (reason === "control-plane-absent") return 2; // Control plane
  if (
    reason === "role must be orchestrator or worker"
    || reason === "worker identity is required"
    || reason === "worker identity is forbidden for orchestrators"
  ) return 3; // Workflow identity
  if (reason === "package-undeclared" || reason === "package-disabled") return 4; // Package
  if (reason === "worker-disabled" || reason.startsWith("unknown worker:")) return 5; // Worker
  if (reason === "target_repo must use owner/repository form") return 6; // Target input
  if (reason === "safe_output_mode exceeds checked-in policy" || reason === "safe_output_mode must be review or live") return 7; // Mode input
  if (reason.startsWith("max_repositories") || reason.startsWith("rollout_percent")) return 8; // Run limits
  if (reason === "github-api-capacity-insufficient" || reason === "github-api-capacity-unavailable") return 9; // GitHub API capacity
  if (reason === "runner-disk-capacity-insufficient" || reason === "runner-disk-capacity-unavailable") return 10; // Runner disk capacity
  return -1;
}

function admissionCheckHeading(title, index, authorized, failedIndex) {
  if (authorized) return `✅ ${title}`;
  if (failedIndex < 0) return title;
  if (index < failedIndex) return `✅ ${title}`;
  if (index === failedIndex) return `❌ ${title}`;
  return title;
}

function writeAdmissionSummary({ authorized, packageName, role, reason, apiCapacity, diskCapacity }) {
  const summaryPath = environment("GITHUB_STEP_SUMMARY");
  if (!summaryPath) return;
  const status = apiCapacity?.status === "limited"
    ? `Blocked package \`${packageName}\` as \`${role}\` before activation: insufficient GitHub REST API capacity.`
    : apiCapacity?.status === "unavailable"
      ? `Blocked package \`${packageName}\` as \`${role}\` before activation: GitHub REST API capacity is unavailable.`
      : diskCapacity?.status === "limited"
        ? `Blocked package \`${packageName}\` as \`${role}\` before activation: insufficient runner disk space.`
        : diskCapacity?.status === "unavailable"
          ? `Blocked package \`${packageName}\` as \`${role}\` before activation: runner disk space is unavailable.`
          : authorized
    ? `Authorized package \`${packageName}\` as \`${role}\`.`
    : `Skipped package \`${packageName}\` as \`${role}\`: ${reason}`;
  const failedIndex = authorized ? -1 : failedAdmissionCheckIndex(reason);
  const checks = ADMISSION_CHECKS.map(([title, description], index) => (
    `- ${admissionCheckHeading(title, index, authorized, failedIndex)} — ${description}`
  )).join("\n");
  writeFileSync(
    summaryPath,
    `<details>\n<summary><h3>Central Agentic Ops admission</h3></summary>\n\n${status}\n${capacityGuidance(apiCapacity)}${diskGuidance(diskCapacity)}\n${checks}\n\n</details>\n`,
    { flag: "a" },
  );
}

function githubApiRequestRequirement(policy, options) {
  let estimated = options.role === "orchestrator" ? 2 : 0;
  if (options.role === "orchestrator") {
    estimated += options.targetRepository
      ? 1
      : policy.allowed_repositories.length > 0
        ? policy.allowed_repositories.length
        : Math.ceil(policy.inventory["max-scan-repositories"] / 100);
    if (policy.monthly_ai_credit_budget > 0) {
      estimated += (Object.keys(policy.worker_policies || {}).length + 1) * 10;
    }
  } else if (policy.safe_output_mode === "live") {
    estimated += 3;
  }
  return Math.max(MINIMUM_GITHUB_API_REQUESTS, estimated);
}

function githubApiCapacity(required) {
  const token = environment("CAO_API_TOKEN");
  try {
    const source = run("gh", ["api", "rate_limit"], {
      env: token ? { ...process.env, GH_TOKEN: token } : process.env,
    });
    const core = JSON.parse(source)?.resources?.core;
    if (![core?.limit, core?.remaining, core?.reset].every(Number.isSafeInteger)) {
      throw new ControlError("GitHub rate-limit response did not contain integer core limits");
    }
    const resetAt = new Date(core.reset * 1000).toISOString();
    return {
      status: core.remaining >= required ? "available" : "limited",
      limit: core.limit,
      remaining: core.remaining,
      required,
      reset: core.reset,
      resetAt,
    };
  } catch {
    return { status: "unavailable", limit: 0, remaining: 0, required, reset: 0, resetAt: "unknown" };
  }
}

function isRateLimitError(error) {
  return typeof error?.message === "string" && /rate limit/i.test(error.message);
}

function writeCapacityBlockedPrecompute(packageName, role, capacity) {
  const reason = capacity.status === "limited" ? "github-api-capacity-insufficient" : "github-api-capacity-unavailable";
  writeActionsOutputs({
    authorized: false,
    reason,
    github_api_status: capacity.status,
    github_api_limit: capacity.limit,
    github_api_remaining: capacity.remaining,
    github_api_required: capacity.required,
    github_api_reset_at: capacity.resetAt,
  });
  writeAdmissionSummary({ authorized: false, packageName, role, reason, apiCapacity: capacity, diskCapacity: undefined });
}

function applyGithubApiAdmission(result, options) {
  if (!result.authorized) return result;
  const required = githubApiRequestRequirement(result, options);
  const capacity = githubApiCapacity(required);
  if (capacity.status === "available") return { ...result, github_api_capacity: capacity };
  return {
    ...result,
    authorized: false,
    reason: capacity.status === "limited" ? "github-api-capacity-insufficient" : "github-api-capacity-unavailable",
    github_api_capacity: capacity,
  };
}

function runnerDiskRequirement(options) {
  return options.role === "orchestrator" ? ORCHESTRATOR_FREE_DISK_MEGABYTES : WORKER_FREE_DISK_MEGABYTES;
}

function runnerDiskCapacity(required) {
  const path = environment("RUNNER_TEMP") || environment("GITHUB_WORKSPACE") || "/tmp";
  try {
    const source = run("df", ["-Pk", path]);
    const line = source.trim().split("\n").at(-1) ?? "";
    const columns = /\s(\d+)\s+(\d+)\s+(\d+)\s+\d+%/.exec(line);
    const availableKilobytes = columns ? Number(columns[3]) : Number.NaN;
    if (!Number.isSafeInteger(availableKilobytes)) {
      throw new ControlError("df did not report an integer count of available blocks");
    }
    const available = Math.floor(availableKilobytes / 1024);
    return { status: available >= required ? "available" : "limited", available, required, path };
  } catch {
    return { status: "unavailable", available: 0, required, path };
  }
}

function applyRunnerDiskAdmission(result, options) {
  if (!result.authorized) return result;
  const capacity = runnerDiskCapacity(runnerDiskRequirement(options));
  if (capacity.status === "available") return { ...result, runner_disk_capacity: capacity };
  return {
    ...result,
    authorized: false,
    reason: capacity.status === "limited" ? "runner-disk-capacity-insufficient" : "runner-disk-capacity-unavailable",
    runner_disk_capacity: capacity,
  };
}

function policyOptions({ normalizeOrchestrator = false } = {}) {
  const role = environment("CAO_ROLE");
  return {
    packageName: environment("CAO_PACKAGE"),
    role,
    workerName: normalizeOrchestrator && role === "orchestrator" ? "" : environment("CAO_WORKER"),
    controlRepository: environment("GITHUB_REPOSITORY"),
    requestedMode: environment("CAO_REQUESTED_MODE"),
    requestedMaxRepositories: environment("CAO_REQUESTED_MAX_REPOSITORIES"),
    requestedRolloutPercent: environment("CAO_REQUESTED_ROLLOUT_PERCENT"),
    targetRepository: environment("CAO_TARGET_REPOSITORY"),
  };
}

function admissionDirectory() {
  return join(environment("RUNNER_TEMP", "/tmp"), "cao");
}

function writeAdmissionRecord(result, options, workflowSha) {
  const directory = admissionDirectory();
  mkdirSync(directory, { recursive: true });
  const failedIndex = result.authorized ? -1 : failedAdmissionCheckIndex(result.reason);
  const checks = ADMISSION_CHECKS.map(([check], index) => ({
    check,
    status: result.authorized || index < failedIndex
      ? "passed"
      : index === failedIndex ? "failed" : "not-evaluated",
  }));
  writeJson(join(directory, "admission.json"), {
    schema_version: 1,
    observed_at: new Date().toISOString(),
    repository: options.controlRepository,
    workflow: environment("GITHUB_WORKFLOW"),
    workflow_sha: workflowSha,
    run_id: environment("GITHUB_RUN_ID"),
    run_attempt: parseInteger(environment("GITHUB_RUN_ATTEMPT"), 1),
    package: options.packageName,
    role: options.role,
    worker: options.workerName,
    target_repository: options.targetRepository,
    authorized: Boolean(result.authorized),
    reason: result.reason || "unknown",
    failed_check: failedIndex >= 0 ? ADMISSION_CHECKS[failedIndex][0] : null,
    checks,
    ...(result.github_api_capacity ? { github_api_capacity: result.github_api_capacity } : {}),
    ...(result.runner_disk_capacity ? { runner_disk_capacity: result.runner_disk_capacity } : {}),
  });
}

function admit() {
  const options = policyOptions({ normalizeOrchestrator: true });
  const workflowSha = environment("GITHUB_WORKFLOW_SHA");
  let result = { authorized: false, reason: "control policy admission did not complete" };

  try {
    if (!options.packageName || !options.role) throw new ControlError("admission requires a package and control role");
    if (!SHA_PATTERN.test(workflowSha)) throw new ControlError("github.workflow_sha must be an exact commit SHA");

    const directory = admissionDirectory();
    mkdirSync(directory, { recursive: true });
    let source;
    try {
      source = decodeRepositoryFile(options.controlRepository, POLICY_PATH, workflowSha);
    } catch {
      throw new ControlError(`cannot read ${POLICY_PATH} at github.workflow_sha`);
    }
    let document;
    try {
      document = parsePolicy(source);
    } catch (error) {
      throw new ControlError(error instanceof PolicyError ? "control policy validation failed" : error.message);
    }
    result = applyRunnerDiskAdmission(applyGithubApiAdmission(effectivePolicy(document, options), options), options);
    writeFileSync(join(directory, "effective-policy.json"), `${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    result = { authorized: false, reason: error.message };
  }

  writeAdmissionRecord(result, options, workflowSha);
  const monthlyCreditBudget = result.authorized ? result.monthly_ai_credit_budget : 0;
  const outputs = {
    authorized: result.authorized,
    reason: result.reason,
    monthly_credit_budget: monthlyCreditBudget,
  };
  if (result.github_api_capacity?.status !== "available" && result.github_api_capacity) {
    Object.assign(outputs, {
      github_api_status: result.github_api_capacity.status,
      github_api_limit: result.github_api_capacity.limit,
      github_api_remaining: result.github_api_capacity.remaining,
      github_api_required: result.github_api_capacity.required,
      github_api_reset_at: result.github_api_capacity.resetAt,
    });
  }
  if (result.runner_disk_capacity && result.runner_disk_capacity.status !== "available") {
    Object.assign(outputs, {
      runner_disk_status: result.runner_disk_capacity.status,
      runner_disk_available_mb: result.runner_disk_capacity.available,
      runner_disk_required_mb: result.runner_disk_capacity.required,
      runner_disk_path: result.runner_disk_capacity.path,
    });
  }
  writeActionsOutputs(outputs);
  writeAdmissionSummary({
    authorized: result.authorized,
    packageName: options.packageName,
    role: options.role,
    reason: result.reason,
    apiCapacity: result.github_api_capacity,
    diskCapacity: result.runner_disk_capacity,
  });
  log(`Admission ${result.authorized ? "authorized" : "denied"}.`);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function requirePositiveInteger(value, maximum, message) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new ControlError(message);
}

function requireNonNegativeInteger(value, message) {
  if (!Number.isSafeInteger(value) || value < 0) throw new ControlError(message);
}

function requireMode(value, label) {
  if (!["review", "live"].includes(value)) throw new ControlError(`${label} must be review or live`);
}

function repositoryEqual(left, right) {
  return left.toLowerCase() === right.toLowerCase();
}

function validateRepositoryOwner(label, repository, allowedOwners) {
  if (!repository) return;
  if (!REPOSITORY_PATTERN.test(repository)) throw new ControlError(`${label} must use owner/repository form`);
  if (allowedOwners.length === 0) return;
  const owner = repository.split("/", 1)[0].toLowerCase();
  if (!allowedOwners.some((allowed) => owner === allowed.trim().toLowerCase())) {
    throw new ControlError(`${label} owner is outside control-plane.scope.allowed-owners`);
  }
}

function parseFrontmatterWorkers(source) {
  const lines = source.split("\n");
  let inFrontmatter = false;
  let inSafeOutputs = false;
  let inDispatch = false;
  let inWorkflows = false;
  const workers = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (index === 0 && /^---\s*$/.test(line)) {
      inFrontmatter = true;
      continue;
    }
    if (inFrontmatter && /^---\s*$/.test(line)) break;
    if (!inFrontmatter) continue;
    if (/^safe-outputs:/.test(line)) {
      inSafeOutputs = true;
      continue;
    }
    if (inSafeOutputs && /^\S/.test(line)) inSafeOutputs = false;
    if (inSafeOutputs && /^  dispatch-workflow:/.test(line)) {
      inDispatch = true;
      continue;
    }
    if (inDispatch && /^  \S/.test(line)) {
      inDispatch = false;
      inWorkflows = false;
    }
    const inline = inDispatch && line.match(/^    workflows:\s*\[(.*)]\s*$/);
    if (inline) {
      workers.push(...inline[1].split(",").map((value) => value.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean));
      continue;
    }
    if (inDispatch && /^    workflows:\s*$/.test(line)) {
      inWorkflows = true;
      continue;
    }
    const item = inWorkflows && line.match(/^\s{4,6}-\s+(.+)$/);
    if (item) {
      workers.push(item[1].trim().replace(/^['"]|['"]$/g, ""));
      continue;
    }
    if (inWorkflows) inWorkflows = false;
  }
  return [...new Set(workers)];
}

function controlSourcePath() {
  const repository = environment("GITHUB_REPOSITORY");
  const workflowReference = environment("GITHUB_WORKFLOW_REF");
  const withoutRepository = workflowReference.startsWith(`${repository}/`)
    ? workflowReference.slice(repository.length + 1)
    : workflowReference;
  const separator = withoutRepository.lastIndexOf("@");
  const workflowPath = separator >= 0 ? withoutRepository.slice(0, separator) : withoutRepository;
  const ref = separator >= 0 ? withoutRepository.slice(separator + 1) : "";
  const sourcePath = workflowPath.endsWith(".lock.yml")
    ? workflowPath.replace(/\.lock\.yml$/, ".md")
    : workflowPath.replace(/\.yml$/, ".md");
  return { sourcePath, ref };
}

function loadWorkflowInventory(repository) {
  const parsed = parseJsonOutput(ghApi(`repos/${repository}/actions/workflows?per_page=100`, {
    jq: ".workflows[] | {id, name, path, state}",
  }));
  const workflows = Array.isArray(parsed) ? parsed : parsed.workflows ?? [parsed];
  return workflows.map(({ id, name, path, state }) => ({ id, name, path, state }));
}

function loadRepository(endpoint) {
  const repository = parseJsonOutput(ghApi(endpoint, {
    jq: "{id, full_name, archived, disabled, private, pushed_at, default_branch}",
  }));
  const { id, full_name, archived, disabled, private: isPrivate, pushed_at, default_branch } = repository;
  return { id, full_name, archived, disabled, private: isPrivate, pushed_at, default_branch };
}

function loadBoundedInventory(organization, maximum) {
  const endpoints = [
    [`orgs/${organization}/repos`, "all"],
    [`users/${organization}/repos`, "owner"],
  ];
  let lastError = "";
  for (const [endpoint, type] of endpoints) {
    try {
      const repositories = [];
      for (let page = 1; page <= Math.ceil(maximum / 100); page += 1) {
        const batch = parseJsonOutput(ghApi(`${endpoint}?per_page=100&type=${type}&page=${page}`, {
          jq: ".[] | {id, full_name, archived, disabled, private, pushed_at, default_branch}",
        }));
        repositories.push(...batch.map(({ id, full_name, archived, disabled, private: isPrivate, pushed_at, default_branch }) => ({
          id, full_name, archived, disabled, private: isPrivate, pushed_at, default_branch,
        })));
        if (batch.length < 100) break;
      }
      return { repositories: repositories.slice(0, maximum), error: "" };
    } catch (error) {
      lastError = error.message;
    }
  }
  return { repositories: [], error: lastError };
}

function inventoryDigest(repositories) {
  const sorted = [...repositories].sort((left, right) => left.id - right.id || left.full_name.localeCompare(right.full_name));
  const input = sorted.map((repository) => JSON.stringify(repository)).join("\n") + (sorted.length ? "\n" : "");
  return `sha256:${createHash("sha256").update(input).digest("hex")}`;
}

function validateOutputDestination({ mode, role, safeOutputRepository, targetRepository, controlRepository }) {
  if (mode === "live") {
    if (role === "worker" && !repositoryEqual(safeOutputRepository, targetRepository)) {
      throw new ControlError("live worker safe_output_repo must equal target_repo");
    }
    return;
  }
  if (repositoryEqual(safeOutputRepository, targetRepository) && !repositoryEqual(safeOutputRepository, controlRepository)) {
    throw new ControlError("review safe_output_repo must differ from target_repo");
  }
  if (repositoryEqual(safeOutputRepository, controlRepository)) return;
  let repository;
  try {
    repository = JSON.parse(ghApi(`repos/${safeOutputRepository}`));
  } catch (error) {
    if (isRateLimitError(error)) throw error;
    throw new ControlError("review safe_output_repo must be accessible");
  }
  if (repository.private !== true) throw new ControlError("non-central review safe_output_repo must be private");
}

function validateWorkerDispatch(context) {
  if (!context.targetRepository) throw new ControlError("worker target_repo is required");
  if (context.policy.allowed_repositories.length > 0
    && !context.policy.allowed_repositories.some((repository) => repositoryEqual(repository, context.targetRepository))) {
    throw new ControlError("worker target_repo is not allowed");
  }
  if (context.workerPolicy.enabled !== true) throw new ControlError("worker is disabled by its control-plane policy");
  requireMode(context.workerPolicy.maxMode, "worker_max_mode");
  if (context.mode === "live" && context.workerPolicy.maxMode !== "live") {
    throw new ControlError("safe_output_mode exceeds the worker_max_mode ceiling");
  }
  if (context.centralRepository !== context.controlRepository) {
    throw new ControlError("central_repo must identify the current control repository");
  }
  if (!/^[1-9][0-9]*-[1-9][0-9]*$/.test(context.correlationId)) {
    throw new ControlError("correlation_id must identify an orchestrator run and attempt");
  }
  const runId = context.correlationId.split("-", 1)[0];
  const expected = `${environment("GITHUB_SERVER_URL")}/${context.controlRepository}/actions/runs/${runId}`;
  if (context.controlPlaneRunUrl !== expected) {
    throw new ControlError("control_plane_run_url must match correlation_id and central_repo");
  }
}

function validateLiveAuthority(context) {
  if (context.mode !== "live") return null;
  const packageName = context.packageName;
  if (typeof packageName !== "string" || !/^[a-z0-9][a-z0-9-]*$/.test(packageName)) {
    throw new ControlError("package slug must use lowercase characters for live authority validation");
  }
  let defaultBranch;
  let targetSha;
  try {
    defaultBranch = ghApi(`repos/${context.targetRepository}`, { jq: ".default_branch" }).trim();
  } catch (error) {
    if (isRateLimitError(error)) throw error;
    throw new ControlError("live authority validation could not read the target default branch");
  }
  try {
    targetSha = ghApi(`repos/${context.targetRepository}/commits/${defaultBranch}`, { jq: ".sha" }).trim();
  } catch (error) {
    if (isRateLimitError(error)) throw error;
    throw new ControlError("live authority validation could not resolve the target default branch commit");
  }
  if (!SHA_PATTERN.test(targetSha)) throw new ControlError("target default branch did not resolve to an exact commit SHA");
  let authoritySource;
  let document;
  try {
    authoritySource = decodeRepositoryFile(context.targetRepository, POLICY_PATH, targetSha);
    document = parsePolicy(authoritySource);
  } catch (error) {
    if (error instanceof PolicyError) {
      if (typeof authoritySource === "string" && error.message === `target-authority.packages.${packageName}.authority has an invalid value`) {
        try {
          const rawAuthority = JSON.parse(authoritySource)["target-authority"].packages[packageName].authority;
          if (typeof rawAuthority === "string") throw new ControlError(error.message);
        } catch (classificationError) {
          if (classificationError instanceof ControlError) throw classificationError;
        }
      }
      throw new ControlError(`target authority file must declare version 1 and target-authority.packages.${packageName}.authority`);
    }
    throw new ControlError(`live mode requires ${POLICY_PATH} on the target default branch`);
  }
  const authority = document["target-authority"]?.packages?.[packageName]?.authority;
  if (!authority) {
    throw new ControlError(`target authority file must declare version 1 and target-authority.packages.${context.packageName}.authority`);
  }
  if (!REPOSITORY_PATTERN.test(authority)) {
    throw new ControlError(`target-authority.packages.${context.packageName}.authority has an invalid value`);
  }
  if (!repositoryEqual(authority, context.centralRepository)) {
    throw new ControlError(`target assigns live authority for ${context.packageName} to a different control repository`);
  }
  return targetSha;
}

function createContext(policy) {
  const packageName = environment("CAO_PACKAGE");
  const role = environment("CAO_ROLE");
  const worker = role === "orchestrator" ? "" : environment("CAO_WORKER");
  if (!packageName || !role) throw new ControlError("precompute requires package and role inputs");
  const workerPolicy = policy.worker_policies?.[worker];
  return {
    policy,
    packageName,
    role,
    worker,
    targetRepository: environment("CAO_TARGET_REPOSITORY"),
    dispatchMaximum: parseInteger(environment("CAO_DISPATCH_MAX"), 1),
    safeOutputRepository: environment("CAO_SAFE_OUTPUT_REPOSITORY"),
    correlationId: environment("CAO_CORRELATION_ID"),
    centralRepository: role === "orchestrator" ? environment("GITHUB_REPOSITORY") : environment("CAO_CENTRAL_REPOSITORY"),
    controlPlaneRunUrl: environment("CAO_CONTROL_PLANE_RUN_URL"),
    orchestratorCredits: parseInteger(environment("CAO_ORCHESTRATOR_CREDITS"), 0),
    workerCreditsPerTarget: parseInteger(environment("CAO_WORKER_CREDITS_PER_TARGET"), 0),
    workflowSha: environment("GITHUB_WORKFLOW_SHA"),
    controlRepository: environment("GITHUB_REPOSITORY"),
    mode: policy.safe_output_mode,
    workerPolicy: {
      enabled: workerPolicy?.enabled ?? true,
      maxMode: workerPolicy?.max_mode ?? policy.safe_output_mode,
    },
  };
}

function writeDeniedPrecompute(policy) {
  const role = environment("CAO_ROLE");
  const worker = role === "orchestrator" ? "" : environment("CAO_WORKER");
  writeJson(OUTPUT_PATH, {
    authorized: false,
    reason: policy.reason ?? "control policy denied this run",
    control_role: role,
    package: environment("CAO_PACKAGE"),
    worker,
    enabled: false,
    effective_max_repos: 0,
    repo_error: "",
    candidate_repositories: [],
    worker_workflows: [],
    policy_source: {
      repository: environment("GITHUB_REPOSITORY"),
      path: POLICY_PATH,
      sha: environment("GITHUB_WORKFLOW_SHA"),
    },
  });
  const safeOutputsPath = environment("GH_AW_SAFE_OUTPUTS");
  if (safeOutputsPath) {
    writeFileSync(safeOutputsPath, `${JSON.stringify({
      type: "noop",
      message: `Central Agentic Ops policy denied this run: ${policy.reason ?? "control policy denied this run"}`,
    })}\n`, { flag: "a" });
  }
}

function writeWorkerPrecompute(context, targetAuthoritySha) {
  writeJson(OUTPUT_PATH, {
    authorized: true,
    reason: "authorized",
    control_role: "worker",
    package: context.packageName,
    bundle: context.packageName,
    worker: context.worker,
    enabled: context.policy.enabled,
    worker_enabled: context.workerPolicy.enabled,
    worker_max_mode: context.workerPolicy.maxMode,
    target_repo: context.targetRepository,
    safe_output_mode: context.mode,
    safe_output_repo: context.safeOutputRepository,
    correlation_id: context.correlationId,
    central_repo: context.centralRepository,
    control_plane_run_url: context.controlPlaneRunUrl,
    candidate_repositories: [],
    worker_workflows: [],
    policy_source: { repository: context.controlRepository, path: POLICY_PATH, sha: context.workflowSha },
    ...(targetAuthoritySha ? {
      target_authority_source: { repository: context.targetRepository, path: POLICY_PATH, sha: targetAuthoritySha },
    } : {}),
  });
}

function selectInventory(context, maximum) {
  if (context.targetRepository) {
    try {
      return { repositories: [loadRepository(`repos/${context.targetRepository}`)], source: "target_repo", error: "" };
    } catch (error) {
      return { repositories: [], source: "target_repo", error: error.message };
    }
  }
  const allowedRepositories = context.policy.allowed_repositories;
  if (allowedRepositories.length > 0) {
    const repositories = [];
    for (const repository of allowedRepositories) {
      try {
        repositories.push(loadRepository(`repos/${repository}`));
      } catch {
        return { repositories: [], source: "allowed_repos", error: `cannot read allowed repository ${repository}` };
      }
    }
    return { repositories, source: "allowed_repos", error: "" };
  }
  const organization = context.controlRepository.split("/", 1)[0];
  const { repositories, error } = loadBoundedInventory(organization, maximum);
  return { repositories, source: "organization", error };
}

function createInventory(context, repositories) {
  const inventory = context.policy.inventory;
  const maximumRepositories = context.policy.max_repositories;
  const maximumScanRepositories = inventory["max-scan-repositories"];
  const cellCount = inventory["cell-count"];
  const cellIndex = inventory["cell-index"];
  const batchSize = inventory["batch-size"];
  const batchIndex = inventory["batch-index"];

  requirePositiveInteger(maximumRepositories, 1000, "max_repos must be an integer from 1 through 1000");
  requirePositiveInteger(maximumScanRepositories, 100_000, "max_scan_repos must be an integer from 1 through 100000");
  requirePositiveInteger(cellCount, 1000, "cell_count must be an integer from 1 through 1000");
  if (!Number.isSafeInteger(cellIndex) || cellIndex < 0 || cellIndex >= cellCount) {
    throw new ControlError("cell_index must be an integer from 0 through cell_count minus 1");
  }
  requirePositiveInteger(batchSize, 100_000, "batch_size must be an integer from 1 through 100000");
  requireNonNegativeInteger(batchIndex, "batch_index must be a non-negative integer");
  requirePositiveInteger(context.dispatchMaximum, 1000, "dispatch_max must be an integer from 1 through 1000");
  requirePositiveInteger(context.policy.rollout_percent, 100, "rollout_percent must be an integer from 1 through 100");
  requireNonNegativeInteger(context.orchestratorCredits, "AI Credit admission values must be non-negative integers");
  requireNonNegativeInteger(context.workerCreditsPerTarget, "AI Credit admission values must be non-negative integers");

  const sorted = [...repositories].sort((left, right) => left.id - right.id || left.full_name.localeCompare(right.full_name));
  const version = inventoryDigest(sorted);
  const cell = context.targetRepository ? sorted : sorted.filter(({ id }) => id % cellCount === cellIndex);
  const batchCount = Math.ceil(cell.length / batchSize);
  if (batchCount > 0 && batchIndex >= batchCount) {
    throw new ControlError(`batch_index must be smaller than the selected cell batch count (${batchCount})`);
  }
  const candidates = cell.slice(batchIndex * batchSize, (batchIndex + 1) * batchSize);
  return {
    candidates,
    metadata: {
      inventory_version: version,
      inventory_repository_count: sorted.length,
      cell_count: cellCount,
      cell_index: cellIndex,
      cell_repository_count: cell.length,
      batch_size: batchSize,
      batch_index: batchIndex,
      batch_count: batchCount,
      batch_id: `${version}:cell-${cellIndex}-of-${cellCount}:batch-${batchIndex}-of-${batchCount}`,
    },
  };
}

function writeOrchestratorPrecompute(context) {
  requirePositiveInteger(context.policy.max_repositories, 1000, "max_repos must be an integer from 1 through 1000");
  requirePositiveInteger(context.policy.inventory["max-scan-repositories"], 100_000, "max_scan_repos must be an integer from 1 through 100000");
  requirePositiveInteger(context.policy.inventory["cell-count"], 1000, "cell_count must be an integer from 1 through 1000");
  requirePositiveInteger(context.policy.inventory["batch-size"], 100_000, "batch_size must be an integer from 1 through 100000");
  requirePositiveInteger(context.dispatchMaximum, 1000, "dispatch_max must be an integer from 1 through 1000");
  requirePositiveInteger(context.policy.rollout_percent, 100, "rollout_percent must be an integer from 1 through 100");
  requireNonNegativeInteger(context.orchestratorCredits, "AI Credit admission values must be non-negative integers");
  requireNonNegativeInteger(context.workerCreditsPerTarget, "AI Credit admission values must be non-negative integers");

  const { sourcePath, ref } = controlSourcePath();
  const source = Buffer.from(ghApi(`repos/${context.controlRepository}/contents/${sourcePath}`, {
    fields: { ref }, jq: ".content",
  }).replace(/\s/g, ""), "base64").toString("utf8");
  const configuredWorkers = parseFrontmatterWorkers(source);
  if (configuredWorkers.length === 0) {
    throw new ControlError("shared/control.md role orchestrator requires safe-outputs.dispatch-workflow.workflows");
  }
  const workflows = loadWorkflowInventory(context.controlRepository);
  const maximumScanRepositories = context.policy.inventory["max-scan-repositories"];

  if (context.policy.allowed_repositories.length > maximumScanRepositories) {
    throw new ControlError("allowed repos exceed max_scan_repos");
  }
  if (context.targetRepository && context.policy.allowed_repositories.length > 0
    && !context.policy.allowed_repositories.some((repository) => repositoryEqual(repository, context.targetRepository))) {
    throw new ControlError("target_repo is not allowed");
  }

  const selected = selectInventory(context, maximumScanRepositories);
  const { candidates, metadata } = createInventory(context, selected.repositories);
  const resolvedCandidates = candidates.map((repository) => ({
    ...repository,
    safe_output_mode: context.policy.target_policies?.[repository.full_name.toLowerCase()]?.mode ?? context.mode,
  }));
  const workerWorkflows = configuredWorkers.map((configured) => {
    const match = workflows.find(({ path }) => path === `.github/workflows/${configured}.lock.yml`);
    const policy = context.policy.worker_policies?.[configured];
    const enabled = policy?.enabled ?? false;
    const active = match && !String(match.state ?? "").startsWith("disabled");
    return {
      configured,
      matched: Boolean(match),
      worker: policy?.worker ?? null,
      policy_enabled: enabled,
      max_mode: policy?.max_mode ?? null,
      id: match?.id ?? null,
      name: match?.name ?? null,
      path: match?.path ?? null,
      state: match?.state ?? "",
      eligible: Boolean(enabled && match && active),
      skip_reason: !policy
        ? "worker is not part of installed package"
        : !enabled
          ? "worker disabled by control-plane policy"
          : !match
            ? "worker workflow unavailable"
            : !active
              ? "worker workflow disabled"
              : null,
    };
  });
  const eligibleWorkers = workerWorkflows.filter(({ eligible }) => eligible).length;
  const percentCap = resolvedCandidates.length === 0
    ? 0
    : Math.max(1, Math.ceil(resolvedCandidates.length * context.policy.rollout_percent / 100));
  const dispatchCap = eligibleWorkers === 0 ? 0 : Math.floor(context.dispatchMaximum / eligibleWorkers);
  const effectiveMaximum = Math.min(context.policy.max_repositories, percentCap, dispatchCap);

  const result = {
    authorized: true,
    reason: "authorized",
    control_role: "orchestrator",
    package: context.packageName,
    bundle: context.packageName,
    worker: context.worker,
    enabled: context.policy.enabled,
    target_repo: context.targetRepository,
    organization: context.controlRepository.split("/", 1)[0],
    max_repos: context.policy.max_repositories,
    max_scan_repos: maximumScanRepositories,
    dispatch_max: context.dispatchMaximum,
    rollout_percent: context.policy.rollout_percent,
    effective_max_repos: effectiveMaximum,
    orchestrator_credits: context.orchestratorCredits,
    worker_credits_per_target: context.workerCreditsPerTarget,
    monthly_credit_budget: context.policy.monthly_ai_credit_budget,
    safe_output_mode: context.mode,
    safe_output_repo: context.safeOutputRepository,
    repo_source: selected.source,
    repo_error: selected.error,
    policy_source: { repository: context.controlRepository, path: POLICY_PATH, sha: context.workflowSha },
    ...metadata,
    total_repositories_scanned: metadata.inventory_repository_count,
    candidate_repositories: resolvedCandidates,
    worker_workflows: workerWorkflows,
  };
  writeJson(OUTPUT_PATH, applyMonthlyBudget(context, configuredWorkers, result));
}

function applyMonthlyBudget(context, configuredWorkers, result) {
  const budget = result.monthly_credit_budget;
  requireNonNegativeInteger(budget, "monthly_credit_budget must be a non-negative integer");
  requireNonNegativeInteger(context.workerCreditsPerTarget, "worker_credits_per_target must be a non-negative integer");
  if (budget > 0 && context.workerCreditsPerTarget === 0) {
    throw new ControlError("monthly_credit_budget requires positive worker_credits_per_target");
  }

  let spent = 0;
  let budgetError = "";
  if (budget > 0) {
    const monthStart = new Date().toISOString().slice(0, 8) + "01";
    const runs = new Map();
    for (const workflowId of [...new Set([context.packageName, ...configuredWorkers])].sort()) {
      const command = spawnSync("gh", ["aw", "logs", workflowId, "--start-date", monthStart, "--json", "-c", "1000"], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      });
      let document;
      try {
        document = JSON.parse(command.stdout);
      } catch {
        document = null;
      }
      if (!Array.isArray(document?.runs)) {
        budgetError = `could not read valid month-to-date AI Credit usage for ${workflowId} (exit code ${command.status ?? 1})`;
        break;
      }
      for (const item of document.runs) runs.set(item.run_id, item);
    }
    if (!budgetError) spent = [...runs.values()].reduce((total, item) => total + (Number(item.aic) || 0), 0);
  }
  const remaining = Math.max(0, budget - spent);
  const targetCap = budget === 0
    ? Number(result.max_repos)
    : budgetError || budget <= spent + context.orchestratorCredits
      ? 0
      : Math.floor((budget - spent - context.orchestratorCredits) / context.workerCreditsPerTarget);
  return {
    ...result,
    monthly_credit_budget: budget,
    monthly_ai_credits_spent: spent,
    monthly_ai_credits_remaining: remaining,
    monthly_budget_error: budgetError,
    monthly_budget_target_cap: targetCap,
    effective_max_repos: Math.min(result.effective_max_repos, targetCap),
  };
}

function precompute() {
  mkdirSync(AGENT_DIRECTORY, { recursive: true });
  const effectivePath = join(admissionDirectory(), "effective-policy.json");
  let policy;
  try {
    policy = readJson(effectivePath);
  } catch {
    throw new ControlError(`missing admission effective policy: ${effectivePath}`);
  }
  if (typeof policy.authorized !== "boolean") {
    throw new ControlError("control policy resolver returned an invalid admission result");
  }
  if (!policy.authorized) {
    writeDeniedPrecompute(policy);
    log("Precompute skipped because admission was denied.");
    return;
  }
  log("Applying the admitted control policy.");
  const context = createContext(policy);
  try {
    requireMode(context.mode, "safe_output_mode");
    validateRepositoryOwner("target_repo", context.targetRepository, policy.allowed_owners);
    validateRepositoryOwner("safe_output_repo", context.safeOutputRepository, policy.allowed_owners);
    validateOutputDestination(context);

    if (context.role === "worker") {
      validateWorkerDispatch(context);
      const targetAuthoritySha = validateLiveAuthority(context);
      writeWorkerPrecompute(context, targetAuthoritySha);
      log("Prepared worker precompute data.");
      return;
    }
    writeOrchestratorPrecompute(context);
    log("Prepared orchestrator precompute data.");
  } catch (error) {
    if (!isRateLimitError(error)) throw error;
    const required = githubApiRequestRequirement(policy, { role: context.role, targetRepository: context.targetRepository });
    const capacity = githubApiCapacity(required);
    writeCapacityBlockedPrecompute(
      context.packageName,
      context.role,
      capacity.status === "unavailable" ? { ...capacity, status: "limited" } : capacity,
    );
  }
}

function readSource(path) {
  return path === "-" ? readFileSync(0, "utf8") : readFileSync(path, "utf8");
}

function policyCommand(command, args) {
  if (args.length !== 1) throw new ControlError(`usage: control.mjs ${command} <file|->`);
  const document = parsePolicy(readSource(args[0]));
  if (command === "validate-policy") return document;
  if (command === "resolve-policy") return effectivePolicy(document, policyOptions());
  if (command === "control-settings") return controlSettings(document, environment("GITHUB_REPOSITORY"));
  throw new ControlError(`unknown command: ${command}`);
}

function authority(args) {
  if (args.length !== 2) throw new ControlError("usage: control.mjs authority <file|-> <package>");
  const document = parsePolicy(readSource(args[0]));
  const value = document["target-authority"]?.packages?.[args[1]]?.authority;
  if (!value) throw new PolicyError(`target authority does not declare package ${args[1]}`);
  process.stdout.write(`${value}\n`);
}

/** @param {string[]} arguments_ */
function main(arguments_) {
  const [command, ...args] = arguments_;
  try {
    if (command === "admit" && args.length === 0) {
      return withLogGroup("Central Agentic Ops admission", admit);
    }
    if (command === "precompute" && args.length === 0) {
      return withLogGroup("Central Agentic Ops precompute", precompute);
    }
    if (command === "authority") return authority(args);
    if (["validate-policy", "resolve-policy", "control-settings"].includes(command)) {
      process.stdout.write(`${JSON.stringify(policyCommand(command, args), null, 2)}\n`);
      return;
    }
    throw new ControlError("usage: control.mjs admit | precompute | validate-policy <file|-> | resolve-policy <file|-> | control-settings <file|-> | authority <file|-> <package>");
  } catch (error) {
    if (error instanceof ControlError || error instanceof PolicyError || error?.code === "ENOENT") {
      process.stderr.write(`[CAO failure] ${error.message}\n`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}