import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { controlSettings, effectivePolicy, parsePolicy } from "../../.github/cao/src/policy.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const control = join(root, ".github", "cao", "src", "control.mjs");
const schema = JSON.parse(readFileSync(join(root, ".github", "cao", "cao.schema.json"), "utf8"));

function validate(policy) {
  return spawnSync(process.execPath, [control, "validate-policy", "-"], {
    cwd: root,
    encoding: "utf8",
    input: policy,
  });
}

function effective(policy, {
  packageName = "dependabot",
  role = "orchestrator",
  worker = "",
  requestedMode = "",
  targetRepository = "",
} = {}) {
  try {
    return {
      status: 0,
      stderr: "",
      output: effectivePolicy(parsePolicy(policy), {
        packageName,
        role,
        workerName: worker,
        controlRepository: "acme/control",
        requestedMode,
        targetRepository,
      }),
    };
  } catch (error) {
    return { status: 1, stderr: `${error.message}\n`, output: undefined };
  }
}

function effectiveWithLimits(policy, requestedMaxRepositories, requestedRolloutPercent) {
  try {
    return {
      status: 0,
      stderr: "",
      output: effectivePolicy(parsePolicy(policy), {
        packageName: "dependabot",
        role: "orchestrator",
        controlRepository: "acme/control",
        requestedMaxRepositories,
        requestedRolloutPercent,
      }),
    };
  } catch (error) {
    return { status: 1, stderr: `${error.message}\n`, output: undefined };
  }
}

const minimalPolicy = JSON.stringify({
  $schema: schema.$id,
  version: 1,
  "control-plane": {
    scope: { "allowed-repositories": ["acme/payments-api", "acme/storefront"] },
    packages: {
      dependabot: {
        mode: "live",
        "max-repositories": 8,
        workers: {
          "release-train-updater": {
            workflow: "dependabot-release-train-updater",
            "max-mode": "live",
          },
        },
      },
    },
  },
});

test("control policy accepts the minimal version 1 control document", () => {
  const result = validate(minimalPolicy);

  assert.equal(result.status, 0, result.stderr);
});

test("control policy schema accepts config-defined package and worker catalogs", () => {
  const policy = JSON.parse(readFileSync(join(root, ".github", "workflows", "cao.json"), "utf8"));

  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(policy.$schema, schema.$id);
  assert.match(policy["gh-aw-compiler-version"], /^v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/);
  assert.equal(schema.properties["gh-aw-compiler-version"].type, "string");
  assert.equal(schema.$defs.controlPlane.properties.web.$ref, "#/$defs/web");
  assert.equal(policy["control-plane"].web.favicon, "./favicon.svg");
  assert.equal(schema.$defs.controlPackages.additionalProperties.$ref, "#/$defs/packagePolicy");
  assert.equal(schema.$defs.targetPackages.additionalProperties.$ref, "#/$defs/targetPackage");
  for (const packagePolicy of Object.values(policy["control-plane"].packages)) {
    for (const workerPolicy of Object.values(packagePolicy.workers)) {
      assert.match(workerPolicy.workflow, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    }
  }
  assert.equal(validate(JSON.stringify(policy)).status, 0);
});

test("control policy rejects malformed gh-aw compiler versions", () => {
  const policy = JSON.parse(minimalPolicy);
  policy["gh-aw-compiler-version"] = "latest";

  const result = validate(JSON.stringify(policy));

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /gh-aw-compiler-version has an invalid value/);
});

test("checked-in control policy selects seven repositories with live Dependabot and local SelfCare authority", () => {
  const policy = parsePolicy(readFileSync(join(root, ".github", "workflows", "cao.json"), "utf8"));
  const repositories = [
    "github/gh-aw",
    "github/gh-aw-firewall",
    "github/gh-aw-mcpg",
    "github/gh-aw-actions",
    "github/gh-aw-threat-detection",
    "githubnext/gh-aw-cao",
    "githubnext/gh-aw-workshop",
  ];

  assert.deepEqual(policy["control-plane"].scope["allowed-repositories"], repositories);
  assert.equal(policy["control-plane"].defaults["max-repositories"], 7);

  for (const targetRepository of repositories) {
    const effective = effectivePolicy(policy, {
      packageName: "dependabot",
      role: "orchestrator",
      controlRepository: "githubnext/gh-aw-cao",
      targetRepository,
    });
    assert.equal(effective.safe_output_mode, "live");
    assert.equal(effective.max_repositories, 7);
  }

  const selfCare = effectivePolicy(policy, {
    packageName: "self-care",
    role: "orchestrator",
    controlRepository: "githubnext/gh-aw-cao",
    targetRepository: "githubnext/gh-aw-cao",
  });
  assert.equal(selfCare.safe_output_mode, "live");
  assert.equal(selfCare.max_repositories, 1);
  assert.equal(
    policy["control-plane"].packages["self-care"].workers["open-source-failures"].workflow,
    "self-care-open-source-failures",
  );
  assert.equal(
    policy["control-plane"].packages["self-care"].workers["dashboard-performance"].workflow,
    "self-care-dashboard-performance",
  );
  assert.equal(
    policy["control-plane"].packages["self-care"].workers["experimental-views"].workflow,
    "self-care-experimental-views",
  );
  assert.equal(
    policy["control-plane"].packages["self-care"].workers["pages-health"].workflow,
    "self-care-pages-health",
  );
  assert.equal(
    policy["control-plane"].packages["self-care"].workers.glossary.workflow,
    "self-care-glossary",
  );
  assert.equal(
    policy["control-plane"].packages["self-care"].workers["reactive-ui-expert"].workflow,
    "self-care-reactive-ui-expert",
  );
  assert.equal(policy["target-authority"].packages["self-care"].authority, "githubnext/gh-aw-cao");
});

test("control policy applies schema defaults and package values", () => {
  const result = effective(minimalPolicy);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.output.authorized, true);
  assert.equal(result.output.safe_output_mode, "live");
  assert.equal(result.output.max_repositories, 8);
  assert.equal(result.output.rollout_percent, 100);
  assert.equal(result.output.monthly_ai_credit_budget, 0);
  assert.deepEqual(result.output.worker_policies, {
    "dependabot-release-train-updater": {
      worker: "release-train-updater",
      enabled: true,
      max_mode: "live",
    },
  });
  assert.deepEqual(result.output.allowed_owners, ["acme"]);
});

test("control policy exposes scope and publishing defaults to deterministic add-ons", () => {
  assert.deepEqual(controlSettings(parsePolicy(minimalPolicy), "acme/control"), {
    allowed_owners: ["acme"],
    allowed_repositories: ["acme/payments-api", "acme/storefront"],
    web: {
      favicon: "./favicon.svg",
    },
    packages: {
      dependabot: {
        enabled: true,
        mode: "live",
        "max-repositories": 8,
        "rollout-percent": 100,
        "monthly-ai-credit-budget": 0,
        icon: null,
        worker_policies: {
          "dependabot-release-train-updater": {
            worker: "release-train-updater",
            enabled: true,
            max_mode: "live",
          },
        },
      },
    },
    publishing_enabled: false,
    publishing_control_repositories: ["acme/control"],
    publishing_reviewers: [],
  });
});

test("control policy validates and exposes web presentation settings", () => {
  const policy = JSON.parse(minimalPolicy);
  policy["control-plane"].web = {
    favicon: "https://example.com/operations.svg",
  };

  assert.equal(validate(JSON.stringify(policy)).status, 0);
  assert.deepEqual(controlSettings(parsePolicy(JSON.stringify(policy)), "acme/control").web, {
    favicon: "https://example.com/operations.svg",
  });

  for (const favicon of [
    "http://example.com/favicon.svg",
    "https://user@example.com/favicon.svg",
    "https://example.com/favicon.svg?version=1",
    "../favicon.svg",
  ]) {
    policy["control-plane"].web.favicon = favicon;
    const result = validate(JSON.stringify(policy));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /control-plane\.web\.favicon must be an absolute HTTPS URL or \.\/ relative path/);
  }
});

test("control policy validates and exposes a package octicon", () => {
  const policyWithIcon = JSON.stringify({
    $schema: schema.$id,
    version: 1,
    "control-plane": {
      packages: { dependabot: { icon: "dependabot" } },
    },
  });

  const policyWithInvalidIcon = JSON.stringify({
    version: 1,
    "control-plane": {
      packages: { dependabot: { icon: "not-a-real-icon" } },
    },
  });

  assert.equal(validate(policyWithIcon).status, 0, validate(policyWithIcon).stderr);
  const invalidResult = validate(policyWithInvalidIcon);
  assert.notEqual(invalidResult.status, 0);
  assert.match(invalidResult.stderr, /control-plane\.packages\.dependabot\.icon must be one of/);

  assert.equal(
    controlSettings(parsePolicy(policyWithIcon), "acme/control").packages.dependabot.icon,
    "dependabot",
  );
});

test("control policy validates config-defined worker workflow identities", () => {
  const missingWorkflow = JSON.parse(minimalPolicy);
  delete missingWorkflow["control-plane"].packages.dependabot.workers["release-train-updater"].workflow;
  const duplicateWorkflow = JSON.parse(minimalPolicy);
  duplicateWorkflow["control-plane"].packages.dependabot.workers.secondary = {
    workflow: "dependabot-release-train-updater",
  };

  const missingResult = validate(JSON.stringify(missingWorkflow));
  assert.notEqual(missingResult.status, 0);
  assert.match(missingResult.stderr, /workers\.release-train-updater\.workflow has an invalid value/);

  const duplicateResult = validate(JSON.stringify(duplicateWorkflow));
  assert.notEqual(duplicateResult.status, 0);
  assert.match(duplicateResult.stderr, /workers must declare unique workflow identities/);
});

test("control policy disables packages by absence and requires declared workers", () => {
  const absentPackage = effective(minimalPolicy, { packageName: "optimization" });
  const declaredWorker = effective(minimalPolicy, {
    role: "worker",
    worker: "release-train-updater",
    packageName: "dependabot",
  });
  const policyWithoutWorker = JSON.parse(minimalPolicy);
  delete policyWithoutWorker["control-plane"].packages.dependabot.workers;
  const undeclaredWorker = effective(JSON.stringify(policyWithoutWorker), {
    role: "worker",
    worker: "release-train-updater",
  });
  const disabledWorker = effective(minimalPolicy.replace('"max-mode":"live"', '"enabled":false'), {
    role: "worker",
    worker: "release-train-updater",
  });
  const disabledWorkerOrchestrator = effective(
    minimalPolicy.replace('"max-mode":"live"', '"enabled":false'),
  );
  const disabledPackageWithoutWorker = JSON.parse(minimalPolicy);
  disabledPackageWithoutWorker["control-plane"].packages.dependabot = { enabled: false };
  const disabledPackageWorker = effective(JSON.stringify(disabledPackageWithoutWorker), {
    role: "worker",
    worker: "release-train-updater",
  });

  assert.equal(absentPackage.output.reason, "package-undeclared");
  assert.equal(declaredWorker.output.authorized, true);
  assert.notEqual(undeclaredWorker.status, 0);
  assert.match(undeclaredWorker.stderr, /unknown worker: dependabot\/release-train-updater/);
  assert.equal(
    disabledWorkerOrchestrator.output.worker_policies["dependabot-release-train-updater"].enabled,
    false,
  );
  assert.equal(disabledWorker.output.reason, "worker-disabled");
  assert.equal(disabledPackageWorker.output.reason, "package-disabled");
});

test("control policy intersects package mode, dispatch request, and worker ceiling", () => {
  const reviewRequest = effective(minimalPolicy, {
    role: "worker",
    worker: "release-train-updater",
    requestedMode: "review",
  });
  const reviewCeilingPolicy = minimalPolicy.replace('"max-mode":"live"', '"max-mode":"review"');
  const reviewCeiling = effective(reviewCeilingPolicy, {
    role: "worker",
    worker: "release-train-updater",
  });
  const widening = effective(reviewCeilingPolicy, {
    role: "worker",
    worker: "release-train-updater",
    requestedMode: "live",
  });

  assert.equal(reviewRequest.output.safe_output_mode, "review");
  assert.equal(reviewCeiling.output.safe_output_mode, "review");
  assert.notEqual(widening.status, 0);
  assert.match(widening.stderr, /safe_output_mode exceeds checked-in policy/);
});

test("workers inherit the resolved mode when max-mode is omitted", () => {
  const policy = JSON.stringify({
    version: 1,
    "control-plane": {
      scope: { "allowed-repositories": ["acme/payments-api", "acme/storefront"] },
      packages: {
        dependabot: {
          mode: "review",
          targets: { "acme/payments-api": { mode: "live" } },
          workers: {
            "release-train-updater": {
              workflow: "dependabot-release-train-updater",
            },
          },
        },
      },
    },
  });

  const liveWorker = effective(policy, {
    role: "worker",
    worker: "release-train-updater",
    targetRepository: "acme/payments-api",
  });
  const reviewWorker = effective(policy, {
    role: "worker",
    worker: "release-train-updater",
    targetRepository: "acme/storefront",
  });

  assert.equal(liveWorker.status, 0, liveWorker.stderr);
  assert.equal(liveWorker.output.safe_output_mode, "live");
  assert.equal(reviewWorker.status, 0, reviewWorker.stderr);
  assert.equal(reviewWorker.output.safe_output_mode, "review");
});

test("control policy resolves exact package target modes", () => {
  const policy = JSON.stringify({
    $schema: schema.$id,
    version: 1,
    "control-plane": {
      scope: { "allowed-repositories": ["acme/payments-api", "acme/storefront"] },
      packages: {
        dependabot: {
          mode: "review",
          targets: {
            "acme/payments-api": { mode: "live" },
          },
          workers: {
            "release-train-updater": {
              workflow: "dependabot-release-train-updater",
              "max-mode": "live",
            },
          },
        },
      },
    },
  });

  const defaultTarget = effective(policy, { targetRepository: "acme/storefront" });
  const liveTarget = effective(policy, { targetRepository: "ACME/payments-api" });
  const liveWorker = effective(policy, {
    role: "worker",
    worker: "release-train-updater",
    targetRepository: "acme/payments-api",
  });
  const reviewCeilingWorker = effective(policy.replace('"max-mode":"live"', '"max-mode":"review"'), {
    role: "worker",
    worker: "release-train-updater",
    targetRepository: "acme/payments-api",
  });
  const narrowedTarget = effective(policy, {
    targetRepository: "acme/payments-api",
    requestedMode: "review",
  });

  assert.equal(defaultTarget.status, 0, defaultTarget.stderr);
  assert.equal(defaultTarget.output.safe_output_mode, "review");
  assert.equal(liveTarget.status, 0, liveTarget.stderr);
  assert.equal(liveTarget.output.safe_output_mode, "live");
  assert.equal(liveWorker.status, 0, liveWorker.stderr);
  assert.equal(liveWorker.output.safe_output_mode, "live");
  assert.equal(reviewCeilingWorker.status, 0, reviewCeilingWorker.stderr);
  assert.equal(reviewCeilingWorker.output.safe_output_mode, "review");
  assert.deepEqual(liveTarget.output.target_policies, {
    "acme/payments-api": { mode: "live" },
  });
  assert.equal(narrowedTarget.status, 0, narrowedTarget.stderr);
  assert.equal(narrowedTarget.output.safe_output_mode, "review");
  assert.deepEqual(narrowedTarget.output.target_policies, {
    "acme/payments-api": { mode: "review" },
  });
});

test("control policy requires package targets to stay inside explicit scope", () => {
  const policy = JSON.stringify({
    version: 1,
    "control-plane": {
      scope: { "allowed-repositories": ["acme/storefront"] },
      packages: {
        dependabot: {
          targets: {
            "acme/payments-api": { mode: "live" },
          },
        },
      },
    },
  });

  const result = validate(policy);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /package target acme\/payments-api is outside control-plane\.scope\.allowed-repositories/);
});

for (const [name, targets, error] of [
  ["an array", [], /control-plane\.packages\.dependabot\.targets must be a mapping/],
  ["a missing mode", { "acme/payments-api": {} }, /control-plane\.packages\.dependabot\.targets\.acme\/payments-api\.mode is required/],
  ["an unsupported field", { "acme/payments-api": { mode: "live", percentage: 10 } }, /unknown key control-plane\.packages\.dependabot\.targets\.acme\/payments-api\.percentage/],
  ["an invalid mode", { "acme/payments-api": { mode: "preview" } }, /control-plane\.packages\.dependabot\.targets\.acme\/payments-api\.mode must be review or live/],
  ["case-insensitive duplicates", { "acme/payments-api": { mode: "live" }, "ACME/PAYMENTS-API": { mode: "review" } }, /control-plane\.packages\.dependabot\.targets must contain unique repository names/],
]) {
  test(`control policy rejects package targets with ${name}`, () => {
    const result = validate(JSON.stringify({
      version: 1,
      "control-plane": {
        scope: { "allowed-owners": ["acme"] },
        packages: { dependabot: { targets } },
      },
    }));

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, error);
  });
}

test("control policy requires package targets to stay inside allowed owners", () => {
  const result = validate(JSON.stringify({
    version: 1,
    "control-plane": {
      scope: { "allowed-owners": ["acme"] },
      packages: {
        dependabot: { targets: { "outside/payments-api": { mode: "live" } } },
      },
    },
  }));

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /package target outside\/payments-api is outside control-plane\.scope\.allowed-owners/);
});

test("control policy permits dispatch limits to narrow but not widen policy", () => {
  const narrowed = effectiveWithLimits(minimalPolicy, 3, 50);
  const maxWidening = effectiveWithLimits(minimalPolicy, 9, "");
  const rolloutWidening = effectiveWithLimits(minimalPolicy, "", 101);

  assert.equal(narrowed.output.max_repositories, 3);
  assert.equal(narrowed.output.rollout_percent, 50);
  assert.match(maxWidening.stderr, /max_repositories exceeds checked-in policy/);
  assert.match(rolloutWidening.stderr, /rollout_percent must be an integer in 1..100/);
});

test("control policy accepts target-only authority in the version 1 shape", () => {
  const result = validate(JSON.stringify({
    version: 1,
    "target-authority": { packages: { optimization: { authority: "acme/control" } } },
  }));

  assert.equal(result.status, 0, result.stderr);
});

for (const [name, policy, error] of [
  ["legacy root bundles", '{"version":1,"bundles":{}}', /unknown key policy.bundles/],
  ["future versions", '{"version":2,"control-plane":{}}', /version must be an integer in 1..1/],
  ["unknown schema URI", '{"$schema":"https://example.com/policy.schema.json","version":1,"control-plane":{}}', /\$schema must be https:\/\/raw\.githubusercontent\.com/],
  ["unknown nested keys", '{"version":1,"control-plane":{"packages":{"dependabot":{"surprise":true}}}}', /unknown key control-plane.packages.dependabot.surprise/],
  ["duplicate keys", '{"version":1,"version":1,"control-plane":{}}', /duplicate mapping key: version/],
  ["malformed JSON", '{"version":1,}', /invalid policy JSON/],
  ["expressions", '{"version":1,"control-plane":{"scope":{"allowed-owners":["${{ github.repository_owner }}"]}}}', /must not contain a GitHub Actions expression/],
]) {
  test(`control policy rejects ${name}`, () => {
    const result = validate(policy);

    assert.notEqual(result.status, 0, `${name} unexpectedly succeeded`);
    assert.match(result.stderr, error);
  });
}
