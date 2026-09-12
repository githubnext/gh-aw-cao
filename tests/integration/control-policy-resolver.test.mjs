import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const control = join(root, ".github", "workflows", "shared", "control.mjs");
const schemaUri = "https://raw.githubusercontent.com/githubnext/gh-aw-cao/main/.github/workflows/shared/cao.schema.json";

function policy() {
  return {
    $schema: schemaUri,
    version: 1,
    "gh-aw-version": "v0.89.9",
    "control-plane": {
      scope: {
        "allowed-owners": ["acme"],
        "allowed-repositories": ["acme/target"],
      },
      inventory: {
        "max-scan-repositories": 100,
        "cell-count": 2,
        "cell-index": 1,
        "batch-size": 50,
        "batch-index": 0,
      },
      web: {
        favicon: "https://example.com/favicon.svg",
      },
      defaults: {
        mode: "review",
        "max-repositories": 10,
        "rollout-percent": 75,
        "monthly-ai-credit-budget": 1000,
      },
      packages: {
        operations: {
          enabled: true,
          mode: "review",
          "max-repositories": 8,
          "rollout-percent": 50,
          "monthly-ai-credit-budget": 500,
          icon: "code",
          targets: {
            "acme/target": { mode: "live" },
          },
          workers: {
            auditor: {
              workflow: "operations-auditor",
              enabled: true,
              "max-mode": "live",
            },
          },
        },
      },
      publishing: {
        enabled: true,
        "control-repositories": ["acme/control"],
        reviewers: ["octocat"],
      },
    },
    "target-authority": {
      packages: {
        operations: { authority: "acme/control" },
      },
    },
  };
}

test("control.mjs reads the configured gh-aw compiler version", () => {
  const source = policy();
  const directory = mkdtempSync(join(tmpdir(), "cao-policy-"));
  const policyPath = join(directory, "cao.json");
  writeFileSync(policyPath, JSON.stringify(source));

  try {
    const result = run(["compiler-version", policyPath]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "v0.89.9\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function run(args, input = "", environment = {}) {
  return spawnSync(process.execPath, [control, ...args], {
    cwd: root,
    encoding: "utf8",
    input,
    env: {
      ...process.env,
      GITHUB_REPOSITORY: "acme/control",
      CAO_PACKAGE: "operations",
      CAO_ROLE: "orchestrator",
      CAO_WORKER: "",
      CAO_REQUESTED_MODE: "",
      CAO_REQUESTED_MAX_REPOSITORIES: "",
      CAO_REQUESTED_ROLLOUT_PERCENT: "",
      CAO_TARGET_REPOSITORY: "",
      ...environment,
    },
  });
}

function validate(source) {
  return run(["validate-policy", "-"], source);
}

function expectFailure(result, expected) {
  assert.notEqual(result.status, 0, `expected failure, received stdout:\n${result.stdout}`);
  assert.ok(
    result.stderr.includes(expected),
    `expected stderr to include ${JSON.stringify(expected)}, received:\n${result.stderr}`,
  );
}

test("control.mjs always logs policy validation without changing JSON output", () => {
  const source = policy();
  const result = validate(JSON.stringify(source));

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), source);
  assert.equal(result.stderr, [
    "[CAO policy] Parsing control policy.",
    "[CAO policy] Validated control policy.",
    "",
  ].join("\n"));
});

const rawPolicyViolations = [
  ["malformed JSON", '{"version":1,}', "invalid policy JSON"],
  ["non-mapping root", "[]", "policy root must be a mapping"],
  ["duplicate keys", '{"version":1,"version":1,"control-plane":{}}', "duplicate mapping key: version"],
  [
    "GitHub Actions expressions",
    '{"version":1,"control-plane":{"scope":{"allowed-owners":["${{ github.repository_owner }}"]}}}',
    "policy.control-plane.scope.allowed-owners[0] must not contain a GitHub Actions expression",
  ],
];

for (const [name, source, expected] of rawPolicyViolations) {
  test(`control.mjs validate-policy rejects ${name}`, () => {
    expectFailure(validate(source), expected);
  });
}

const policyViolations = [
  ["unknown root properties", (value) => { value.unexpected = true; }, "unknown key policy.unexpected"],
  ["unknown schema URIs", (value) => { value.$schema = "https://example.com/schema.json"; }, "$schema must be"],
  ["missing versions", (value) => { delete value.version; }, "version must be an integer in 1..1"],
  ["unsupported versions", (value) => { value.version = 2; }, "version must be an integer in 1..1"],
  ["documents without a role", (value) => {
    delete value["control-plane"];
    delete value["target-authority"];
  }, "policy requires control-plane or target-authority"],
  ["non-mapping control planes", (value) => { value["control-plane"] = []; }, "control-plane must be a mapping"],
  ["unknown control-plane properties", (value) => {
    value["control-plane"].unexpected = true;
  }, "unknown key control-plane.unexpected"],
  ["non-mapping scopes", (value) => { value["control-plane"].scope = []; }, "control-plane.scope must be a mapping"],
  ["unknown scope properties", (value) => {
    value["control-plane"].scope.unexpected = true;
  }, "unknown key control-plane.scope.unexpected"],
  ["non-array allowed owners", (value) => {
    value["control-plane"].scope["allowed-owners"] = "acme";
  }, "control-plane.scope.allowed-owners must be an array"],
  ["malformed allowed owners", (value) => {
    value["control-plane"].scope["allowed-owners"] = ["not/an-owner"];
  }, "control-plane.scope.allowed-owners has an invalid value"],
  ["duplicate allowed owners", (value) => {
    value["control-plane"].scope["allowed-owners"] = ["acme", "ACME"];
  }, "control-plane.scope.allowed-owners must contain unique values"],
  ["non-array allowed repositories", (value) => {
    value["control-plane"].scope["allowed-repositories"] = "acme/target";
  }, "control-plane.scope.allowed-repositories must be an array"],
  ["malformed allowed repositories", (value) => {
    value["control-plane"].scope["allowed-repositories"] = ["not-a-repository"];
  }, "control-plane.scope.allowed-repositories has an invalid value"],
  ["duplicate allowed repositories", (value) => {
    value["control-plane"].scope["allowed-repositories"] = ["acme/target", "ACME/TARGET"];
  }, "control-plane.scope.allowed-repositories must contain unique values"],
  ["non-mapping inventory", (value) => { value["control-plane"].inventory = []; }, "control-plane.inventory must be a mapping"],
  ["unknown inventory properties", (value) => {
    value["control-plane"].inventory.unexpected = 1;
  }, "unknown key control-plane.inventory.unexpected"],
  ["zero scan limits", (value) => {
    value["control-plane"].inventory["max-scan-repositories"] = 0;
  }, "control-plane.inventory.max-scan-repositories must be an integer in 1..100000"],
  ["oversized scan limits", (value) => {
    value["control-plane"].inventory["max-scan-repositories"] = 100001;
  }, "control-plane.inventory.max-scan-repositories must be an integer in 1..100000"],
  ["zero cell counts", (value) => {
    value["control-plane"].inventory["cell-count"] = 0;
  }, "control-plane.inventory.cell-count must be an integer in 1..1000"],
  ["oversized cell counts", (value) => {
    value["control-plane"].inventory["cell-count"] = 1001;
  }, "control-plane.inventory.cell-count must be an integer in 1..1000"],
  ["negative cell indexes", (value) => {
    value["control-plane"].inventory["cell-index"] = -1;
  }, "control-plane.inventory.cell-index must be an integer in >= 0"],
  ["cell indexes outside the cell count", (value) => {
    value["control-plane"].inventory["cell-index"] = 2;
  }, "control-plane.inventory.cell-index must be smaller than cell-count"],
  ["zero batch sizes", (value) => {
    value["control-plane"].inventory["batch-size"] = 0;
  }, "control-plane.inventory.batch-size must be an integer in 1..100000"],
  ["oversized batch sizes", (value) => {
    value["control-plane"].inventory["batch-size"] = 100001;
  }, "control-plane.inventory.batch-size must be an integer in 1..100000"],
  ["negative batch indexes", (value) => {
    value["control-plane"].inventory["batch-index"] = -1;
  }, "control-plane.inventory.batch-index must be an integer in >= 0"],
  ["non-mapping web settings", (value) => {
    value["control-plane"].web = [];
  }, "control-plane.web must be a mapping"],
  ["unknown web settings", (value) => {
    value["control-plane"].web.unexpected = true;
  }, "unknown key control-plane.web.unexpected"],
  ["insecure favicon URLs", (value) => {
    value["control-plane"].web.favicon = "http://example.com/favicon.svg";
  }, "control-plane.web.favicon must be an absolute HTTPS URL or ./ relative path"],
  ["favicon paths with traversal", (value) => {
    value["control-plane"].web.favicon = "./assets/../favicon.svg";
  }, "control-plane.web.favicon must be an absolute HTTPS URL or ./ relative path"],
  ["non-mapping defaults", (value) => { value["control-plane"].defaults = []; }, "control-plane.defaults must be a mapping"],
  ["unknown default properties", (value) => {
    value["control-plane"].defaults.unexpected = true;
  }, "unknown key control-plane.defaults.unexpected"],
  ["invalid default modes", (value) => {
    value["control-plane"].defaults.mode = "preview";
  }, "control-plane.defaults.mode must be review or live"],
  ["invalid default repository limits", (value) => {
    value["control-plane"].defaults["max-repositories"] = 0;
  }, "control-plane.defaults.max-repositories must be an integer in 1..1000"],
  ["invalid default rollout percentages", (value) => {
    value["control-plane"].defaults["rollout-percent"] = 101;
  }, "control-plane.defaults.rollout-percent must be an integer in 1..100"],
  ["negative default budgets", (value) => {
    value["control-plane"].defaults["monthly-ai-credit-budget"] = -1;
  }, "control-plane.defaults.monthly-ai-credit-budget must be an integer in >= 0"],
  ["non-mapping packages", (value) => { value["control-plane"].packages = []; }, "control-plane.packages must be a mapping"],
  ["malformed package slugs", (value) => {
    value["control-plane"].packages["Not Valid"] = {};
  }, "control-plane.packages.Not Valid has an invalid value"],
  ["non-mapping package policies", (value) => {
    value["control-plane"].packages.operations = [];
  }, "control-plane.packages.operations must be a mapping"],
  ["unknown package properties", (value) => {
    value["control-plane"].packages.operations.unexpected = true;
  }, "unknown key control-plane.packages.operations.unexpected"],
  ["non-boolean package switches", (value) => {
    value["control-plane"].packages.operations.enabled = "true";
  }, "control-plane.packages.operations.enabled must be a Boolean"],
  ["unknown package icons", (value) => {
    value["control-plane"].packages.operations.icon = "invalid";
  }, "control-plane.packages.operations.icon must be one of"],
  ["invalid package modes", (value) => {
    value["control-plane"].packages.operations.mode = "preview";
  }, "control-plane.packages.operations.mode must be review or live"],
  ["invalid package repository limits", (value) => {
    value["control-plane"].packages.operations["max-repositories"] = 1001;
  }, "control-plane.packages.operations.max-repositories must be an integer in 1..1000"],
  ["invalid package rollout percentages", (value) => {
    value["control-plane"].packages.operations["rollout-percent"] = 0;
  }, "control-plane.packages.operations.rollout-percent must be an integer in 1..100"],
  ["negative package budgets", (value) => {
    value["control-plane"].packages.operations["monthly-ai-credit-budget"] = -1;
  }, "control-plane.packages.operations.monthly-ai-credit-budget must be an integer in >= 0"],
  ["non-mapping package targets", (value) => {
    value["control-plane"].packages.operations.targets = [];
  }, "control-plane.packages.operations.targets must be a mapping"],
  ["duplicate package targets", (value) => {
    value["control-plane"].packages.operations.targets = {
      "acme/target": { mode: "live" },
      "ACME/TARGET": { mode: "review" },
    };
  }, "control-plane.packages.operations.targets must contain unique repository names"],
  ["malformed target repository names", (value) => {
    value["control-plane"].packages.operations.targets = { invalid: { mode: "live" } };
  }, "control-plane.packages.operations.targets.invalid has an invalid value"],
  ["non-mapping target policies", (value) => {
    value["control-plane"].packages.operations.targets["acme/target"] = [];
  }, "control-plane.packages.operations.targets.acme/target must be a mapping"],
  ["unknown target properties", (value) => {
    value["control-plane"].packages.operations.targets["acme/target"].unexpected = true;
  }, "unknown key control-plane.packages.operations.targets.acme/target.unexpected"],
  ["target policies without modes", (value) => {
    delete value["control-plane"].packages.operations.targets["acme/target"].mode;
  }, "control-plane.packages.operations.targets.acme/target.mode is required"],
  ["invalid target modes", (value) => {
    value["control-plane"].packages.operations.targets["acme/target"].mode = "preview";
  }, "control-plane.packages.operations.targets.acme/target.mode must be review or live"],
  ["targets outside allowed repositories", (value) => {
    value["control-plane"].packages.operations.targets = { "acme/other": { mode: "live" } };
  }, "package target acme/other is outside control-plane.scope.allowed-repositories"],
  ["targets outside allowed owners", (value) => {
    delete value["control-plane"].scope["allowed-repositories"];
    value["control-plane"].packages.operations.targets = { "outside/target": { mode: "live" } };
  }, "package target outside/target is outside control-plane.scope.allowed-owners"],
  ["non-mapping worker catalogs", (value) => {
    value["control-plane"].packages.operations.workers = [];
  }, "control-plane.packages.operations.workers must be a mapping"],
  ["malformed worker slugs", (value) => {
    value["control-plane"].packages.operations.workers["Not Valid"] = { workflow: "operations-worker" };
  }, "control-plane.packages.operations.workers.Not Valid has an invalid value"],
  ["non-mapping worker policies", (value) => {
    value["control-plane"].packages.operations.workers.auditor = [];
  }, "control-plane.packages.operations.workers.auditor must be a mapping"],
  ["unknown worker properties", (value) => {
    value["control-plane"].packages.operations.workers.auditor.unexpected = true;
  }, "unknown key control-plane.packages.operations.workers.auditor.unexpected"],
  ["workers without workflows", (value) => {
    delete value["control-plane"].packages.operations.workers.auditor.workflow;
  }, "control-plane.packages.operations.workers.auditor.workflow has an invalid value"],
  ["malformed worker workflows", (value) => {
    value["control-plane"].packages.operations.workers.auditor.workflow = "Not Valid";
  }, "control-plane.packages.operations.workers.auditor.workflow has an invalid value"],
  ["duplicate worker workflows", (value) => {
    value["control-plane"].packages.operations.workers.secondary = { workflow: "operations-auditor" };
  }, "control-plane.packages.operations.workers must declare unique workflow identities"],
  ["non-boolean worker switches", (value) => {
    value["control-plane"].packages.operations.workers.auditor.enabled = "true";
  }, "control-plane.packages.operations.workers.auditor.enabled must be a Boolean"],
  ["invalid worker mode ceilings", (value) => {
    value["control-plane"].packages.operations.workers.auditor["max-mode"] = "preview";
  }, "control-plane.packages.operations.workers.auditor.max-mode must be review or live"],
  ["non-mapping publishing policies", (value) => {
    value["control-plane"].publishing = [];
  }, "control-plane.publishing must be a mapping"],
  ["unknown publishing properties", (value) => {
    value["control-plane"].publishing.unexpected = true;
  }, "unknown key control-plane.publishing.unexpected"],
  ["non-boolean publishing switches", (value) => {
    value["control-plane"].publishing.enabled = "true";
  }, "control-plane.publishing.enabled must be a Boolean"],
  ["non-array publishing repositories", (value) => {
    value["control-plane"].publishing["control-repositories"] = "acme/control";
  }, "control-plane.publishing.control-repositories must be an array"],
  ["malformed publishing repositories", (value) => {
    value["control-plane"].publishing["control-repositories"] = ["invalid"];
  }, "control-plane.publishing.control-repositories has an invalid value"],
  ["duplicate publishing repositories", (value) => {
    value["control-plane"].publishing["control-repositories"] = ["acme/control", "ACME/CONTROL"];
  }, "control-plane.publishing.control-repositories must contain unique values"],
  ["non-array publishing reviewers", (value) => {
    value["control-plane"].publishing.reviewers = "octocat";
  }, "control-plane.publishing.reviewers must be an array"],
  ["malformed publishing reviewers", (value) => {
    value["control-plane"].publishing.reviewers = ["-invalid"];
  }, "control-plane.publishing.reviewers has an invalid value"],
  ["duplicate publishing reviewers", (value) => {
    value["control-plane"].publishing.reviewers = ["octocat", "OCTOCAT"];
  }, "control-plane.publishing.reviewers must contain unique values"],
  ["enabled publishing without reviewers", (value) => {
    delete value["control-plane"].publishing.reviewers;
  }, "control-plane.publishing.reviewers is required when publishing is enabled"],
  ["non-mapping target authority", (value) => {
    value["target-authority"] = [];
  }, "target-authority must be a mapping"],
  ["unknown target-authority properties", (value) => {
    value["target-authority"].unexpected = true;
  }, "unknown key target-authority.unexpected"],
  ["target authority without packages", (value) => {
    delete value["target-authority"].packages;
  }, "target-authority.packages must be a mapping"],
  ["non-mapping target-authority packages", (value) => {
    value["target-authority"].packages = [];
  }, "target-authority.packages must be a mapping"],
  ["malformed target-authority package slugs", (value) => {
    value["target-authority"].packages["Not Valid"] = { authority: "acme/control" };
  }, "target-authority.packages.Not Valid has an invalid value"],
  ["non-mapping target package policies", (value) => {
    value["target-authority"].packages.operations = [];
  }, "target-authority.packages.operations must be a mapping"],
  ["unknown target package properties", (value) => {
    value["target-authority"].packages.operations.unexpected = true;
  }, "unknown key target-authority.packages.operations.unexpected"],
  ["target packages without authorities", (value) => {
    delete value["target-authority"].packages.operations.authority;
  }, "target-authority.packages.operations.authority has an invalid value"],
  ["malformed target package authorities", (value) => {
    value["target-authority"].packages.operations.authority = "invalid";
  }, "target-authority.packages.operations.authority has an invalid value"],
];

for (const [name, mutate, expected] of policyViolations) {
  test(`control.mjs validate-policy rejects ${name}`, () => {
    const source = policy();
    mutate(source);
    expectFailure(validate(JSON.stringify(source)), expected);
  });
}

const effectivePolicyViolations = [
  ["unknown roles", { CAO_ROLE: "unknown" }, "role must be orchestrator or worker"],
  ["workers without identities", { CAO_ROLE: "worker" }, "worker identity is required"],
  ["orchestrators with worker identities", { CAO_WORKER: "auditor" }, "worker identity is forbidden for orchestrators"],
  ["undeclared workers", { CAO_ROLE: "worker", CAO_WORKER: "unknown" }, "unknown worker: operations/unknown"],
  ["malformed target repositories", { CAO_TARGET_REPOSITORY: "invalid" }, "target_repo must use owner/repository form"],
  ["invalid requested modes", { CAO_REQUESTED_MODE: "preview" }, "safe_output_mode must be review or live"],
  ["requested mode widening", { CAO_REQUESTED_MODE: "live" }, "safe_output_mode exceeds checked-in policy"],
  ["invalid requested repository limits", { CAO_REQUESTED_MAX_REPOSITORIES: "0" }, "max_repositories must be an integer in 1..1000"],
  ["requested repository-limit widening", { CAO_REQUESTED_MAX_REPOSITORIES: "9" }, "max_repositories exceeds checked-in policy"],
  ["invalid requested rollout percentages", { CAO_REQUESTED_ROLLOUT_PERCENT: "0" }, "rollout_percent must be an integer in 1..100"],
  ["requested rollout widening", { CAO_REQUESTED_ROLLOUT_PERCENT: "51" }, "rollout_percent exceeds checked-in policy"],
];

for (const [name, environment, expected] of effectivePolicyViolations) {
  test(`control.mjs resolve-policy rejects ${name}`, () => {
    expectFailure(run(["resolve-policy", "-"], JSON.stringify(policy()), environment), expected);
  });
}

test("control.mjs control-settings rejects malformed control repository identity", () => {
  expectFailure(
    run(["control-settings", "-"], JSON.stringify(policy()), { GITHUB_REPOSITORY: "invalid" }),
    "GITHUB_REPOSITORY has an invalid value",
  );
});

test("control.mjs control-settings requires a control-plane policy", () => {
  const source = policy();
  delete source["control-plane"];
  expectFailure(run(["control-settings", "-"], JSON.stringify(source)), "control-plane is required");
});

test("control.mjs authority requires a declared package", () => {
  expectFailure(
    run(["authority", "-", "unknown"], JSON.stringify(policy())),
    "target authority does not declare package unknown",
  );
});

test("control.mjs rejects missing policy files", () => {
  expectFailure(run(["validate-policy", join(root, "missing-policy.json")]), "ENOENT");
});

test("control.mjs rejects unsupported command lines", () => {
  expectFailure(run([]), "usage: control.mjs");
});
