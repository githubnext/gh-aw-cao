import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { controlSettings, effectivePolicy, parsePolicy } from "../../.github/workflows/shared/policy.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const control = join(root, ".github", "workflows", "shared", "control.mjs");
const schema = JSON.parse(readFileSync(join(root, ".github", "workflows", "shared", "cao.schema.json"), "utf8"));

function validate(policy) {
  return spawnSync(process.execPath, [control, "validate-policy", "-"], {
    cwd: root,
    encoding: "utf8",
    input: policy,
  });
}

function effective(policy, {
  campaignName = "dependabot",
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
        campaignName,
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
        campaignName: "dependabot",
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
  "gh-aw-version": "v0.89.15",
  "control-plane": {
    scope: { "allowed-repositories": ["acme/payments-api", "acme/storefront"] },
    campaigns: {
      dependabot: {
        mode: "live",
        "max-repositories": 8,
        workers: {
          "update-planner": {
            workflow: "dependabot-update-planner",
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

test("control policy schema accepts config-defined campaign and worker catalogs", () => {
  const policy = JSON.parse(readFileSync(join(root, ".github", "workflows", "cao.json"), "utf8"));

  assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(policy.$schema, schema.$id);
  assert.match(policy["gh-aw-version"], /^v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/);
  assert.equal(schema.properties["gh-aw-version"].type, "string");
  assert.equal(schema.$defs.controlPlane.properties.web.$ref, "#/$defs/web");
  assert.equal(policy["control-plane"].web.experimental, true);
  assert.equal(policy["control-plane"].web.favicon, "./favicon.svg");
  assert.equal(schema.$defs.controlCampaigns.additionalProperties.$ref, "#/$defs/campaignPolicy");
  assert.equal(schema.$defs.targetCampaigns.additionalProperties.$ref, "#/$defs/targetCampaign");
  for (const campaignPolicy of Object.values(policy["control-plane"].campaigns)) {
    for (const workerPolicy of Object.values(campaignPolicy.workers ?? {})) {
      assert.match(workerPolicy.workflow, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    }
  }
  assert.equal(validate(JSON.stringify(policy)).status, 0);
});

test("control policy rejects malformed gh-aw compiler versions", () => {
  const policy = JSON.parse(minimalPolicy);
  policy["gh-aw-version"] = "latest";

  const result = validate(JSON.stringify(policy));

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /gh-aw-version has an invalid value/);
});

test("control policy requires a gh-aw compiler version for control planes", () => {
  const policy = JSON.parse(minimalPolicy);
  delete policy["gh-aw-version"];

  const result = validate(JSON.stringify(policy));

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /gh-aw-version is required for a control plane/);
});

test("checked-in control policy keeps Dependabot scoped with live gh-aw target and local SelfCare authority", () => {
  const policy = parsePolicy(readFileSync(join(root, ".github", "workflows", "cao.json"), "utf8"));
  const repositories = [
    "github/gh-aw",
    "github/gh-aw-firewall",
    "github/gh-aw-mcpg",
    "github/gh-aw-actions",
    "github/gh-aw-threat-detection",
    "githubnext/gh-aw-cao",
  ];

  assert.deepEqual(policy["control-plane"].scope["allowed-repositories"], repositories);
  assert.equal(policy["control-plane"].defaults["max-repositories"], 6);
  assert.equal(policy["control-plane"].campaigns.dashboard.deploy, false);

  const dependabotCampaign = policy["control-plane"].campaigns.dependabot;
  assert.equal(dependabotCampaign.mode, "review");
  assert.equal(dependabotCampaign["max-repositories"], 1);
  assert.equal(dependabotCampaign["rollout-percent"], 100);
  assert.deepEqual(dependabotCampaign.targets, {
    "github/gh-aw": {
      mode: "live",
    },
  });

  const dependabotGhAw = effectivePolicy(policy, {
    campaignName: "dependabot",
    role: "orchestrator",
    controlRepository: "githubnext/gh-aw-cao",
    targetRepository: "github/gh-aw",
  });
  assert.equal(dependabotGhAw.safe_output_mode, "live");
  assert.equal(dependabotGhAw.max_repositories, 1);

  for (const targetRepository of repositories.filter((repository) => repository !== "github/gh-aw")) {
    const effective = effectivePolicy(policy, {
      campaignName: "dependabot",
      role: "orchestrator",
      controlRepository: "githubnext/gh-aw-cao",
      targetRepository,
    });
    assert.equal(effective.safe_output_mode, "review");
    assert.equal(effective.max_repositories, 1);
  }

  const selfCare = effectivePolicy(policy, {
    campaignName: "self-care",
    role: "orchestrator",
    controlRepository: "githubnext/gh-aw-cao",
    targetRepository: "githubnext/gh-aw-cao",
  });
  assert.equal(selfCare.safe_output_mode, "live");
  assert.equal(selfCare.max_repositories, 1);
  assert.equal(
    policy["control-plane"].campaigns["self-care"].workers["open-source-failures"].workflow,
    "self-care-open-source-failures",
  );
  assert.equal(
    policy["control-plane"].campaigns["self-care"].workers["dashboard-performance"].workflow,
    "self-care-dashboard-performance",
  );
  assert.equal(
    policy["control-plane"].campaigns["self-care"].workers["pages-health"].workflow,
    "self-care-pages-health",
  );
  assert.equal(
    policy["control-plane"].campaigns["self-care"].workers.glossary.workflow,
    "self-care-glossary",
  );
  assert.equal(
    policy["control-plane"].campaigns["self-care"].workers["reactive-ui-expert"].workflow,
    "self-care-reactive-ui-expert",
  );
  assert.equal(
    policy["control-plane"].campaigns["self-care"].workers["server-go-logging"].workflow,
    "self-care-server-go-logging",
  );
  assert.equal(policy["target-authority"].campaigns["self-care"].authority, "githubnext/gh-aw-cao");
});

test("control policy applies schema defaults and campaign values", () => {
  const result = effective(minimalPolicy);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.output.authorized, true);
  assert.equal(result.output.safe_output_mode, "live");
  assert.equal(result.output.max_repositories, 8);
  assert.equal(result.output.rollout_percent, 100);
  assert.equal(result.output.monthly_ai_credit_budget, 0);
  assert.deepEqual(result.output.worker_policies, {
    "dependabot-update-planner": {
      worker: "update-planner",
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
      experimental: false,
      favicon: "./favicon.svg",
    },
    campaigns: {
      dependabot: {
        enabled: true,
        mode: "live",
        "max-repositories": 8,
        "rollout-percent": 100,
        "monthly-ai-credit-budget": 0,
        icon: null,
        deploy: true,
        worker_policies: {
          "dependabot-update-planner": {
            worker: "update-planner",
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
    experimental: true,
    favicon: "https://example.com/operations.svg",
  };

  assert.equal(validate(JSON.stringify(policy)).status, 0);
  assert.deepEqual(controlSettings(parsePolicy(JSON.stringify(policy)), "acme/control").web, {
    experimental: true,
    favicon: "https://example.com/operations.svg",
  });

  policy["control-plane"].web.experimental = "true";
  const invalidExperimental = validate(JSON.stringify(policy));
  assert.notEqual(invalidExperimental.status, 0);
  assert.match(invalidExperimental.stderr, /control-plane\.web\.experimental must be a Boolean/);
  policy["control-plane"].web.experimental = true;

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

test("control policy validates and exposes a campaign octicon", () => {
  const policyWithIcon = JSON.stringify({
    $schema: schema.$id,
    version: 1,
    "gh-aw-version": "v0.89.15",
    "control-plane": {
      campaigns: { dependabot: { icon: "dependabot" } },
    },
  });

  const policyWithInvalidIcon = JSON.stringify({
    version: 1,
    "gh-aw-version": "v0.89.15",
    "control-plane": {
      campaigns: { dependabot: { icon: "not-a-real-icon" } },
    },
  });

  assert.equal(validate(policyWithIcon).status, 0, validate(policyWithIcon).stderr);
  const invalidResult = validate(policyWithInvalidIcon);
  assert.notEqual(invalidResult.status, 0);
  assert.match(invalidResult.stderr, /control-plane\.campaigns\.dependabot\.icon must be one of/);

  assert.equal(
    controlSettings(parsePolicy(policyWithIcon), "acme/control").campaigns.dependabot.icon,
    "dependabot",
  );
});

test("control policy validates and exposes campaign deployment settings", () => {
  const policy = JSON.parse(minimalPolicy);
  policy["control-plane"].campaigns.dashboard = { deploy: false };

  assert.equal(validate(JSON.stringify(policy)).status, 0);
  assert.equal(
    controlSettings(parsePolicy(JSON.stringify(policy)), "acme/control").campaigns.dashboard.deploy,
    false,
  );

  policy["control-plane"].campaigns.dashboard.deploy = "false";
  const invalid = validate(JSON.stringify(policy));
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /control-plane\.campaigns\.dashboard\.deploy must be a Boolean/);
});

test("control policy validates config-defined worker workflow identities", () => {
  const missingWorkflow = JSON.parse(minimalPolicy);
  delete missingWorkflow["control-plane"].campaigns.dependabot.workers["update-planner"].workflow;
  const duplicateWorkflow = JSON.parse(minimalPolicy);
  duplicateWorkflow["control-plane"].campaigns.dependabot.workers.secondary = {
    workflow: "dependabot-update-planner",
  };

  const missingResult = validate(JSON.stringify(missingWorkflow));
  assert.notEqual(missingResult.status, 0);
  assert.match(missingResult.stderr, /workers\.update-planner\.workflow has an invalid value/);

  const duplicateResult = validate(JSON.stringify(duplicateWorkflow));
  assert.notEqual(duplicateResult.status, 0);
  assert.match(duplicateResult.stderr, /workers must declare unique workflow identities/);
});

test("control policy registers the dashboard debug logging worker", () => {
  const policy = JSON.parse(readFileSync(join(root, ".github", "workflows", "cao.json"), "utf8"));
  assert.equal(
    policy["control-plane"].campaigns["self-care"].workers["dashboard-debug-logging"].workflow,
    "self-care-dashboard-debug-logging",
  );
});

test("control policy disables campaigns by absence and requires declared workers", () => {
  const absentCampaign = effective(minimalPolicy, { campaignName: "optimization" });
  const declaredWorker = effective(minimalPolicy, {
    role: "worker",
    worker: "update-planner",
    campaignName: "dependabot",
  });
  const policyWithoutWorker = JSON.parse(minimalPolicy);
  delete policyWithoutWorker["control-plane"].campaigns.dependabot.workers;
  const undeclaredWorker = effective(JSON.stringify(policyWithoutWorker), {
    role: "worker",
    worker: "update-planner",
  });
  const disabledWorker = effective(minimalPolicy.replace('"max-mode":"live"', '"enabled":false'), {
    role: "worker",
    worker: "update-planner",
  });
  const disabledWorkerOrchestrator = effective(
    minimalPolicy.replace('"max-mode":"live"', '"enabled":false'),
  );
  const disabledCampaignWithoutWorker = JSON.parse(minimalPolicy);
  disabledCampaignWithoutWorker["control-plane"].campaigns.dependabot = { enabled: false };
  const disabledCampaignWorker = effective(JSON.stringify(disabledCampaignWithoutWorker), {
    role: "worker",
    worker: "update-planner",
  });

  assert.equal(absentCampaign.output.reason, "campaign-undeclared");
  assert.equal(declaredWorker.output.authorized, true);
  assert.notEqual(undeclaredWorker.status, 0);
  assert.match(undeclaredWorker.stderr, /unknown worker: dependabot\/update-planner/);
  assert.equal(
    disabledWorkerOrchestrator.output.worker_policies["dependabot-update-planner"].enabled,
    false,
  );
  assert.equal(disabledWorker.output.reason, "worker-disabled");
  assert.equal(disabledCampaignWorker.output.reason, "campaign-disabled");
});

test("control policy intersects campaign mode, dispatch request, and worker ceiling", () => {
  const reviewRequest = effective(minimalPolicy, {
    role: "worker",
    worker: "update-planner",
    requestedMode: "review",
  });
  const reviewCeilingPolicy = minimalPolicy.replace('"max-mode":"live"', '"max-mode":"review"');
  const reviewCeiling = effective(reviewCeilingPolicy, {
    role: "worker",
    worker: "update-planner",
  });
  const widening = effective(reviewCeilingPolicy, {
    role: "worker",
    worker: "update-planner",
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
    "gh-aw-version": "v0.89.15",
    "control-plane": {
      scope: { "allowed-repositories": ["acme/payments-api", "acme/storefront"] },
      campaigns: {
        dependabot: {
          mode: "review",
          targets: { "acme/payments-api": { mode: "live" } },
          workers: {
            "update-planner": {
              workflow: "dependabot-update-planner",
            },
          },
        },
      },
    },
  });

  const liveWorker = effective(policy, {
    role: "worker",
    worker: "update-planner",
    targetRepository: "acme/payments-api",
  });
  const reviewWorker = effective(policy, {
    role: "worker",
    worker: "update-planner",
    targetRepository: "acme/storefront",
  });

  assert.equal(liveWorker.status, 0, liveWorker.stderr);
  assert.equal(liveWorker.output.safe_output_mode, "live");
  assert.equal(reviewWorker.status, 0, reviewWorker.stderr);
  assert.equal(reviewWorker.output.safe_output_mode, "review");
});

test("control policy resolves exact campaign target modes", () => {
  const policy = JSON.stringify({
    $schema: schema.$id,
    version: 1,
    "gh-aw-version": "v0.89.15",
    "control-plane": {
      scope: { "allowed-repositories": ["acme/payments-api", "acme/storefront"] },
      campaigns: {
        dependabot: {
          mode: "review",
          targets: {
            "acme/payments-api": { mode: "live" },
          },
          workers: {
            "update-planner": {
              workflow: "dependabot-update-planner",
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
    worker: "update-planner",
    targetRepository: "acme/payments-api",
  });
  const reviewCeilingWorker = effective(policy.replace('"max-mode":"live"', '"max-mode":"review"'), {
    role: "worker",
    worker: "update-planner",
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

test("control policy requires campaign targets to stay inside explicit scope", () => {
  const policy = JSON.stringify({
    version: 1,
    "gh-aw-version": "v0.89.15",
    "control-plane": {
      scope: { "allowed-repositories": ["acme/storefront"] },
      campaigns: {
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
  assert.match(result.stderr, /campaign target acme\/payments-api is outside control-plane\.scope\.allowed-repositories/);
});

for (const [name, targets, error] of [
  ["an array", [], /control-plane\.campaigns\.dependabot\.targets must be a mapping/],
  ["a missing mode", { "acme/payments-api": {} }, /control-plane\.campaigns\.dependabot\.targets\.acme\/payments-api\.mode is required/],
  ["an unsupported field", { "acme/payments-api": { mode: "live", percentage: 10 } }, /unknown key control-plane\.campaigns\.dependabot\.targets\.acme\/payments-api\.percentage/],
  ["an invalid mode", { "acme/payments-api": { mode: "preview" } }, /control-plane\.campaigns\.dependabot\.targets\.acme\/payments-api\.mode must be review or live/],
  ["case-insensitive duplicates", { "acme/payments-api": { mode: "live" }, "ACME/PAYMENTS-API": { mode: "review" } }, /control-plane\.campaigns\.dependabot\.targets must contain unique repository names/],
]) {
  test(`control policy rejects campaign targets with ${name}`, () => {
    const result = validate(JSON.stringify({
      version: 1,
      "gh-aw-version": "v0.89.15",
      "control-plane": {
        scope: { "allowed-owners": ["acme"] },
        campaigns: { dependabot: { targets } },
      },
    }));

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, error);
  });
}

test("control policy requires campaign targets to stay inside allowed owners", () => {
  const result = validate(JSON.stringify({
    version: 1,
    "gh-aw-version": "v0.89.15",
    "control-plane": {
      scope: { "allowed-owners": ["acme"] },
      campaigns: {
        dependabot: { targets: { "outside/payments-api": { mode: "live" } } },
      },
    },
  }));

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /campaign target outside\/payments-api is outside control-plane\.scope\.allowed-owners/);
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
    "target-authority": { campaigns: { optimization: { authority: "acme/control" } } },
  }));

  assert.equal(result.status, 0, result.stderr);
});

for (const [name, policy, error] of [
  ["legacy root bundles", '{"version":1,"bundles":{}}', /unknown key policy.bundles/],
  ["future versions", '{"version":2,"control-plane":{}}', /version must be an integer in 1..1/],
  ["unknown schema URI", '{"$schema":"https://example.com/policy.schema.json","version":1,"control-plane":{}}', /\$schema must be https:\/\/raw\.githubusercontent\.com/],
  ["unknown nested keys", '{"version":1,"gh-aw-version":"v0.89.15","control-plane":{"campaigns":{"dependabot":{"surprise":true}}}}', /unknown key control-plane.campaigns.dependabot.surprise/],
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
