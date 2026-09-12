export class PolicyError extends Error {}

const SCHEMA_URI = "https://raw.githubusercontent.com/githubnext/gh-aw-cao/main/.github/cao/cao.schema.json";
const ROOT_KEYS = ["$schema", "version", "gh-aw-version", "control-plane", "target-authority"];
const CONTROL_KEYS = ["scope", "inventory", "web", "defaults", "packages", "publishing"];
const SCOPE_KEYS = ["allowed-owners", "allowed-repositories"];
const INVENTORY_KEYS = ["max-scan-repositories", "cell-count", "cell-index", "batch-size", "batch-index"];
const WEB_KEYS = ["favicon"];
const DEFAULT_KEYS = ["mode", "max-repositories", "rollout-percent", "monthly-ai-credit-budget"];
const OCTICONS = [
  "mark-github", "code", "repo", "server", "issue", "pull-request", "play", "eye",
  "shield", "meter", "graph", "codescan", "dependabot", "key", "beaker", "rocket",
  "workflow", "gear", "check-circle", "package", "external-link",
];
const PACKAGE_KEYS = ["enabled", ...DEFAULT_KEYS, "icon", "deploy", "targets", "workers"];
const TARGET_POLICY_KEYS = ["mode"];
const WORKER_KEYS = ["workflow", "enabled", "max-mode"];
const PUBLISHING_KEYS = ["enabled", "control-repositories", "reviewers"];
const TARGET_AUTHORITY_KEYS = ["packages"];
const TARGET_PACKAGE_KEYS = ["authority"];
const REPOSITORY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/;
const OWNER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const GH_AW_VERSION_PATTERN = /^v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;
const MODES = ["review", "live"];

function log(message) {
  console.error(`[CAO policy] ${message}`);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function parsePolicy(source) {
  log("Parsing control policy.");
  let document;
  try {
    document = JSON.parse(source);
    assertNoDuplicateKeys(source);
  } catch (error) {
    if (error instanceof PolicyError) throw error;
    throw new PolicyError(`invalid policy JSON: ${error.message}`);
  }
  if (!isRecord(document)) throw new PolicyError("policy root must be a mapping");

  rejectExpressions(document);
  validateDocument(document);
  log("Validated control policy.");
  return document;
}

function assertNoDuplicateKeys(source) {
  let offset = 0;

  function skipWhitespace() {
    while (/\s/.test(source[offset] ?? "")) offset += 1;
  }

  function scanString() {
    const start = offset;
    offset += 1;
    while (source[offset] !== '"') {
      offset += source[offset] === "\\" ? 2 : 1;
    }
    offset += 1;
    return JSON.parse(source.slice(start, offset));
  }

  function scanValue() {
    skipWhitespace();
    if (source[offset] === "{") {
      scanObject();
    } else if (source[offset] === "[") {
      scanArray();
    } else if (source[offset] === '"') {
      scanString();
    } else {
      while (offset < source.length && !/[\s,\]}]/.test(source[offset])) offset += 1;
    }
  }

  function scanObject() {
    const keys = new Set();
    offset += 1;
    skipWhitespace();
    if (source[offset] === "}") {
      offset += 1;
      return;
    }

    while (offset < source.length) {
      const key = scanString();
      if (keys.has(key)) throw new PolicyError(`duplicate mapping key: ${key}`);
      keys.add(key);
      skipWhitespace();
      offset += 1;
      scanValue();
      skipWhitespace();
      if (source[offset] === "}") {
        offset += 1;
        return;
      }
      offset += 1;
      skipWhitespace();
    }
  }

  function scanArray() {
    offset += 1;
    skipWhitespace();
    if (source[offset] === "]") {
      offset += 1;
      return;
    }

    while (offset < source.length) {
      scanValue();
      skipWhitespace();
      if (source[offset] === "]") {
        offset += 1;
        return;
      }
      offset += 1;
    }
  }

  scanValue();
}

function validateDocument(document) {
  assertKeys(document, ROOT_KEYS, "policy");
  if ("$schema" in document && document.$schema !== SCHEMA_URI) {
    throw new PolicyError(`$schema must be ${SCHEMA_URI}`);
  }
  assertInteger(document.version, "version", 1, 1);
  if (!("control-plane" in document) && !("target-authority" in document)) {
    throw new PolicyError("policy requires control-plane or target-authority");
  }
  if ("control-plane" in document && !("gh-aw-version" in document)) {
    throw new PolicyError("gh-aw-version is required for a control plane");
  }
  if ("gh-aw-version" in document) {
    assertString(document["gh-aw-version"], "gh-aw-version", GH_AW_VERSION_PATTERN);
  }

  if ("control-plane" in document) validateControlPlane(document["control-plane"]);
  if ("target-authority" in document) validateTargetAuthority(document["target-authority"]);
}

function validateControlPlane(control) {
  assertMapping(control, "control-plane");
  assertKeys(control, CONTROL_KEYS, "control-plane");
  if ("scope" in control) validateScope(control.scope);
  if ("inventory" in control) validateInventory(control.inventory);
  if ("web" in control) validateWeb(control.web);
  if ("defaults" in control) validateDefaults(control.defaults, "control-plane.defaults");
  if ("packages" in control) {
    validatePackages(control.packages);
    validatePackageRepositoryScopes(control);
  }
  if ("publishing" in control) validatePublishing(control.publishing);
}

function validateScope(scope) {
  assertMapping(scope, "control-plane.scope");
  assertKeys(scope, SCOPE_KEYS, "control-plane.scope");
  if ("allowed-owners" in scope) {
    assertUniqueStrings(scope["allowed-owners"], "control-plane.scope.allowed-owners", OWNER_PATTERN);
  }
  if ("allowed-repositories" in scope) {
    assertUniqueStrings(scope["allowed-repositories"], "control-plane.scope.allowed-repositories", REPOSITORY_PATTERN);
  }
}

function validateInventory(inventory) {
  assertMapping(inventory, "control-plane.inventory");
  assertKeys(inventory, INVENTORY_KEYS, "control-plane.inventory");
  if ("max-scan-repositories" in inventory) {
    assertInteger(inventory["max-scan-repositories"], "control-plane.inventory.max-scan-repositories", 1, 100_000);
  }
  if ("cell-count" in inventory) assertInteger(inventory["cell-count"], "control-plane.inventory.cell-count", 1, 1000);
  if ("cell-index" in inventory) assertInteger(inventory["cell-index"], "control-plane.inventory.cell-index", 0);
  if ("batch-size" in inventory) assertInteger(inventory["batch-size"], "control-plane.inventory.batch-size", 1, 100_000);
  if ("batch-index" in inventory) assertInteger(inventory["batch-index"], "control-plane.inventory.batch-index", 0);

  const cellCount = inventory["cell-count"] ?? 1;
  const cellIndex = inventory["cell-index"] ?? 0;
  if (cellIndex >= cellCount) {
    throw new PolicyError("control-plane.inventory.cell-index must be smaller than cell-count");
  }
}

function validateWeb(web) {
  const path = "control-plane.web";
  assertMapping(web, path);
  assertKeys(web, WEB_KEYS, path);
  if ("favicon" in web) assertFavicon(web.favicon, `${path}.favicon`);
}

function validateDefaults(defaults, path) {
  assertMapping(defaults, path);
  assertKeys(defaults, DEFAULT_KEYS, path);
  if ("mode" in defaults) assertMode(defaults.mode, `${path}.mode`);
  if ("max-repositories" in defaults) assertInteger(defaults["max-repositories"], `${path}.max-repositories`, 1, 1000);
  if ("rollout-percent" in defaults) assertInteger(defaults["rollout-percent"], `${path}.rollout-percent`, 1, 100);
  if ("monthly-ai-credit-budget" in defaults) {
    assertInteger(defaults["monthly-ai-credit-budget"], `${path}.monthly-ai-credit-budget`, 0);
  }
}

function validatePackages(packages) {
  assertMapping(packages, "control-plane.packages");
  for (const [packageName, packagePolicy] of Object.entries(packages)) {
    const path = `control-plane.packages.${packageName}`;
    assertString(packageName, path, SLUG_PATTERN);
    assertMapping(packagePolicy, path);
    assertKeys(packagePolicy, PACKAGE_KEYS, path);
    if ("enabled" in packagePolicy) assertBoolean(packagePolicy.enabled, `${path}.enabled`);
    if ("icon" in packagePolicy) assertOcticon(packagePolicy.icon, `${path}.icon`);
    if ("deploy" in packagePolicy) assertBoolean(packagePolicy.deploy, `${path}.deploy`);
    validateDefaults(pick(packagePolicy, DEFAULT_KEYS), path);
    if ("targets" in packagePolicy) {
      const targets = packagePolicy.targets;
      assertMapping(targets, `${path}.targets`);
      assertUniqueRepositoryKeys(targets, `${path}.targets`);
      for (const [repository, targetPolicy] of Object.entries(targets)) {
        const targetPath = `${path}.targets.${repository}`;
        assertString(repository, targetPath, REPOSITORY_PATTERN);
        assertMapping(targetPolicy, targetPath);
        assertKeys(targetPolicy, TARGET_POLICY_KEYS, targetPath);
        if (!("mode" in targetPolicy)) throw new PolicyError(`${targetPath}.mode is required`);
        assertMode(targetPolicy.mode, `${targetPath}.mode`);
      }
    }
    if (!("workers" in packagePolicy)) continue;

    const workers = packagePolicy.workers;
    assertMapping(workers, `${path}.workers`);
    const workflows = new Set();
    for (const [workerName, worker] of Object.entries(workers)) {
      const workerPath = `${path}.workers.${workerName}`;
      assertString(workerName, workerPath, SLUG_PATTERN);
      assertMapping(worker, workerPath);
      assertKeys(worker, WORKER_KEYS, workerPath);
      assertString(worker.workflow, `${workerPath}.workflow`, SLUG_PATTERN);
      if (workflows.has(worker.workflow)) {
        throw new PolicyError(`${path}.workers must declare unique workflow identities`);
      }
      workflows.add(worker.workflow);
      if ("enabled" in worker) assertBoolean(worker.enabled, `${workerPath}.enabled`);
      if ("max-mode" in worker) assertMode(worker["max-mode"], `${workerPath}.max-mode`);
    }
  }
}

function validatePackageRepositoryScopes(control) {
  const allowedRepositories = control.scope?.["allowed-repositories"];
  const allowedOwners = control.scope?.["allowed-owners"];
  const repositorySet = allowedRepositories && new Set(allowedRepositories.map((repository) => repository.toLowerCase()));
  const ownerSet = allowedOwners && new Set(allowedOwners.map((owner) => owner.toLowerCase()));

  for (const packagePolicy of Object.values(control.packages ?? {})) {
    for (const repository of Object.keys(packagePolicy.targets ?? {})) {
      const normalized = repository.toLowerCase();
      if (repositorySet && !repositorySet.has(normalized)) {
        throw new PolicyError(`package target ${repository} is outside control-plane.scope.allowed-repositories`);
      }
      if (ownerSet && !ownerSet.has(normalized.split("/", 1)[0])) {
        throw new PolicyError(`package target ${repository} is outside control-plane.scope.allowed-owners`);
      }
    }
  }
}

function validatePublishing(publishing) {
  const path = "control-plane.publishing";
  assertMapping(publishing, path);
  assertKeys(publishing, PUBLISHING_KEYS, path);
  if ("enabled" in publishing) assertBoolean(publishing.enabled, `${path}.enabled`);
  if ("control-repositories" in publishing) {
    assertUniqueStrings(publishing["control-repositories"], `${path}.control-repositories`, REPOSITORY_PATTERN);
  }
  if ("reviewers" in publishing) assertUniqueStrings(publishing.reviewers, `${path}.reviewers`, LOGIN_PATTERN);
  if ((publishing.enabled ?? false) && (publishing.reviewers ?? []).length === 0) {
    throw new PolicyError("control-plane.publishing.reviewers is required when publishing is enabled");
  }
}

function validateTargetAuthority(target) {
  const path = "target-authority";
  assertMapping(target, path);
  assertKeys(target, TARGET_AUTHORITY_KEYS, path);
  const packages = target.packages;
  assertMapping(packages, `${path}.packages`);
  for (const [packageName, packagePolicy] of Object.entries(packages)) {
    const packagePath = `${path}.packages.${packageName}`;
    assertString(packageName, packagePath, SLUG_PATTERN);
    assertMapping(packagePolicy, packagePath);
    assertKeys(packagePolicy, TARGET_PACKAGE_KEYS, packagePath);
    assertString(packagePolicy.authority, `${packagePath}.authority`, REPOSITORY_PATTERN);
  }
}

function rejectExpressions(value, path = "policy") {
  if (Array.isArray(value)) {
    value.forEach((child, index) => rejectExpressions(child, `${path}[${index}]`));
  } else if (isRecord(value)) {
    Object.entries(value).forEach(([key, child]) => rejectExpressions(child, `${path}.${key}`));
  } else if (typeof value === "string" && value.includes("${{")) {
    throw new PolicyError(`${path} must not contain a GitHub Actions expression`);
  }
}

export function effectivePolicy(
  document,
  {
    packageName,
    role,
    workerName = "",
    controlRepository,
    requestedMode = "",
    requestedMaxRepositories = "",
    requestedRolloutPercent = "",
    targetRepository = "",
  },
) {
  log("Resolving effective policy.");
  if (!["orchestrator", "worker"].includes(role)) throw new PolicyError("role must be orchestrator or worker");
  if (role === "worker" && !workerName) throw new PolicyError("worker identity is required");
  if (role === "orchestrator" && workerName) throw new PolicyError("worker identity is forbidden for orchestrators");

  const control = document["control-plane"];
  if (!control) return denied("control-plane-absent", packageName, role, workerName);

  const packagePolicy = (control.packages ?? {})[packageName];
  if (!packagePolicy) return denied("package-undeclared", packageName, role, workerName);
  if (!(packagePolicy.enabled ?? true)) return denied("package-disabled", packageName, role, workerName);
  const workers = packagePolicy.workers ?? {};
  if (role === "worker" && !(workerName in workers)) {
    throw new PolicyError(`unknown worker: ${packageName}/${workerName}`);
  }

  const defaults = {
    mode: "review",
    "max-repositories": 1,
    "rollout-percent": 100,
    "monthly-ai-credit-budget": 0,
    ...(control.defaults ?? {}),
  };
  const effective = { ...defaults, ...pick(packagePolicy, DEFAULT_KEYS) };
  let targetPolicies = Object.fromEntries(
    Object.entries(packagePolicy.targets ?? {}).map(([repository, targetPolicy]) => [
      repository.toLowerCase(),
      { mode: targetPolicy.mode },
    ]),
  );
  const workerPolicies = Object.fromEntries(
    Object.entries(workers).map(([worker, policy]) => {
      return [policy.workflow, {
        worker,
        enabled: policy.enabled ?? true,
        max_mode: policy["max-mode"] ?? null,
      }];
    }),
  );
  if (targetRepository) {
    if (typeof targetRepository !== "string" || !REPOSITORY_PATTERN.test(targetRepository)) {
      throw new PolicyError("target_repo must use owner/repository form");
    }
    const targetPolicy = targetPolicies[targetRepository.toLowerCase()];
    if (targetPolicy) effective.mode = targetPolicy.mode;
  }

  if (role === "worker") {
    const worker = workers[workerName];
    if (!(worker.enabled ?? true)) return denied("worker-disabled", packageName, role, workerName);
    if ("max-mode" in worker) {
      effective.mode = lesserMode(effective.mode, worker["max-mode"]);
      targetPolicies = Object.fromEntries(
        Object.entries(targetPolicies).map(([repository, targetPolicy]) => [
          repository,
          { mode: lesserMode(targetPolicy.mode, worker["max-mode"]) },
        ]),
      );
    }
  }

  if (requestedMode) {
    assertMode(requestedMode, "safe_output_mode");
    if (modeRank(requestedMode) > modeRank(effective.mode)) {
      throw new PolicyError("safe_output_mode exceeds checked-in policy");
    }
    effective.mode = requestedMode;
    targetPolicies = Object.fromEntries(
      Object.entries(targetPolicies).map(([repository, targetPolicy]) => [
        repository,
        { mode: lesserMode(targetPolicy.mode, requestedMode) },
      ]),
    );
  }
  narrowInteger(effective, "max-repositories", requestedMaxRepositories, "max_repositories", 1000);
  narrowInteger(effective, "rollout-percent", requestedRolloutPercent, "rollout_percent", 100);

  const scope = control.scope ?? {};
  const allowedOwners = scope["allowed-owners"] ?? [controlRepository.split("/", 1)[0]];
  const inventory = {
    "max-scan-repositories": 1000,
    "cell-count": 1,
    "cell-index": 0,
    "batch-size": 100_000,
    "batch-index": 0,
    ...(control.inventory ?? {}),
  };

  return {
    authorized: true,
    reason: "authorized",
    control_role: role,
    package: packageName,
    worker: workerName,
    enabled: true,
    safe_output_mode: effective.mode,
    max_repositories: effective["max-repositories"],
    rollout_percent: effective["rollout-percent"],
    monthly_ai_credit_budget: 0,
    target_policies: targetPolicies,
    worker_policies: workerPolicies,
    allowed_owners: allowedOwners,
    allowed_repositories: scope["allowed-repositories"] ?? [],
    inventory,
  };
}

export function controlSettings(document, controlRepository) {
  assertString(controlRepository, "GITHUB_REPOSITORY", REPOSITORY_PATTERN);
  const control = document["control-plane"];
  if (!control) throw new PolicyError("control-plane is required");

  const scope = control.scope ?? {};
  const web = control.web ?? {};
  const publishing = control.publishing ?? {};
  const defaults = {
    mode: "review",
    "max-repositories": 1,
    "rollout-percent": 100,
    "monthly-ai-credit-budget": 0,
    ...(control.defaults ?? {}),
  };
  const packages = Object.fromEntries(Object.entries(control.packages ?? {}).map(([name, policy]) => [name, {
    enabled: policy.enabled ?? true,
    ...defaults,
    ...pick(policy, DEFAULT_KEYS),
    icon: policy.icon ?? null,
    deploy: policy.deploy ?? true,
    worker_policies: Object.fromEntries(
      Object.entries(policy.workers ?? {}).map(([worker, workerPolicy]) => [workerPolicy.workflow, {
        worker,
        enabled: workerPolicy.enabled ?? true,
        max_mode: workerPolicy["max-mode"] ?? null,
      }]),
    ),
    ...(policy.targets ? {
      target_policies: Object.fromEntries(
        Object.entries(policy.targets).map(([repository, targetPolicy]) => [repository.toLowerCase(), targetPolicy]),
      ),
    } : {}),
  }]));
  return {
    allowed_owners: scope["allowed-owners"] ?? [controlRepository.split("/", 1)[0]],
    allowed_repositories: scope["allowed-repositories"] ?? [],
    web: {
      favicon: web.favicon ?? "./favicon.svg",
    },
    packages,
    publishing_enabled: publishing.enabled ?? false,
    publishing_control_repositories: publishing["control-repositories"] ?? [controlRepository],
    publishing_reviewers: publishing.reviewers ?? [],
  };
}

function denied(reason, packageName, role, workerName) {
  return {
    authorized: false,
    reason,
    control_role: role,
    package: packageName,
    worker: workerName,
    enabled: false,
    effective_max_repos: 0,
    candidate_repositories: [],
    worker_workflows: [],
  };
}

function pick(object, keys) {
  return Object.fromEntries(keys.filter((key) => key in object).map((key) => [key, object[key]]));
}

function assertKeys(mapping, allowed, path) {
  const unknown = Object.keys(mapping).find((key) => !allowed.includes(key));
  if (unknown) throw new PolicyError(`unknown key ${path}.${unknown}`);
}

function assertMapping(value, path) {
  if (!isRecord(value)) throw new PolicyError(`${path} must be a mapping`);
}

function assertBoolean(value, path) {
  if (value !== true && value !== false) throw new PolicyError(`${path} must be a Boolean`);
}

function assertOcticon(value, path) {
  if (typeof value !== "string" || !OCTICONS.includes(value)) {
    throw new PolicyError(`${path} must be one of: ${OCTICONS.join(", ")}`);
  }
}

function assertFavicon(value, path) {
  if (typeof value !== "string" || value.length > 2048 || /\s/.test(value)) {
    throw new PolicyError(`${path} must be an absolute HTTPS URL or ./ relative path`);
  }
  if (value.startsWith("./")) {
    if (!/^\.\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) || value.split("/").includes("..")) {
      throw new PolicyError(`${path} must be an absolute HTTPS URL or ./ relative path`);
    }
    return;
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new PolicyError(`${path} must be an absolute HTTPS URL or ./ relative path`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new PolicyError(`${path} must be an absolute HTTPS URL or ./ relative path`);
  }
}

/**
 * @param {unknown} value
 * @param {string} path
 * @param {number} minimum
 * @param {number} [maximum]
 */
function assertInteger(value, path, minimum, maximum = undefined) {
  const valid = typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && (maximum === undefined || value <= maximum);
  const range = maximum === undefined ? `>= ${minimum}` : `${minimum}..${maximum}`;
  if (!valid) throw new PolicyError(`${path} must be an integer in ${range}`);
}

function assertMode(value, path) {
  if (!MODES.includes(value)) throw new PolicyError(`${path} must be review or live`);
}

function assertString(value, path, pattern) {
  if (typeof value !== "string" || !pattern.test(value)) throw new PolicyError(`${path} has an invalid value`);
}

function assertUniqueStrings(value, path, pattern) {
  if (!Array.isArray(value)) throw new PolicyError(`${path} must be an array`);
  value.forEach((item) => assertString(item, path, pattern));
  const normalized = value.map((item) => item.toLowerCase());
  if (new Set(normalized).size !== normalized.length) throw new PolicyError(`${path} must contain unique values`);
}

function assertUniqueRepositoryKeys(value, path) {
  const normalized = Object.keys(value).map((repository) => repository.toLowerCase());
  if (new Set(normalized).size !== normalized.length) throw new PolicyError(`${path} must contain unique repository names`);
}

function modeRank(mode) {
  return MODES.indexOf(mode);
}

function lesserMode(left, right) {
  return modeRank(left) <= modeRank(right) ? left : right;
}

function narrowInteger(effective, key, requested, path, maximum) {
  if (requested === "" || requested === undefined || requested === null) return;
  const value = typeof requested === "number" ? requested : Number(requested);
  assertInteger(value, path, 1, maximum);
  if (value > effective[key]) throw new PolicyError(`${path} exceeds checked-in policy`);
  effective[key] = value;
}
